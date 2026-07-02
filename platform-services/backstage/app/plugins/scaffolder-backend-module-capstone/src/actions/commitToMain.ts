/*
 * capstone:commit-to-main — commit a SINGLE file DIRECTLY to a branch (default `main`)
 * of a GitHub repo via the platform GitHub App, with NO pull request.
 *
 * WHY THIS ACTION EXISTS (ADR-031 §7 Option A(b) — the "no-PR direct commit"):
 * The zero-touch onboarding template emits ONE CapstoneTenant XR and must land it on
 * platform-infra `main` so ArgoCD (platform-crossplane-claims) syncs it and Crossplane
 * reconciles the whole tenant. TRUE zero-touch means NO human merge. The stock
 * `publish:github:pull-request` step opens a claim PR that still needs a 1-click merge,
 * and the installed `@backstage/plugin-scaffolder-backend-module-github@0.9.10` has NO
 * autoMerge input and NO `github:pull-request:merge` action (Context7-verified). So the
 * clean realization is this custom action: it PUTs the claim file straight onto `main`
 * (the platform GitHub App is on the branch-protection bypass list for tenants/_claims/**
 * — ADR-031 §7 Option A). No branch, no PR, no merge.
 *
 * AUTH: identical model to `publish:github` — NO token input. The GitHub App installation
 * token is resolved from `integrations.github` (the same UA-MIS App used by catalog
 * ingestion + capstone:render-tenant) via DefaultGithubCredentialsProvider. The token is
 * only ever passed to Octokit's Authorization header; it is NEVER logged.
 *
 * BLAST RADIUS (this commits to `main` with App creds and NO review): the path is
 * validated to be a clean, repo-relative file path (no absolute paths, no `..` traversal)
 * so a caller can never escape the intended subtree. The zero-touch template only ever
 * points it at tenants/_claims/<team>-<app>.yaml, and the XR content itself is re-validated
 * (reserved names, slug patterns) by capstone:emit-tenant-claim + the XRD at admission.
 *
 * ⚠ BACKEND ACTION → compiled into the Backstage image. Registering/using it needs an
 * image REBUILD + redeploy (like every action in this module). See CROSSPLANE-CUTOVER.md.
 */
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  DefaultGithubCredentialsProvider,
  ScmIntegrations,
  type GithubCredentialsProvider,
} from '@backstage/integration';
import { createTemplateAction, parseRepoUrl } from '@backstage/plugin-scaffolder-node';
import { Octokit } from '@octokit/rest';
import fs from 'fs-extra';
import path from 'path';

/**
 * The minimal Octokit surface this action uses — just the two `repos` calls needed to
 * read a file's blob SHA and PUT its new contents. Declaring it as an interface (rather
 * than depending on the full Octokit type) keeps the core commit logic unit-testable with
 * a hand-rolled mock, exactly like harborOnboard's FetchLike.
 */
export interface OctokitLike {
  rest: {
    repos: {
      getContent(params: {
        owner: string;
        repo: string;
        path: string;
        ref?: string;
      }): Promise<{ data: unknown }>;
      createOrUpdateFileContents(params: {
        owner: string;
        repo: string;
        path: string;
        message: string;
        content: string;
        branch: string;
        sha?: string;
      }): Promise<{
        data: {
          commit?: { sha?: string; html_url?: string };
          content?: { html_url?: string } | null;
        };
      }>;
    };
  };
}

/** Factory for an authenticated Octokit — injectable so tests skip the real GitHub App. */
export type OctokitFactory = (opts: {
  auth: string;
  baseUrl?: string;
}) => OctokitLike;

/** true if an Octokit error is a 404 (file does not exist yet → this is a create, not update). */
function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | undefined)?.status === 404;
}

/**
 * Reject anything that is not a clean, repo-relative file path. Committing to `main` with
 * App creds and no review means the destination path is security-relevant: an absolute path
 * or a `..` segment could target a file outside the intended subtree. Fails closed.
 */
function assertSafeRepoPath(p: string): void {
  if (!p || p.trim() === '') {
    throw new Error('capstone:commit-to-main: `path` is required and must be non-empty.');
  }
  if (path.isAbsolute(p) || p.startsWith('/')) {
    throw new Error(
      `capstone:commit-to-main: path must be repo-relative, got absolute '${p}'.`,
    );
  }
  const normalized = path.posix.normalize(p);
  if (
    normalized.startsWith('..') ||
    normalized.split('/').some(seg => seg === '..')
  ) {
    throw new Error(
      `capstone:commit-to-main: path must not contain '..' traversal, got '${p}'.`,
    );
  }
}

/**
 * Idempotently commit `content` to `path` on `branch` of a repo. Pure (takes its Octokit +
 * logger) so it's unit-testable without a live GitHub. GitHub's contents API is
 * create-or-update: a file that already exists must carry its current blob SHA, a new file
 * must omit it. We GET first to discover that SHA (404 → new file), then PUT. Returns the
 * commit SHA + html_url and whether the file was newly created for the action output.
 */
export async function commitFileToBranch(args: {
  octokit: OctokitLike;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
  logger: LoggerService;
}): Promise<{ commitSha?: string; commitUrl?: string; created: boolean }> {
  const { octokit, owner, repo, branch, path: repoPath, content, message, logger } = args;

  // 1) Resolve the existing blob SHA (required for an update). A 404 means the file does
  //    not exist yet → this is a create (omit sha). Any other error is real → rethrow.
  let sha: string | undefined;
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: repoPath,
      ref: branch,
    });
    const data = res.data;
    if (Array.isArray(data)) {
      throw new Error(
        `capstone:commit-to-main: '${repoPath}' is a directory, not a file — refusing to commit.`,
      );
    }
    sha = (data as { sha?: string }).sha;
  } catch (err) {
    if (!isNotFound(err)) {
      throw err;
    }
    logger.info(
      `capstone:commit-to-main: ${repoPath} not present on ${branch} — creating new file.`,
    );
  }

  // 2) PUT the file. content MUST be base64 (GitHub contents API contract).
  logger.info(
    `capstone:commit-to-main: committing ${owner}/${repo}:${repoPath} to ${branch} ` +
      `(${sha ? 'update' : 'create'}).`,
  );
  const res = await octokit.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: repoPath,
    branch,
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  });

  const commitSha = res.data.commit?.sha;
  const commitUrl = res.data.commit?.html_url;
  logger.info(
    `capstone:commit-to-main: committed ${repoPath} to ${branch}` +
      (commitSha ? ` (${commitSha}).` : '.'),
  );
  return { commitSha, commitUrl, created: !sha };
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface CommitToMainActionDeps {
  config: Config;
  /**
   * Override the GitHub credentials provider (tests). Defaults to the App/token provider
   * built from integrations.github — the SAME auth publish:github uses (no token input).
   */
  githubCredentialsProvider?: GithubCredentialsProvider;
  /**
   * Injectable Octokit factory — defaults to a real @octokit/rest client. Tests pass a
   * mock to assert the PUT to main without a live GitHub App.
   */
  octokitFactory?: OctokitFactory;
}

/**
 * Factory for the `capstone:commit-to-main` action. Takes its deps so the module wires
 * config in at registration (createBackendModule registerInit), keeping the action
 * unit-testable with a mock Octokit + mock credentials provider.
 */
export function createCommitToMainAction(deps: CommitToMainActionDeps) {
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
    id: 'capstone:commit-to-main',
    description:
      'Commit a single file directly to a branch (default main) of a GitHub repo via the ' +
      'platform GitHub App, with NO pull request (ADR-031 zero-touch: land the tenant ' +
      'claim on platform-infra main so Crossplane reconciles it — no human merge). ' +
      'Authenticates via integrations.github like publish:github (no token input).',
    schema: {
      input: {
        repoUrl: z =>
          z.string({
            description:
              'Backstage repo URL (e.g. github.com?owner=UA-MIS&repo=platform-infra). ' +
              'Owner + repo are parsed from it; auth comes from integrations.github.',
          }),
        path: z =>
          z.string({
            description:
              'Repo-relative destination path for the file (e.g. ' +
              'tenants/_claims/<team>-<app>.yaml). No absolute paths, no `..` traversal.',
          }),
        content: z =>
          z
            .string({
              description:
                'Inline file content to commit. Provide EITHER content OR sourcePath.',
            })
            .optional(),
        sourcePath: z =>
          z
            .string({
              description:
                'Workspace-relative path of a file to read the content from (the composition ' +
                'path — e.g. the file capstone:emit-tenant-claim wrote). Alternative to content.',
            })
            .optional(),
        branch: z =>
          z
            .string({ description: 'Target branch. Defaults to "main".' })
            .optional(),
        commitMessage: z =>
          z
            .string({
              description: 'Commit message. Defaults to "chore: commit <path>".',
            })
            .optional(),
      },
      output: {
        commitSha: z =>
          z.string({ description: 'SHA of the created commit.' }).optional(),
        commitUrl: z =>
          z
            .string({ description: 'html_url of the created commit (if returned by GitHub).' })
            .optional(),
        created: z =>
          z.boolean({
            description: 'true if the file was newly created, false if an existing file was updated.',
          }),
      },
    },

    async handler(ctx) {
      const { repoUrl } = ctx.input;
      const repoPath = ctx.input.path;
      const branch = ctx.input.branch ?? 'main';
      const commitMessage =
        ctx.input.commitMessage ?? `chore: commit ${repoPath}`;

      // Fail closed on an unsafe destination path BEFORE resolving any credentials or
      // reading any source (no GitHub call on a bad path).
      assertSafeRepoPath(repoPath);

      // Resolve the file content: exactly one of inline `content` or workspace `sourcePath`.
      const { content, sourcePath } = ctx.input;
      if ((content === undefined) === (sourcePath === undefined)) {
        throw new Error(
          'capstone:commit-to-main: provide exactly ONE of `content` or `sourcePath`.',
        );
      }
      let fileContent: string;
      if (content !== undefined) {
        fileContent = content;
      } else {
        const src = resolveSafeChildPath(ctx.workspacePath, sourcePath!);
        fileContent = await fs.readFile(src, 'utf8');
      }

      // Parse owner/repo + resolve the GitHub App installation token (same auth as
      // publish:github). parseRepoUrl throws on a malformed URL or missing owner.
      const { host, owner, repo } = parseRepoUrl(repoUrl, integrations);
      if (!owner) {
        throw new Error(
          `capstone:commit-to-main: repoUrl '${repoUrl}' is missing an owner.`,
        );
      }
      const { token } = await credentialsProvider.getCredentials({
        url: `https://${host}/${owner}/${repo}`,
      });
      if (!token) {
        throw new Error(
          `capstone:commit-to-main: no GitHub credentials for ${host} — is ` +
            `integrations.github configured with the platform App?`,
        );
      }
      const apiBaseUrl = integrations.github.byHost(host)?.config.apiBaseUrl;
      const octokit = octokitFactory({ auth: token, baseUrl: apiBaseUrl });

      const { commitSha, commitUrl, created } = await commitFileToBranch({
        octokit,
        owner,
        repo,
        branch,
        path: repoPath,
        content: fileContent,
        message: commitMessage,
        logger: ctx.logger,
      });

      if (commitSha) ctx.output('commitSha', commitSha);
      if (commitUrl) ctx.output('commitUrl', commitUrl);
      ctx.output('created', created);
    },
  });
}
