/*
 * capstone:render-tenant — render the canonical tenant blueprint into the workspace.
 *
 * WHY THIS ACTION EXISTS (D-M4-2): the tenant blueprint at
 * `platform-infra/tenants/_template/` is the SINGLE source of truth for the tenancy
 * fence (AppProject, namespaces, RBAC, quotas, ApplicationSets). It uses the platform's
 * literal `__TEAM__` / `__SEMESTER__` tokens (the same convention `make`/`sed` use to
 * onboard a team by hand) — NOT Backstage nunjucks `${{ }}`. The built-in
 * `fetch:template` only renders nunjucks, so it cannot render `_template/` without us
 * forking it into a parallel nunjucks copy (which would drift). This action instead
 * READS the one `_template/` tree and substitutes the literal tokens, so the M4
 * Scaffolder PR step renders the same blueprint the manual `make` path does — one
 * source, no fork.
 *
 * It writes the rendered files under `<workspacePath>/<targetPath>/tenants/team-<team>/`
 * so the downstream `publish:github:pull-request` step (sourcePath = <targetPath>) opens
 * a PR whose diff is exactly the new `tenants/team-<team>/` directory.
 *
 * Token substitution is applied to BOTH file CONTENTS and file PATHS (the blueprint has
 * no tokenised paths today, but substituting paths too keeps the action correct if a
 * future `_template/` adds e.g. a `__TEAM__.yaml`).
 */
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import type { UrlReaderService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs-extra';
import path from 'path';

/**
 * A team/semester slug must be a DNS label (lowercase alphanumeric + hyphens, not
 * starting/ending with a hyphen). This mirrors the Scaffolder template's `team`
 * parameter `pattern` and the platform's D-026 canonical-slug rule. We re-validate
 * here so the action is safe even if invoked outside that template — a bad slug must
 * never reach a file path or a rendered manifest.
 */
const SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
/**
 * appName is a DNS-1123 LABEL (may start with a digit, unlike the team slug), matching the
 * Scaffolder template's `appName` parameter `pattern`. It is the app REPO name —
 * `UA-MIS/<appName>` (the scaffolder creates the repo AS the appName, #101) — which the
 * tenant ApplicationSets/AppProject point their `repoURL`/`sourceRepos` at. We re-validate
 * here because it flows into rendered manifest repo refs.
 */
const APPNAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Semester is `YYYY-(spring|summer|fall)`, matching the template's `semester` pattern. */
const SEMESTER = /^[0-9]{4}-(spring|summer|fall)$/;

/**
 * Apply the literal-token substitution to a string (path or file contents).
 * `__APPNAME__` is the app repo (UA-MIS/<appName>) — keyed on appName, NOT `<team>-app`:
 * those differ whenever the app isn't literally named `<team>-app`, and the old
 * `__TEAM__-app` form pointed ArgoCD at a non-existent repo ("repository not found").
 */
export function substituteTokens(
  input: string,
  team: string,
  appName: string,
  semester: string,
): string {
  return input
    .replace(/__APPNAME__/g, appName)
    .replace(/__TEAM__/g, team)
    .replace(/__SEMESTER__/g, semester);
}

/** Services the action handler needs, injected from the module's registerInit. */
export interface RenderTenantActionDeps {
  reader: UrlReaderService;
}

/**
 * Factory for the `capstone:render-tenant` action. Takes its service deps so the module
 * wires them in at registration (createBackendModule registerInit), keeping the action
 * unit-testable with a mock UrlReaderService.
 */
export function createRenderTenantAction(deps: RenderTenantActionDeps) {
  const { reader } = deps;

  return createTemplateAction({
    id: 'capstone:render-tenant',
    description:
      'Render the canonical tenants/_template/ blueprint into the workspace as ' +
      'tenants/team-<team>/, substituting the literal __TEAM__/__APPNAME__/__SEMESTER__ ' +
      'tokens (D-M4-2: render the single source, do not fork it).',
    schema: {
      input: {
        templateUrl: z =>
          z.string({
            description:
              'URL of the tenants/_template/ directory tree (e.g. ' +
              'https://github.com/UA-MIS/platform-infra/tree/main/tenants/_template). ' +
              'Pin to a tag/sha for reproducibility.',
          }),
        team: z =>
          z.string({
            description:
              'Team slug (DNS label). Substituted for __TEAM__; also the rendered ' +
              'directory name tenants/team-<team>/.',
          }),
        appName: z =>
          z.string({
            description:
              'App repo name (DNS-1123 label) — the repo created at UA-MIS/<appName> ' +
              '(#101). Substituted for __APPNAME__; the tenant ApplicationSets/AppProject ' +
              'point their repoURL/sourceRepos at it.',
          }),
        semester: z =>
          z.string({
            description:
              'Cohort label YYYY-(spring|summer|fall). Substituted for __SEMESTER__.',
          }),
        targetPath: z =>
          z
            .string({
              description:
                'Workspace-relative dir to write the rendered tree under. The PR ' +
                'step uses this as its sourcePath. Defaults to ".".',
            })
            .optional(),
      },
      output: {
        repoPath: z =>
          z.string({
            description:
              'The repo-relative path of the rendered tenant dir (tenants/team-<team>).',
          }),
        fileCount: z =>
          z.number({ description: 'Number of files rendered.' }),
      },
    },

    async handler(ctx) {
      const { templateUrl, team, appName, semester } = ctx.input;
      const targetPath = ctx.input.targetPath ?? '.';

      // Fail closed on a malformed slug/appName/semester — these flow into file paths,
      // rendered manifest metadata, AND repo refs; a bad value must never get written.
      if (!SLUG.test(team)) {
        throw new Error(
          `capstone:render-tenant: invalid team slug '${team}' — must be a DNS ` +
            `label matching ${SLUG}.`,
        );
      }
      if (!APPNAME.test(appName)) {
        throw new Error(
          `capstone:render-tenant: invalid appName '${appName}' — must be a DNS-1123 ` +
            `label matching ${APPNAME} (it becomes the UA-MIS/<appName> repo ref).`,
        );
      }
      if (!SEMESTER.test(semester)) {
        throw new Error(
          `capstone:render-tenant: invalid semester '${semester}' — must match ` +
            `${SEMESTER} (e.g. 2026-fall).`,
        );
      }

      // The rendered dir is tenants/team-<team>/ (the platform's per-team convention,
      // matching tenants/team-sample/). resolveSafeChildPath guards against any path
      // traversal from a crafted relpath in the read tree.
      const repoPath = `tenants/team-${team}`;
      const outDir = resolveSafeChildPath(
        ctx.workspacePath,
        path.join(targetPath, repoPath),
      );

      ctx.logger.info(
        `Rendering tenant blueprint from ${templateUrl} -> ${repoPath} ` +
          `(team=${team}, appName=${appName}, semester=${semester})`,
      );

      // Read the _template/ tree. files() yields every regular file with a path
      // relative to the tree root and a content() buffer accessor.
      const tree = await reader.readTree(templateUrl);
      const files = await tree.files();

      if (files.length === 0) {
        throw new Error(
          `capstone:render-tenant: no files found at ${templateUrl} — check the URL ` +
            `points at the tenants/_template directory and the ref exists.`,
        );
      }

      let fileCount = 0;
      for (const file of files) {
        // Substitute tokens in the relative path too (keeps the action correct if a
        // future blueprint tokenises a filename). resolveSafeChildPath re-anchors it
        // under outDir and rejects traversal.
        const relPath = substituteTokens(file.path, team, appName, semester);
        const dest = resolveSafeChildPath(outDir, relPath);

        const raw = (await file.content()).toString('utf8');
        const rendered = substituteTokens(raw, team, appName, semester);

        await fs.outputFile(dest, rendered);
        fileCount += 1;
      }

      ctx.logger.info(
        `capstone:render-tenant: wrote ${fileCount} file(s) to ${repoPath}.`,
      );

      ctx.output('repoPath', repoPath);
      ctx.output('fileCount', fileCount);
    },
  });
}
