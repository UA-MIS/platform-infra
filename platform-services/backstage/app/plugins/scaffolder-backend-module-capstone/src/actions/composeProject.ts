/*
 * capstone:compose-project — the COMPOSITION ENGINE behind the unified "New Project"
 * wizard (ADR-034). It assembles a project repo at scaffold time from composable language
 * FRAGMENTS plus ONE shared .devops/.github contract, instead of N×M pre-baked templates.
 *
 * WHAT IT DOES (one action replaces the per-stack fetch-skeleton steps):
 *   1. reads each chosen fragment's fragment.yaml metadata (load-bearing — this is what
 *      makes the fan-out work: drop a fragment dir + fragment.yaml and it just composes);
 *   2. asks the PURE planner (composePlan.js — the SAME module the offline dry-render +
 *      unit tests use, so there is no drift) for the component model + DB resolution;
 *   3. renders each chosen fragment's skeleton/ into its component dir (app/ for single,
 *      frontend/+backend/ for frontend+backend, backend/+mobile/ for a mobile project);
 *   4. renders the ONE shared contract (_contract/: .devops chart+overlays+ci, .github CI,
 *      catalog-info, mkdocs) ONCE — the copy-not-reference fix — with the COMPUTED
 *      components list so components.yaml + the chart cannot drift from the wizard choices;
 *   5. sets the tenant `database` flag (none|mysql) from the wizard DB choice + needsDB.
 *
 * Rendering matches Backstage fetch:template: nunjucks with the ${{ }} variable syntax and a
 * `values` namespace; the .github, .devops/ci (+ any .mobile-ci) subtrees are
 * shipped VERBATIM (the copyWithoutTemplating contract — they carry ${{ github.* }} / ${VAR}).
 *
 * This action only WRITES the workspace; the downstream publish/register/harbor-onboard/
 * render-tenant/tenant-pr steps are shared with the proven golden path and unchanged.
 */
import { resolveSafeChildPath } from '@backstage/backend-plugin-api';
import type { UrlReaderService, LoggerService } from '@backstage/backend-plugin-api';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs-extra';
import path from 'path';
import nunjucks from 'nunjucks';
import { parse as parseYaml } from 'yaml';
// The PURE planner — shared with the dry-render harness + node unit tests (no drift).
import { planComposition, type FragmentMeta, type ComposePlan } from './composePlan';

const SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const APPNAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SEMESTER = /^[0-9]{4}-(spring|summer|fall)$/;

/** Subtrees shipped verbatim (never templated) — the copyWithoutTemplating contract. */
const VERBATIM = [/(^|\/)\.github\//, /(^|\/)\.devops\/ci\//, /(^|\/)\.mobile-ci\//];
const isVerbatim = (rel: string) => VERBATIM.some(re => re.test(rel));

/** A nunjucks env configured exactly like Backstage's scaffolder (${{ }} variables). */
function makeNunjucks(): nunjucks.Environment {
  return new nunjucks.Environment(undefined, {
    autoescape: false,
    tags: {
      variableStart: '${{',
      variableEnd: '}}',
      blockStart: '{%',
      blockEnd: '%}',
      commentStart: '{#',
      commentEnd: '#}',
    },
  });
}

export interface ComposeProjectDeps {
  reader: UrlReaderService;
}

/** Read + parse a fragment.yaml from a fragment dir tree URL. */
async function readFragmentMeta(
  reader: UrlReaderService,
  fragmentDirUrl: string,
): Promise<FragmentMeta> {
  const tree = await reader.readTree(fragmentDirUrl);
  const files = await tree.files();
  const metaFile = files.find(f => f.path === 'fragment.yaml' || f.path.endsWith('/fragment.yaml'));
  if (!metaFile) {
    throw new Error(`capstone:compose-project: no fragment.yaml at ${fragmentDirUrl}`);
  }
  const meta = parseYaml((await metaFile.content()).toString('utf8')) as FragmentMeta;
  if (!meta || typeof meta !== 'object') {
    throw new Error(`capstone:compose-project: fragment.yaml at ${fragmentDirUrl} did not parse to an object`);
  }
  return meta;
}

/** Render (or copy verbatim) every file under `skeleton/` of a fragment dir tree URL into outDir. */
async function renderSkeleton(
  reader: UrlReaderService,
  env: nunjucks.Environment,
  fragmentDirUrl: string,
  outDir: string,
  values: Record<string, unknown>,
  logger: LoggerService,
): Promise<number> {
  const tree = await reader.readTree(fragmentDirUrl);
  const files = await tree.files();
  let n = 0;
  for (const file of files) {
    if (!file.path.startsWith('skeleton/')) continue; // only the app code, not fragment.yaml
    const rel = file.path.slice('skeleton/'.length);
    if (!rel) continue;
    const dest = resolveSafeChildPath(outDir, rel);
    const raw = await file.content();
    if (isVerbatim(rel)) {
      await fs.outputFile(dest, raw);
    } else {
      await fs.outputFile(dest, env.renderString(raw.toString('utf8'), { values }));
    }
    n += 1;
  }
  logger.info(`capstone:compose-project: rendered ${n} file(s) -> ${outDir}`);
  return n;
}

/** Render the ONE shared contract tree into the workspace root. */
async function renderContract(
  reader: UrlReaderService,
  env: nunjucks.Environment,
  contractUrl: string,
  outRoot: string,
  values: Record<string, unknown>,
  logger: LoggerService,
): Promise<number> {
  const tree = await reader.readTree(contractUrl);
  const files = await tree.files();
  let n = 0;
  for (const file of files) {
    const rel = file.path;
    const dest = resolveSafeChildPath(outRoot, rel);
    const raw = await file.content();
    if (isVerbatim(rel)) {
      await fs.outputFile(dest, raw);
    } else {
      await fs.outputFile(dest, env.renderString(raw.toString('utf8'), { values }));
    }
    n += 1;
  }
  logger.info(`capstone:compose-project: rendered shared contract (${n} files)`);
  return n;
}

export function createComposeProjectAction(deps: ComposeProjectDeps) {
  const { reader } = deps;
  return createTemplateAction({
    id: 'capstone:compose-project',
    description:
      'Assemble a project from composable language fragments + the ONE shared .devops/.github ' +
      'contract (ADR-034): reads each chosen fragment.yaml, computes .devops/components.yaml, ' +
      'renders the fragment skeleton(s) into app/ (single) or frontend/+backend/ (FE+BE) or ' +
      'backend/+mobile/ (mobile), and sets the tenant database flag.',
    schema: {
      input: {
        fragmentsUrl: z =>
          z.string({
            description:
              'Pinned URL of the _fragments tree (e.g. https://github.com/UA-MIS/platform-infra/' +
              'tree/main/platform-services/backstage/templates/_fragments). Contains _contract/ ' +
              'plus <category>/<id>/ fragment dirs.',
          }),
        projectType: z => z.enum(['web', 'mobile']),
        layout: z => z.enum(['single', 'frontend-backend']).optional(),
        singleFragment: z =>
          z.string({ description: 'category/id of the single-component fragment (web/single).' }).optional(),
        frontendFragment: z =>
          z.string({ description: 'category/id of the frontend fragment (web/frontend-backend).' }).optional(),
        backendFragment: z =>
          z.string({ description: 'category/id of the backend fragment (FE+BE or mobile).' }).optional(),
        mobileFragment: z =>
          z.string({ description: 'category/id of the mobile fragment (projectType mobile).' }).optional(),
        database: z =>
          z.enum(['host-mysql', 'host-postgres', 'bring-your-own', 'none']),
        appName: z => z.string(),
        team: z => z.string(),
        semester: z => z.string({ description: 'YYYY-(spring|summer|fall).' }),
        semesterDisplay: z => z.string(),
        port: z => z.number().optional(),
        description: z => z.string().optional(),
        targetPath: z => z.string({ description: 'Workspace subdir to write into. Default ".".' }).optional(),
      },
      output: {
        components: z => z.array(z.any()),
        database: z => z.string(),
        dbWired: z => z.boolean(),
        single: z => z.boolean(),
        fileCount: z => z.number(),
      },
    },

    async handler(ctx) {
      const i = ctx.input;
      const port = i.port ?? 8080;

      // Fail closed on malformed identity inputs — they flow into manifests + repo refs.
      if (!APPNAME.test(i.appName)) throw new Error(`compose: invalid appName '${i.appName}'`);
      if (!SLUG.test(i.team)) throw new Error(`compose: invalid team '${i.team}'`);
      if (!SEMESTER.test(i.semester)) throw new Error(`compose: invalid semester '${i.semester}'`);

      const base = i.fragmentsUrl.replace(/\/+$/, '');
      const fragUrl = (rel: string) => `${base}/${rel.replace(/^\/+/, '')}`;

      // 1) read the chosen fragments' metadata.
      const metas: Record<string, FragmentMeta> = {};
      const dirBySlot: Record<string, string> = {};
      const pick = async (slot: string, rel?: string) => {
        if (!rel) return;
        metas[slot] = await readFragmentMeta(reader, fragUrl(rel));
        dirBySlot[slot] = rel;
      };
      await pick('single', i.singleFragment);
      await pick('frontend', i.frontendFragment);
      await pick('backend', i.backendFragment);
      await pick('mobile', i.mobileFragment);

      // 2) compute the plan (pure, shared core).
      const plan: ComposePlan = planComposition({
        projectType: i.projectType,
        layout: i.layout,
        fragments: metas,
        database: i.database,
        port,
      });

      const targetPath = i.targetPath ?? '.';
      const outRoot = resolveSafeChildPath(ctx.workspacePath, targetPath);
      const env = makeNunjucks();
      const values: Record<string, unknown> = {
        appName: i.appName,
        team: i.team,
        semester: i.semester,
        semesterDisplay: i.semesterDisplay,
        port,
        description: i.description ?? 'A UA-MIS capstone project.',
        components: plan.components,
        database: plan.database,
        dbWired: plan.dbWired,
        single: plan.single,
      };

      let fileCount = 0;
      // 3) each fragment skeleton -> its component dir.
      for (const copy of plan.copies) {
        const slot = Object.keys(metas).find(s => metas[s].id === copy.fragment.id)!;
        fileCount += await renderSkeleton(
          reader, env, fragUrl(dirBySlot[slot]),
          resolveSafeChildPath(outRoot, copy.targetDir), values, ctx.logger,
        );
      }
      // 4) the ONE shared contract -> workspace root.
      fileCount += await renderContract(reader, env, fragUrl('_contract'), outRoot, values, ctx.logger);

      ctx.logger.info(
        `capstone:compose-project: ${i.projectType}/${i.layout ?? '-'} assembled ` +
          `(${plan.components.length} component(s), database=${plan.database}, ${fileCount} files).`,
      );

      ctx.output('components', plan.components);
      ctx.output('database', plan.database);
      ctx.output('dbWired', plan.dbWired);
      ctx.output('single', plan.single);
      ctx.output('fileCount', fileCount);
    },
  });
}
