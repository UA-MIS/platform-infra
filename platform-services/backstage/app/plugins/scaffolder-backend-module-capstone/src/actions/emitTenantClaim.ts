/*
 * capstone:emit-tenant-claim — render the ONE CapstoneTenant XR (ADR-031).
 *
 * THE ZERO-TOUCH ONBOARDING SEAM. This is the Crossplane-era replacement for the
 * imperative trio `capstone:harbor-onboard` + `capstone:render-tenant` +
 * `publish:github:pull-request` (the human-merged onboarding PR + post-merge `make`
 * steps). Instead of rendering the whole tenant fence and opening a review-gated PR,
 * the scaffolder now emits a SINGLE small, schema-validated CapstoneTenant XR; a
 * reviewed-once Crossplane Composition expands it into the entire tenant (repo +
 * Harbor + Vault + the k8s tenancy fence). See:
 *   platform-services/crossplane/apis/{xrd,composition}.yaml.
 *
 * This action only PRODUCES the XR file (analogous to capstone:render-tenant
 * producing the tenant manifests). The Phase-2 template wires a publish step that
 * commits it to platform-infra `tenants/_claims/<team>-<app>.yaml` on main via the
 * platform GitHub App (on the branch-protection bypass list — ADR-031 §7 Option A),
 * so there is NO onboarding PR and NO human merge. See CROSSPLANE-CUTOVER.md.
 *
 * It writes the XR to `<workspacePath>/<targetPath>/tenants/_claims/<team>-<app>.yaml`
 * so a downstream publish step (sourcePath = <targetPath>) lands exactly that one file.
 *
 * Inputs are re-validated here (fail closed) so a bad slug can never reach the XR —
 * the XRD enforces the same patterns again at admission, defense in depth.
 */
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs-extra';
import path from 'path';

/** Team/github-team/app slug: a DNS-1123 label (mirrors the XRD `team` pattern). */
const SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
/** App slug may start with a digit (mirrors the XRD `appName` pattern). */
const APP_SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** Semester slug `YYYY-(spring|summer|fall)` (mirrors the XRD `semester` pattern). */
const SEMESTER = /^[0-9]{4}-(spring|summer|fall)$/;

/**
 * Reserved-name denylist (CXP-1 — privilege escalation / tenant isolation). The XR
 * auto-commits to main via the GitHub App with NO human merge, so `team`/`appName`
 * are low-trust inputs used directly with org-admin + cluster-wide creds. DNS-1123
 * format alone does not stop `team: platform` (clobbers the privileged platform
 * AppProject) or `appName: platform-infra` (hands the tenant push to the infra repo).
 * These MUST stay in lockstep with the XRD x-kubernetes-validations (apis/xrd.yaml) —
 * the XRD is the admission gate; this is defense in depth at emit time (fail closed).
 */
const RESERVED_TEAMS = new Set([
  'platform',
  'argocd',
  'default',
  'kube-system',
  'crossplane-system',
  'vault',
  'vault-unsealer',
  'harbor',
  'arc-runners',
  'arc-system',
  'sealed-secrets',
  'external-secrets',
  'monitoring',
  'cert-manager',
]);
const RESERVED_APPNAMES = new Set([
  'platform-infra',
  'capstone-app-template',
  '.github',
]);

/** Render a string scalar safely for the small, known XR field set (YAML-quote). */
function yamlStr(v: string): string {
  return JSON.stringify(v); // valid YAML double-quoted scalar for our slug charset
}

/** Build the CapstoneTenant XR YAML from validated inputs. Exported for unit tests. */
export function renderCapstoneTenant(input: {
  team: string;
  appName: string;
  semester: string;
  githubTeam?: string;
  port?: number;
  previewEnabled?: boolean;
  domain?: string;
}): string {
  const githubTeam = input.githubTeam ?? input.team;
  const port = input.port ?? 8080;
  const previewEnabled = input.previewEnabled ?? false;
  const domain = input.domain ?? 'capstone.uamishub.com';
  return [
    '# Emitted by The Process scaffolder (capstone:emit-tenant-claim, ADR-031).',
    '# ONE CapstoneTenant XR — a reviewed-once Crossplane Composition expands it into',
    '# the full tenant (repo + Harbor + Vault + the k8s tenancy fence). No onboarding',
    '# PR, no operator make steps. De-provision = git rm this file.',
    'apiVersion: platform.capstone.uamishub.com/v1alpha1',
    'kind: CapstoneTenant',
    'metadata:',
    `  name: ${input.team}-${input.appName}`,
    '  namespace: capstone-tenants',
    '  labels:',
    `    platform.capstone/team: ${yamlStr(input.team)}`,
    `    platform.capstone/semester: ${yamlStr(input.semester)}`,
    '    platform.capstone/component: tenant',
    'spec:',
    `  team: ${yamlStr(input.team)}`,
    `  appName: ${yamlStr(input.appName)}`,
    `  semester: ${yamlStr(input.semester)}`,
    `  githubTeam: ${yamlStr(githubTeam)}`,
    `  port: ${port}`,
    `  previewEnabled: ${previewEnabled}`,
    `  domain: ${yamlStr(domain)}`,
    '',
  ].join('\n');
}

/**
 * Factory for `capstone:emit-tenant-claim`. No external service deps — it only writes
 * to the scaffolder workspace (kept trivially unit-testable, like render-tenant).
 */
export function createEmitTenantClaimAction() {
  return createTemplateAction({
    id: 'capstone:emit-tenant-claim',
    description:
      'Render the single CapstoneTenant XR (ADR-031 zero-touch onboarding) into the ' +
      'workspace as tenants/_claims/<team>-<app>.yaml. A reviewed-once Crossplane ' +
      'Composition then expands it into the full tenant.',
    schema: {
      input: {
        team: z =>
          z.string({
            description: 'Team slug (DNS label) — the one canonical key (D-026).',
          }),
        appName: z =>
          z.string({
            description:
              'App/repo slug (DNS label). Repo/registry/host/namespaces derive from it.',
          }),
        semester: z =>
          z.string({
            description: 'Cohort slug YYYY-(spring|summer|fall).',
          }),
        githubTeam: z =>
          z
            .string({ description: 'GitHub team slug for push. Defaults to team.' })
            .optional(),
        port: z =>
          z
            .number({ description: 'Container port. Defaults to 8080.' })
            .optional(),
        previewEnabled: z =>
          z
            .boolean({
              description:
                'Enable the per-PR preview ApplicationSet (security-gated). Default false.',
            })
            .optional(),
        domain: z =>
          z
            .string({ description: 'Public base domain. Defaults to capstone.uamishub.com.' })
            .optional(),
        targetPath: z =>
          z
            .string({
              description:
                'Workspace-relative dir to write under (publish sourcePath). Defaults to ".".',
            })
            .optional(),
      },
      output: {
        claimPath: z =>
          z.string({
            description: 'Repo-relative path of the emitted claim (tenants/_claims/<team>-<app>.yaml).',
          }),
      },
    },

    async handler(ctx) {
      const { team, appName, semester } = ctx.input;
      const targetPath = ctx.input.targetPath ?? '.';

      // Fail closed on malformed slugs — they flow into the XR name + spec and into
      // every resource the Composition derives. The XRD validates again at admission.
      if (!SLUG.test(team)) {
        throw new Error(
          `capstone:emit-tenant-claim: invalid team slug '${team}' — must be a DNS ` +
            `label matching ${SLUG}.`,
        );
      }
      if (!APP_SLUG.test(appName)) {
        throw new Error(
          `capstone:emit-tenant-claim: invalid appName '${appName}' — must be a DNS ` +
            `label matching ${APP_SLUG}.`,
        );
      }
      // Reserved-name guard (CXP-1) — reject names that would collide with privileged
      // platform RBAC or org infra repos. Mirrors the XRD admission denylist.
      if (RESERVED_TEAMS.has(team)) {
        throw new Error(
          `capstone:emit-tenant-claim: team '${team}' is a reserved platform/namespace ` +
            `name and cannot be used as a tenant team slug.`,
        );
      }
      if (RESERVED_APPNAMES.has(appName)) {
        throw new Error(
          `capstone:emit-tenant-claim: appName '${appName}' is a reserved ` +
            `org-infrastructure repo name and cannot be used as a tenant app name.`,
        );
      }
      if (!SEMESTER.test(semester)) {
        throw new Error(
          `capstone:emit-tenant-claim: invalid semester '${semester}' — must match ` +
            `${SEMESTER} (e.g. 2026-fall).`,
        );
      }
      if (ctx.input.githubTeam && !SLUG.test(ctx.input.githubTeam)) {
        throw new Error(
          `capstone:emit-tenant-claim: invalid githubTeam '${ctx.input.githubTeam}'.`,
        );
      }

      const claimPath = `tenants/_claims/${team}-${appName}.yaml`;
      const dest = resolveSafeChildPath(
        ctx.workspacePath,
        path.join(targetPath, claimPath),
      );

      const xr = renderCapstoneTenant({
        team,
        appName,
        semester,
        githubTeam: ctx.input.githubTeam,
        port: ctx.input.port,
        previewEnabled: ctx.input.previewEnabled,
        domain: ctx.input.domain,
      });

      await fs.outputFile(dest, xr);
      ctx.logger.info(
        `capstone:emit-tenant-claim: wrote ${claimPath} (team=${team}, app=${appName}, ` +
          `semester=${semester}).`,
      );
      ctx.output('claimPath', claimPath);
    },
  });
}
