/*
 * capstone:compose-project — the COMPOSITION ENGINE behind the unified "New Project"
 * wizard (ADR-034). It assembles a project repo at scaffold time from composable language
 * FRAGMENTS plus ONE shared .devops/.github contract, instead of N×M pre-baked templates.
 *
 * WHAT IT DOES (one action replaces the per-stack fetch-skeleton steps):
 *   1. reads each chosen fragment's fragment.yaml metadata (load-bearing — this is what
 *      makes the fan-out work: drop a fragment dir + fragment.yaml and it just composes);
 *   2. asks the PURE planner (composePlan.mjs — the SAME module the offline dry-render +
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
import nunjucks from 'nunjucks';
import { parse as parseYaml } from 'yaml';
// The PURE planner — shared with the dry-render harness + node unit tests (no drift).
// Imported from the .mjs (native ESM) so it binds into the rollup backend bundle; see the
// composePlan.mjs header for why a CommonJS planner cannot be bundled here.
import { planComposition, type FragmentMeta, type ComposePlan } from './composePlan.mjs';

const SLUG = /^[a-z]([-a-z0-9]*[a-z0-9])?$/;
const APPNAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const SEMESTER = /^[0-9]{4}-(spring|summer|fall)$/;

/** Subtrees shipped verbatim (never templated) — the copyWithoutTemplating contract. */
const VERBATIM = [
  /(^|\/)\.github\//,
  /(^|\/)\.devops\/ci\//,
  /(^|\/)\.mobile-ci\//,
  // Python bytecode + test caches: binary AND their bodies embed `{%` (pytest's
  // assertion-rewrite format strings, e.g. `{%(py2)s = %(py0)s.status_code`), which
  // crashes nunjucks with "tag name expected". A stray committed .pyc under a fragment
  // skeleton (the root cause of the Python-scaffold failure) must never be templated.
  // This path guard backs up the isBinary() NUL sniff below.
  /(^|\/)__pycache__\//,
  /\.pyc$/,
  /\.pyo$/,
  /(^|\/)\.pytest_cache\//,
];
const isVerbatim = (rel: string) => VERBATIM.some(re => re.test(rel));

/**
 * True when a file's bytes look binary (contain a NUL byte). nunjucks operates on text;
 * feeding it a binary buffer (image, font, .so, compiled .pyc) either corrupts the output
 * or throws when the bytes happen to contain template delimiters like `{%`. Any binary that
 * slips into a fragment skeleton or the shared contract must be copied byte-for-byte, not
 * rendered — this catches ANY binary, not just the extensions enumerated in VERBATIM.
 */
const isBinary = (raw: Buffer): boolean => raw.includes(0);

/**
 * Normalise a UrlReader file's content() result to a Buffer.
 *
 * WHY THIS EXISTS (the renderContract Array crash): GithubUrlReader.readTree builds each
 * file's content with `concat-stream` (TarArchiveResponse), and concat-stream returns `[]`
 * — a plain EMPTY Array, not an empty Buffer — for a ZERO-BYTE file (concat-stream
 * getBody(): `if (!this.encoding && this.body.length === 0) return []`). The shared
 * contract ships an empty `.github/workflows/.gitkeep`, which is a VERBATIM path, so
 * `fs.outputFile(dest, raw)` got an Array and threw
 * `ERR_INVALID_ARG_TYPE ... Received an instance of Array` on the first live wizard run.
 * `content()` is typed `Promise<Buffer>`, so the empty-file case is a runtime-only quirk
 * the type system hides; coercing here makes both render paths robust to it (a non-empty
 * file is already a Buffer and passes through untouched; `Buffer.from([])` === empty Buffer).
 */
function toBuffer(content: unknown): Buffer {
  if (Buffer.isBuffer(content)) return content;
  return Buffer.from(content as ArrayLike<number>);
}

/**
 * A nunjucks env configured like Backstage's scaffolder (${{ }} variables), with ONE
 * deliberate deviation: the comment delimiter is `{#! … !#}`, NOT the stock nunjucks `{# … #}`.
 *
 * WHY (the durable comment-delimiter fix): fragment source is arbitrary framework code, and
 * several frameworks use `{#…}` as real, load-bearing syntax — Svelte's `{#if}`/`{#each}`
 * control blocks, Handlebars/Mustache `{{#…}}`, etc. With the stock `{#` comment start,
 * nunjucks swallowed those as comments (or threw on the unterminated ones), which is exactly
 * how the Svelte fragment broke. Rather than wrap every such file in `{% raw %}` per-file
 * (fragile — every new `{#`-using framework re-breaks), we move the comment start to a
 * three-char token no framework emits: `{#!` (mirrors HTML/`<!-- -->` "bang = comment"). Any
 * `{#if`/`{#each`/`{{#` now passes through verbatim because it does not begin with `{#!`.
 * The offline dry-render engine (templates/_fragments/_tools/compose_lib.py) mirrors these
 * exact delimiters so the two engines cannot drift.
 */
function makeNunjucks(): nunjucks.Environment {
  return new nunjucks.Environment(undefined, {
    autoescape: false,
    tags: {
      variableStart: '${{',
      variableEnd: '}}',
      blockStart: '{%',
      blockEnd: '%}',
      commentStart: '{#!',
      commentEnd: '!#}',
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
    const raw = toBuffer(await file.content());
    if (isVerbatim(rel) || isBinary(raw)) {
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
    const raw = toBuffer(await file.content());
    if (isVerbatim(rel) || isBinary(raw)) {
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
        // NOTE: progressive delivery is now an ENV-BASED chart default (prod overlay renders a
        // single-component web app as an Argo Rollouts canary — ADR-037), NOT a compose input.
        // The old `progressiveDelivery` boolean input was removed here. It is accepted-but-ignored
        // for backward compatibility with any already-deployed template that still passes it:
        // zod strips unknown keys, so an extra `progressiveDelivery` in the step input is harmless
        // and NO Backstage rebuild is required for the env-based behavior (the chart, read at
        // scaffold time, drives it entirely).
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
        // NOTE: `progressiveDelivery` is no longer passed into `values` — progressive delivery is
        // now an env-based chart default (the prod overlay renders a single-component web app as a
        // canary Rollout; dev/staging/preview stay plain Deployments — ADR-037). No template reads
        // `values.progressiveDelivery` anymore, so nothing needs it here.
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
