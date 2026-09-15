/*
 * capstone:ensure-argocd-webhook — idempotently create the ArgoCD Git webhook on a
 * freshly-published tenant repo, so ArgoCD refreshes that repo's Applications on push
 * instead of waiting on the default ~3-minute reconciliation poll.
 *
 * WHY THIS ACTION EXISTS:
 * ArgoCD (argocd-server) already accepts GitHub webhook deliveries at
 * `POST https://argocd.capstone.uamishub.com/api/webhook`, validated with an HMAC secret
 * read from `argocd-secret`'s `webhook.github.secret` key (platform-services/argocd-config/
 * sealedsecret-webhook.yaml). But NOTHING on the tenant-repo side ever POSTed that webhook
 * into existence — every tenant repo was sending zero deliveries, so every deploy/promote
 * sat on the default poll interval (up to ~3 minutes before ArgoCD noticed a new commit).
 * A one-time manual backfill added the webhook to the 10 existing tenant repos, but that
 * does nothing for the NEXT tenant. This action closes the gap at the source: it runs as
 * part of the SAME scaffold flow that creates the repo (`publish:github`, one step earlier
 * in new-capstone-project-zerotouch/template.yaml), so a new tenant is wired for instant
 * sync from its very first commit — no separate reconciler, no second source of truth.
 *
 * WHY NOT THE CROSSPLANE COMPOSITION (the other candidate insertion point): provider-github
 * IS installed (platform-services/crossplane/providers/provider-github.yaml, ADR-031), but
 * the Composition's GitHub section is DELIBERATELY EMPTY — ADR-035 §D2 (human-approved)
 * removed every GitHub-touching MR (Repository/BranchProtection/TeamRepository/
 * RepositoryFile) specifically because the scaffolder owns the code repo END-TO-END and a
 * second GitHub-managing surface in the Composition caused a real repo-ownership collision
 * (the auto-committed claim clobbering the student's fragment code) and required org-admin
 * repo-create on a low-trust, auto-committed XR. Adding a webhook MR back into the
 * Composition would reopen exactly that: a second thing claiming to own part of the repo's
 * GitHub-side config. See apis/composition.yaml's "GITHUB — DELIBERATELY EMPTY" block.
 *
 * WHY NOT A STANDALONE RECONCILER JOB: a periodic reconciler that lists tenant repos and
 * ensures each has the webhook is a workable self-healing fallback, but it is a SECOND
 * source of truth for "does this repo have its ArgoCD webhook" — it would need its own
 * schedule, its own credentials, its own drift-detection, and could race a fresh scaffold.
 * Creating the webhook in the same step that creates the repo means there is exactly one
 * thing that ever decides a tenant repo's GitHub-side config, matching the scaffolder's
 * existing ownership of branch protection + collaborators (the `publish` step, one step
 * before this one, in the same template).
 *
 * IDEMPOTENCY: GitHub's webhook-create API is NOT idempotent on its own — POSTing the same
 * config twice creates TWO webhooks, and ArgoCD then receives (and processes) two identical
 * deliveries per push. This action GUARDS that: it lists the repo's existing webhooks first
 * and skips creation if one already targets the configured URL. Safe to re-run (a scaffold
 * retry, or a manual re-invocation) without ever duplicating the hook.
 *
 * FAILURE MODE THAT MOTIVATES THE SECRET HANDLING: ArgoCD validates every delivery's HMAC
 * signature against `argocd-secret`'s `webhook.github.secret`. If the value configured here
 * ever drifts from that live secret (e.g. `argocd-secret` is rotated/resealed and this
 * action's `capstone.argocd.webhookSecret` is not updated to match), GitHub keeps delivering
 * successfully (200 from the webhook endpoint receiving the POST), ArgoCD keeps REJECTING
 * the signature and silently falls back to the poll — and NOTHING anywhere logs an error a
 * human would see. Both sides look healthy. See platform-services/backstage/README.md and
 * docs/operator/argocd-gitops.md for the explicit rotation note.
 *
 * AUTH: identical model to publish:github / capstone:commit-to-main — NO token input. The
 * GitHub App installation token is resolved from `integrations.github` via
 * DefaultGithubCredentialsProvider, scoped to the target repo. The webhook HMAC secret comes
 * from backend config (`capstone.argocd.webhookSecret`, sourced from the SAME
 * `backstage-process-secrets` env-var convention as the Harbor provisioner creds). Neither
 * value is ever logged — only the repo, the webhook URL, and hook IDs/HTTP statuses are.
 *
 * ⚠ BACKEND ACTION → compiled into the Backstage image. Registering/using it needs an image
 * REBUILD + redeploy, like every action in this module.
 */
import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
  type GithubCredentialsProvider,
} from '@backstage/integration';
import { createTemplateAction, parseRepoUrl } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';

/**
 * The minimal Octokit surface this action uses. Declaring it as an interface (rather than
 * depending on the full Octokit type) keeps the core logic unit-testable with a hand-rolled
 * mock, exactly like commitToMain's OctokitLike.
 */
export interface OctokitLike {
  rest: {
    repos: {
      listWebhooks(params: { owner: string; repo: string }): Promise<{
        data: Array<{ id: number; active: boolean; config: { url?: string } }>;
      }>;
      createWebhook(params: {
        owner: string;
        repo: string;
        config: {
          url: string;
          content_type: string;
          secret: string;
          insecure_ssl: string;
        };
        events: string[];
        active: boolean;
      }): Promise<{ data: { id: number } }>;
    };
  };
}

/** Factory for an authenticated Octokit — injectable so tests skip the real GitHub App. */
export type OctokitFactory = (opts: { auth: string; baseUrl?: string }) => OctokitLike;

/** Resolved, validated ArgoCD webhook config. */
export interface ArgocdWebhookConfig {
  /** ArgoCD's webhook receiver URL (e.g. https://argocd.capstone.uamishub.com/api/webhook). */
  webhookUrl: string;
  /** The SAME shared HMAC secret sealed into argocd-secret's `webhook.github.secret` key. */
  webhookSecret: string;
}

/**
 * Read + validate `capstone.argocd.*` from backend config. Both values are REQUIRED — the
 * action fails closed rather than creating a webhook GitHub will happily deliver to but
 * whose signature ArgoCD cannot verify (the worst failure mode here: it looks wired, but
 * every delivery is silently rejected and syncs quietly revert to polling — see this file's
 * header). No insecure/no-secret default.
 */
export function readArgocdWebhookConfig(config: Config): ArgocdWebhookConfig {
  const c = config.getOptionalConfig('capstone.argocd');
  if (!c) {
    throw new Error(
      'capstone:ensure-argocd-webhook: missing config section `capstone.argocd` ' +
        '(need webhookUrl + webhookSecret).',
    );
  }
  const webhookUrl = c.getOptionalString('webhookUrl');
  const webhookSecret = c.getOptionalString('webhookSecret');
  if (!webhookUrl || !webhookSecret) {
    throw new Error(
      'capstone:ensure-argocd-webhook: `capstone.argocd.webhookUrl` and ' +
        '`capstone.argocd.webhookSecret` are required. Refusing to create a webhook ' +
        'without the shared HMAC secret argocd-secret expects — an unsigned/mis-signed ' +
        'webhook is silently rejected by ArgoCD with no visible error.',
    );
  }
  return { webhookUrl, webhookSecret };
}

/**
 * Idempotently ensure the repo has a GitHub webhook pointed at ArgoCD's receiver. Pure
 * (takes its Octokit + config + logger) so it's unit-testable without a live GitHub.
 *
 * Idempotency contract: GitHub's create-webhook API is NOT idempotent (no 409 on a
 * duplicate config — see the file header), so this action does its own GET-then-create:
 * list the repo's existing webhooks, and skip creation if one already targets the
 * configured URL. A hook found this way is treated as already-correct; this action does
 * not attempt to read back or diff the existing hook's secret (GitHub never returns it).
 */
export async function ensureArgocdWebhook(args: {
  octokit: OctokitLike;
  cfg: ArgocdWebhookConfig;
  owner: string;
  repo: string;
  logger: LoggerService;
}): Promise<{ created: boolean; hookId?: number }> {
  const { octokit, cfg, owner, repo, logger } = args;

  logger.info(
    `capstone:ensure-argocd-webhook: checking ${owner}/${repo} for an existing hook -> ${cfg.webhookUrl}`,
  );
  const existing = await octokit.rest.repos.listWebhooks({ owner, repo });
  const match = existing.data.find(h => h.config.url === cfg.webhookUrl);
  if (match) {
    logger.info(
      `capstone:ensure-argocd-webhook: ${owner}/${repo} already has a hook (id ${match.id}) ` +
        'targeting the ArgoCD receiver — idempotent no-op.',
    );
    return { created: false, hookId: match.id };
  }

  logger.info(`capstone:ensure-argocd-webhook: creating hook on ${owner}/${repo}.`);
  const res = await octokit.rest.repos.createWebhook({
    owner,
    repo,
    config: {
      url: cfg.webhookUrl,
      content_type: 'json',
      secret: cfg.webhookSecret,
      insecure_ssl: '0',
    },
    events: ['push'],
    active: true,
  });
  logger.info(
    `capstone:ensure-argocd-webhook: created hook (id ${res.data.id}) on ${owner}/${repo}.`,
  );
  return { created: true, hookId: res.data.id };
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface EnsureArgocdWebhookActionDeps {
  config: Config;
  /** Override the GitHub credentials provider (tests). Defaults to the App/token provider
   * built from integrations.github — the SAME auth publish:github/commit-to-main use. */
  githubCredentialsProvider?: GithubCredentialsProvider;
  /** Injectable Octokit factory — defaults to a real @octokit/rest client. */
  octokitFactory?: OctokitFactory;
}

/**
 * Factory for the `capstone:ensure-argocd-webhook` action. Takes its deps so the module
 * wires config in at registration, keeping the action unit-testable with a mock Octokit.
 */
export function createEnsureArgocdWebhookAction(deps: EnsureArgocdWebhookActionDeps) {
  const { config } = deps;
  const integrations = ScmIntegrations.fromConfig(config);
  const credentialsProvider =
    deps.githubCredentialsProvider ??
    DefaultGithubCredentialsProvider.fromIntegrations(integrations);
  const octokitFactory: OctokitFactory =
    deps.octokitFactory ??
    (opts =>
      new Octokit({
        auth: opts.auth,
        baseUrl: opts.baseUrl,
        userAgent: 'capstone-scaffolder',
      }) as unknown as OctokitLike);

  return createTemplateAction({
    id: 'capstone:ensure-argocd-webhook',
    description:
      'Idempotently create the ArgoCD Git webhook on a freshly-published tenant repo, so ' +
      "ArgoCD refreshes on push instead of the default ~3-minute poll. Skips creation if " +
      'the repo already has a hook targeting the configured URL. Authenticates via ' +
      'integrations.github like publish:github (no token input); the webhook HMAC secret ' +
      'comes from backend config (capstone.argocd.webhookSecret), never from template input.',
    schema: {
      input: {
        repoUrl: z =>
          z.string({
            description:
              'Backstage repo URL (e.g. github.com?owner=UA-MIS&repo=<appName>). ' +
              'Owner + repo are parsed from it; auth comes from integrations.github.',
          }),
      },
      output: {
        created: z =>
          z.boolean({
            description: 'true if a new webhook was created, false if one already existed.',
          }),
        hookId: z =>
          z.number({ description: 'The GitHub webhook id (new or pre-existing).' }).optional(),
      },
    },

    async handler(ctx) {
      const cfg = readArgocdWebhookConfig(config);

      const { repoUrl } = ctx.input;
      const { host, owner, repo } = parseRepoUrl(repoUrl, integrations);
      if (!owner) {
        throw new Error(
          `capstone:ensure-argocd-webhook: repoUrl '${repoUrl}' is missing an owner.`,
        );
      }
      const { token } = await credentialsProvider.getCredentials({
        url: `https://${host}/${owner}/${repo}`,
      });
      if (!token) {
        throw new Error(
          `capstone:ensure-argocd-webhook: no GitHub credentials for ${host} — is ` +
            'integrations.github configured with the platform App?',
        );
      }
      const apiBaseUrl = integrations.github.byHost(host)?.config.apiBaseUrl;
      const octokit = octokitFactory({ auth: token, baseUrl: apiBaseUrl });

      const { created, hookId } = await ensureArgocdWebhook({
        octokit,
        cfg,
        owner,
        repo,
        logger: ctx.logger,
      });

      ctx.output('created', created);
      if (hookId !== undefined) ctx.output('hookId', hookId);
    },
  });
}
