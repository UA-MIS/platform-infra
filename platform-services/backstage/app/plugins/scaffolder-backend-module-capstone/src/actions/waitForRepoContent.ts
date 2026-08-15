/*
 * capstone:wait-for-repo-content — FIX-19 (P1, CATALOG-001): closes the catalog:register
 * 400 race between `publish` (repo create + first push) and `register` (catalog:register
 * reading catalog-info.yaml from that same push).
 *
 * ROOT CAUSE (found by execution, not guessed): `new-project/template.yaml`'s `register`
 * step is Backstage's BUILT-IN `catalog:register` action, called IMMEDIATELY after
 * `publish:github` returns. `catalog:register` POSTs to the catalog-backend's
 * `/locations` endpoint, which performs a SYNCHRONOUS first read of the target
 * catalog-info.yaml (via the GitHub integration reader) before it will accept the
 * Location — that immediate read is what surfaced the 400s (repos.getContent 404s
 * against the just-pushed commit; verified against the FINAL report's own data: 3/3
 * scaffolds this session hit the identical failure, and the identical URL registered
 * fine as a raw retry MINUTES later — a content-propagation race, not a config or
 * catalog-info.yaml defect, and not a GitHub App auth issue, both of which would fail
 * every time rather than intermittently-then-succeed on retry). GitHub's own API/raw-
 * content edge has real (if usually sub-second) eventual-consistency lag after a
 * repo's first push + branch-protection setup; `catalog:register`'s synchronous read
 * gives that lag zero room to resolve.
 *
 * FIX: poll the SAME repo (via the platform's own GitHub App credentials, read-only)
 * for the SAME file, AT THE EXACT COMMIT `publish:github` just created
 * (`steps['publish'].output.commitHash` — not the branch tip, which could itself still
 * be propagating), with exponential backoff, BEFORE `register` ever runs. Once this
 * step's own read succeeds, the content is provably visible through GitHub's read path
 * for that commit, so `catalog:register`'s own (separate, but same-repo, same-file)
 * read has a real chance of no longer racing it. `catalog:register` itself is
 * UNCHANGED — this fixes the ordering/timing, not the built-in action, so its
 * `output.entityRef` (referenced by template.yaml's own output links) stays intact.
 *
 * A 404 (NotFoundError) is the ONLY retryable signal — the specific shape of "not yet
 * propagated". Any other error (auth failure, rate limit, a genuinely missing/renamed
 * file after retries exhausted) is fail-fast, not swallowed into a generic retry loop
 * that could paper over a real defect.
 */
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import type { Config } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
  type GithubCredentialsProvider,
} from '@backstage/integration';
import { Octokit } from '@octokit/rest';
import { DEFAULT_OWNER } from './preflight';

/** The minimal Octokit surface this action uses — mirrors preflight's OctokitLike. */
export interface OctokitLike {
  rest: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{ data: unknown }>;
    };
  };
}

/** Factory for an authenticated Octokit — injectable so tests skip the real GitHub App. */
export type OctokitFactory = (opts: {
  auth: string;
  baseUrl?: string;
}) => OctokitLike;

/** true if an Octokit error is a 404 — the ONLY retryable shape (see file header). */
export function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 404;
}

/**
 * Poll `octokit.repos.getContent` for `path` at `ref` until it succeeds, a non-404
 * error occurs (rethrown immediately), or `maxAttempts` is exhausted (throws a clear,
 * actionable error naming the repo/path/ref/attempts — never silently gives up).
 * Exponential backoff, capped at `maxDelayMs`. `sleep` is injectable so tests run
 * instantly instead of waiting on real timers.
 */
export async function waitForContent(
  octokit: OctokitLike,
  params: { owner: string; repo: string; path: string; ref: string },
  opts: {
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    sleep: (ms: number) => Promise<void>;
    onAttempt?: (attempt: number, delayMs: number) => void;
  },
): Promise<{ attempts: number }> {
  let delay = opts.initialDelayMs;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      await octokit.rest.repos.getContent(params);
      return { attempts: attempt };
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
      if (attempt === opts.maxAttempts) {
        throw new Error(
          `capstone:wait-for-repo-content: ${params.owner}/${params.repo}${params.path} ` +
            `at ${params.ref} was still not readable via the GitHub API after ` +
            `${opts.maxAttempts} attempts — GitHub has not propagated the just-pushed ` +
            'commit within the retry budget. This is the FIX-19/CATALOG-001 race; if it ' +
            'recurs, the retry budget below may need widening, not a workaround.',
        );
      }
      opts.onAttempt?.(attempt, delay);
      await opts.sleep(delay);
      delay = Math.min(delay * 2, opts.maxDelayMs);
    }
  }
  // Unreachable (the loop always returns or throws), but keeps TypeScript's control-flow
  // analysis happy without an explicit non-null assertion at the call site.
  throw new Error('capstone:wait-for-repo-content: unreachable');
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface WaitForRepoContentActionDeps {
  config: Config;
  /** Override the GitHub credentials provider (tests). Defaults to the App/token provider. */
  githubCredentialsProvider?: GithubCredentialsProvider;
  /** Injectable Octokit factory (tests). Defaults to a real @octokit/rest client. */
  octokitFactory?: OctokitFactory;
  /** Injectable delay function (tests) — defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/**
 * Factory for the `capstone:wait-for-repo-content` action. Takes its deps so the
 * module wires config in at registration, keeping the handler unit-testable with mocks.
 */
export function createWaitForRepoContentAction(deps: WaitForRepoContentActionDeps) {
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
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  return createTemplateAction({
    id: 'capstone:wait-for-repo-content',
    description:
      'Poll a just-pushed GitHub repo for a file at a specific commit until GitHub ' +
      'actually serves it, with exponential backoff. Closes the catalog:register 400 ' +
      "race (FIX-19/CATALOG-001): publish:github can return before GitHub's read path " +
      'has propagated the first commit, so an immediate catalog:register 400s. Read-only.',
    schema: {
      input: {
        repo: z =>
          z.string({ description: 'Repo name (e.g. the scaffolded appName).' }),
        catalogInfoPath: z =>
          z
            .string({
              description: "Repo-relative file path to wait for. Defaults to 'catalog-info.yaml'.",
            })
            .optional(),
        commitHash: z =>
          z.string({
            description:
              "The commit to check content AT — pass publish:github's own " +
              'output.commitHash, not the branch tip, so this waits for the EXACT ' +
              'push register will read, not a possibly-still-propagating later commit.',
          }),
        owner: z =>
          z
            .string({
              description: `GitHub org that owns the repo. Defaults to '${DEFAULT_OWNER}'.`,
            })
            .optional(),
        maxAttempts: z =>
          z
            .number({ description: `Retry budget. Defaults to ${DEFAULT_MAX_ATTEMPTS}.` })
            .optional(),
        initialDelayMs: z =>
          z
            .number({
              description: `First retry delay in ms. Defaults to ${DEFAULT_INITIAL_DELAY_MS}.`,
            })
            .optional(),
        maxDelayMs: z =>
          z
            .number({
              description: `Backoff cap in ms. Defaults to ${DEFAULT_MAX_DELAY_MS}.`,
            })
            .optional(),
      },
      output: {
        attempts: z =>
          z.number({ description: 'How many GitHub reads it took before the content was visible.' }),
      },
    },

    async handler(ctx) {
      const owner = ctx.input.owner ?? DEFAULT_OWNER;
      const repo = ctx.input.repo;
      const path = (ctx.input.catalogInfoPath ?? 'catalog-info.yaml').replace(/^\/+/, '');
      const ref = ctx.input.commitHash;
      const maxAttempts = ctx.input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      const initialDelayMs = ctx.input.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
      const maxDelayMs = ctx.input.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

      const { token } = await credentialsProvider.getCredentials({
        url: `https://github.com/${owner}`,
      });
      if (!token) {
        throw new Error(
          'capstone:wait-for-repo-content: no GitHub credentials for github.com — is ' +
            'integrations.github configured with the platform App?',
        );
      }
      const apiBaseUrl = integrations.github.byHost('github.com')?.config.apiBaseUrl;
      const octokit = octokitFactory({ auth: token, baseUrl: apiBaseUrl });

      const { attempts } = await waitForContent(
        octokit,
        { owner, repo, path, ref },
        {
          maxAttempts,
          initialDelayMs,
          maxDelayMs,
          sleep,
          onAttempt: (attempt, delayMs) =>
            ctx.logger.info(
              `capstone:wait-for-repo-content: ${owner}/${repo}/${path}@${ref} not yet ` +
                `readable (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`,
            ),
        },
      );

      ctx.logger.info(
        `capstone:wait-for-repo-content: ${owner}/${repo}/${path}@${ref} confirmed ` +
          `readable after ${attempts} attempt(s).`,
      );
      ctx.output('attempts', attempts);
    },
  });
}
