/*
 * Tests for capstone:compose-project (ADR-034).
 *
 * Strategy: hand-mock UrlReaderService.readTree to return small in-memory trees keyed by
 * URL (the _contract tree + each fragment dir tree), drive the handler through
 * createMockActionContext, and assert the engine:
 *   - reads each fragment.yaml, computes .devops/components.yaml from the plan;
 *   - renders fragment skeleton(s) into app/ (single) or frontend/+backend/ (FE+BE);
 *   - renders the shared contract once, with ${{ values.* }} substituted;
 *   - ships .devops/ci/** + .github/** VERBATIM (copyWithoutTemplating);
 *   - sets the tenant database flag + dbWired correctly;
 *   - fails closed on bad identity inputs.
 *
 * The pure routing logic is covered separately + offline by composePlan.test.cjs; this
 * exercises the IO + nunjucks + wiring of the action itself.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import { createMockDirectory } from '@backstage/backend-test-utils';
import type { UrlReaderService } from '@backstage/backend-plugin-api';
import fs from 'fs-extra';
import path from 'path';
import { createComposeProjectAction } from './composeProject';

type File = { path: string; content: string };

/** A reader whose readTree returns files chosen by which URL suffix is requested. */
function mockReader(trees: Record<string, File[]>): UrlReaderService {
  const pick = (url: string): File[] => {
    // longest matching suffix wins (so /backend/fastapi beats /backend)
    const key = Object.keys(trees)
      .filter(k => url.endsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? trees[key] : [];
  };
  return {
    readUrl: jest.fn(),
    read: jest.fn(),
    search: jest.fn(),
    readTree: jest.fn().mockImplementation(async (url: string) => ({
      files: async () =>
        pick(url).map(f => ({
          path: f.path,
          content: async () => Buffer.from(f.content, 'utf8'),
        })),
      dir: jest.fn(),
      archive: jest.fn(),
      etag: 'mock-etag',
    })),
  } as unknown as UrlReaderService;
}

/** An in-memory tree entry with the same shape a UrlReader ReadTreeResponseFile has. */
type Entry = { path: string; content: () => Promise<Buffer | number[]> };

/**
 * A reader whose readTree returns pre-built entries (with their own content() accessor)
 * chosen by URL suffix — the counterpart to mockReader() for trees whose content() must
 * reproduce a real reader quirk (an empty file resolving to [] rather than a Buffer).
 */
function treeReader(trees: Record<string, Entry[]>): UrlReaderService {
  const pick = (url: string): Entry[] => {
    const key = Object.keys(trees)
      .filter(k => url.endsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return key ? trees[key] : [];
  };
  return {
    readUrl: jest.fn(),
    read: jest.fn(),
    search: jest.fn(),
    readTree: jest.fn().mockImplementation(async (url: string) => ({
      files: async () => pick(url),
      dir: jest.fn(),
      archive: jest.fn(),
      etag: 'mock-etag',
    })),
  } as unknown as UrlReaderService;
}

/** Convert the static File[] fragment fixtures to Entry[] (always a Buffer, like a normal file). */
const asEntries = (files: File[]): Entry[] =>
  files.map(f => ({ path: f.path, content: async () => Buffer.from(f.content, 'utf8') }));

/** The REAL shared contract tree on disk (…/templates/_fragments/_contract). */
const CONTRACT_DIR = path.resolve(
  __dirname,
  '../../../../../templates/_fragments/_contract',
);

/** Recursively list files (posix-relative paths, dotfiles included) under a dir. */
async function walkDisk(root: string, dir: string = root): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walkDisk(root, abs)));
    else if (ent.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return out.sort();
}

/**
 * Read the real contract tree into Entry[] whose content() FAITHFULLY reproduces the
 * GithubUrlReader/concat-stream behaviour that caused the crash: a zero-byte file resolves
 * to [] (an empty Array), every other file to a Buffer (concat-stream getBody:
 * `if (!this.encoding && this.body.length === 0) return []`). This is the only way to
 * exercise the bug offline — mockReader() above always returns a Buffer and so never hit it.
 */
async function readContractWithReaderQuirk(root: string): Promise<Entry[]> {
  const rels = await walkDisk(root);
  return rels.map(rel => ({
    path: rel,
    content: async () => {
      const buf = await fs.readFile(path.join(root, rel));
      return buf.length === 0 ? [] : buf;
    },
  }));
}

const FRAGMENTS_URL =
  'https://github.com/UA-MIS/platform-infra/tree/main/platform-services/backstage/templates/_fragments';

// A minimal but representative shared contract tree (the ${{ }} + {% for %} the real one uses).
const CONTRACT: File[] = [
  {
    path: '.devops/components.yaml',
    content:
      'apiVersion: platform.capstone/v1\ncomponents:\n' +
      '{%- for c in values.components %}\n' +
      '  - name: ${{ c.name }}\n    kind: ${{ c.kind }}\n    context: ${{ c.context }}\n' +
      '    path: ${{ c.path }}\n    needsDb: ${{ c.needsDb }}\n    buildType: ${{ c.buildType }}\n' +
      '{%- endfor %}\n',
  },
  {
    path: '.devops/app-metadata.yaml',
    content: 'app-name: ${{ values.appName }}\nteam: ${{ values.team }}\ndatabase: ${{ values.database }}\n',
  },
  {
    // VERBATIM subtree: must NOT be templated (carries ${{ github.* }} / ${VAR}).
    path: '.devops/ci/resolve.sh',
    content: '#!/bin/sh\necho "${{ github.sha }} ${PORT}"\n',
  },
  { path: 'catalog-info.yaml', content: 'metadata:\n  name: ${{ values.appName }}\n' },
];

const FASTAPI = [
  { path: 'fragment.yaml', content: 'id: fastapi\ncategory: backend\nslots: [backend, single]\ndefaultPort: 8080\ningressPath: /api\nneedsDB: true\nbuildType: container\ndockerfile: Dockerfile\n' },
  { path: 'skeleton/Dockerfile', content: '# port ${{ values.port }}\nFROM python:3.12-slim\n' },
  { path: 'skeleton/app/main.py', content: 'APP = "${{ values.appName }}"\n' },
];
const REACT = [
  { path: 'fragment.yaml', content: 'id: react\ncategory: frontend\nslots: [frontend]\ndefaultPort: 8080\ningressPath: /\nneedsDB: false\nbuildType: container\ndockerfile: Dockerfile\n' },
  { path: 'skeleton/src/App.tsx', content: "fetch('/api/health') // ${{ values.appName }}\n" },
];
const EXPRESS = [
  { path: 'fragment.yaml', content: 'id: express\ncategory: backend\nslots: [backend, single]\ndefaultPort: 8080\ningressPath: /api\nneedsDB: true\nbuildType: container\ndockerfile: Dockerfile\n' },
  { path: 'skeleton/src/index.ts', content: "const app = '${{ values.appName }}'\n" },
];
/**
 * A DB-LESS single-component fragment — the Group (a) shape (board #139). `static/bare-html`,
 * `static/react-static` and `frontend/angular` are all needsDB:false, so the wizard hides the
 * Database question for them and submits with NO `database` key at all.
 */
const BARE_HTML = [
  { path: 'fragment.yaml', content: 'id: bare-html\ncategory: static\nslots: [static, single, frontend]\ndefaultPort: 8080\ningressPath: /\nneedsDB: false\nbuildType: static\ndockerfile: Dockerfile\n' },
  { path: 'skeleton/index.html', content: '<title>${{ values.appName }}</title>\n' },
];

/**
 * A single-component fragment whose skeleton mixes ALL four delimiter classes in one file:
 *   - Svelte `{#if}`/`{:else}`/`{#each}` control blocks — MUST survive verbatim (the durable
 *     comment-delimiter fix: stock `{#` comment start ate these, which is bug #5);
 *   - a real `${{ values.* }}` variable — MUST substitute;
 *   - a `{% for %}` block — MUST run;
 *   - a `{#! … !#}` comment (the NEW delimiter) — MUST be stripped;
 *   - literal `{'{ … }'}` braces — MUST pass through untouched.
 * This is the fixture that would have failed pre-fix and now proves no `{% raw %}` wrapper is
 * needed for a `{#`-using framework.
 */
const SVELTE = [
  { path: 'fragment.yaml', content: 'id: sveltekit\ncategory: fullstack\nslots: [single]\ndefaultPort: 8080\ningressPath: /\nneedsDB: true\nbuildType: container\ndockerfile: Dockerfile\n' },
  {
    path: 'skeleton/src/routes/items/+page.svelte',
    content:
      "<script lang=\"ts\">let appName = '${{ values.appName }}'</script>\n" +
      '{#if data.dbError}\n' +
      '  <p>db error</p>\n' +
      '{:else if data.items.length === 0}\n' +
      '  <p>none</p>\n' +
      '{:else}\n' +
      '  <ul>{#each data.items as item (item.id)}<li>{item.name}</li>{/each}</ul>\n' +
      '{/if}\n' +
      '{#! this comment must vanish !#}\n' +
      '{% for c in values.components %}<span>${{ c.name }}</span>{% endfor %}\n' +
      "literal={'{ \"name\": \"...\" }'}\n",
  },
];

/**
 * A realistic compiled-Python bytecode body: the .pyc magic header (which contains NUL
 * bytes) followed by the exact `{%(py2)s = %(py0)s.status_code` pattern pytest's
 * assertion-rewrite bakes into test .pyc files. This is precisely what a stray committed
 * __pycache__/*.pyc under a fragment skeleton contains, and the `{%` bytes are what crash
 * nunjucks ("tag name expected") when the file is (wrongly) templated.
 */
const PYC_BYTES = Buffer.concat([
  Buffer.from([0x16, 0x0d, 0x0d, 0x0a, 0x00, 0x00, 0x00, 0x00]), // .pyc magic + NUL header
  Buffer.from('assert response.status_code == 200\n', 'utf8'),
  Buffer.from('{%(py2)s = %(py0)s.status_code\n', 'utf8'),
  Buffer.from([0x00]),
]);

describe('capstone:compose-project', () => {
  const mockDir = createMockDirectory();
  afterEach(() => {
    mockDir.clear();
    jest.clearAllMocks();
  });

  const common = {
    fragmentsUrl: FRAGMENTS_URL,
    appName: 'notes-api',
    team: 'acme',
    semester: '2026-fall',
    semesterDisplay: 'Capstone Fall 2026',
    port: 8080,
    description: 'demo',
  };

  it('single backend (fastapi) + host-mysql -> app/ + components.yaml + db wired', async () => {
    const reader = mockReader({ '/_contract': CONTRACT, '/backend/fastapi': FASTAPI });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws1');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: { ...common, projectType: 'web' as const, layout: 'single' as const, singleFragment: 'backend/fastapi', database: 'host-mysql' as const },
      workspacePath: ws,
    });

    await action.handler(ctx);

    // fragment code rendered into app/, ${{ }} substituted
    expect(await fs.readFile(path.join(ws, 'app/app/main.py'), 'utf8')).toBe('APP = "notes-api"\n');
    expect(await fs.readFile(path.join(ws, 'app/Dockerfile'), 'utf8')).toContain('# port 8080');
    // components.yaml computed from the plan
    const comps = await fs.readFile(path.join(ws, '.devops/components.yaml'), 'utf8');
    expect(comps).toContain('name: app');
    expect(comps).toContain('path: /');
    expect(comps).toContain('needsDb: true');
    // app-metadata carries the resolved db flag
    expect(await fs.readFile(path.join(ws, '.devops/app-metadata.yaml'), 'utf8')).toContain('database: mysql');
    // ci/** shipped VERBATIM (NOT templated)
    expect(await fs.readFile(path.join(ws, '.devops/ci/resolve.sh'), 'utf8')).toContain('${{ github.sha }}');
    // outputs
    expect(ctx.output).toHaveBeenCalledWith('database', 'mysql');
    expect(ctx.output).toHaveBeenCalledWith('dbWired', true);
    expect(ctx.output).toHaveBeenCalledWith('single', true);
  });

  it('frontend+backend -> frontend/ + backend/ dirs and two components', async () => {
    const reader = mockReader({ '/_contract': CONTRACT, '/frontend/react': REACT, '/backend/express': EXPRESS });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws2');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: { ...common, projectType: 'web' as const, layout: 'frontend-backend' as const, frontendFragment: 'frontend/react', backendFragment: 'backend/express', database: 'host-mysql' as const },
      workspacePath: ws,
    });

    await action.handler(ctx);

    expect(await fs.pathExists(path.join(ws, 'frontend/src/App.tsx'))).toBe(true);
    expect(await fs.pathExists(path.join(ws, 'backend/src/index.ts'))).toBe(true);
    const comps = await fs.readFile(path.join(ws, '.devops/components.yaml'), 'utf8');
    expect(comps).toContain('name: frontend');
    expect(comps).toContain('name: backend');
    expect(comps).toContain('path: /api');
    expect(ctx.output).toHaveBeenCalledWith('single', false);
  });

  it('renders the REAL shared _contract tree (incl. the empty .github/workflows/.gitkeep) without the Array-content crash', async () => {
    // Faithfully reproduces the live failure: the real contract ships a zero-byte
    // .gitkeep, which GithubUrlReader (concat-stream) resolves to [] (an Array), and the
    // VERBATIM branch then did fs.outputFile(dest, []) -> ERR_INVALID_ARG_TYPE. This
    // render path (composeProject's TS) had ZERO coverage — dry-render.py only tests the
    // pure composePlan.mjs — which is how it shipped.
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);

    // Guard: the regression is only exercised if the tree genuinely contains an empty
    // file whose content() is a non-Buffer Array. If the contract stops shipping one,
    // this test must be updated deliberately rather than silently passing on nothing.
    const emptyPaths: string[] = [];
    for (const e of contract) {
      if (!Buffer.isBuffer(await e.content())) emptyPaths.push(e.path);
    }
    expect(emptyPaths).toContain('.github/workflows/.gitkeep');

    const reader = treeReader({
      '/_contract': contract,
      '/backend/fastapi': asEntries(FASTAPI),
    });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('wsreal');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
      },
      workspacePath: ws,
    });

    // Pre-fix this REJECTS with "Received an instance of Array"; post-fix it resolves.
    await expect(action.handler(ctx)).resolves.toBeUndefined();

    // Every empty verbatim entry is written as a real (zero-byte) file — not dropped.
    for (const rel of emptyPaths) {
      expect(await fs.pathExists(path.join(ws, rel))).toBe(true);
      expect((await fs.readFile(path.join(ws, rel))).length).toBe(0);
    }
    // And a normal templated contract file still rendered with ${{ }} substitution.
    const meta = await fs.readFile(path.join(ws, '.devops/app-metadata.yaml'), 'utf8');
    expect(meta).toContain('app-name: notes-api');
    expect(meta).not.toContain('${{');
    // fileCount covers every contract file plus the fragment skeleton (nothing skipped).
    expect(ctx.output).toHaveBeenCalledWith('fileCount', contract.length + FASTAPI.length - 1);
  });

  it('progressive delivery (env-based): single-component base deployments.yaml is ALWAYS a plain Deployment (never a Rollout)', async () => {
    // Env-based progressive delivery (ADR-037): the base workload every env starts from is a
    // plain rolling-update Deployment. The canary lives ONLY in the prod overlay (next test).
    // Exercises the actual on-disk shared contract (not the minimal CONTRACT mock above).
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);
    const reader = treeReader({ '/_contract': contract, '/backend/fastapi': asEntries(FASTAPI) });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws-pd-base');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const base = await fs.readFile(path.join(ws, '.devops/chart/base/deployments.yaml'), 'utf8');
    expect(base).toContain('kind: Deployment');
    expect(base).toContain('apiVersion: apps/v1');
    // No canary/Rollout in the base — it is prod-overlay-only now.
    expect(base).not.toContain('kind: Rollout');
    expect(base).not.toContain('argoproj.io/v1alpha1');
    expect(base).not.toContain('setWeight: 25');
  });

  it('progressive delivery (env-based): single-component PROD overlay swaps the Deployment for an auto-completing canary Rollout', async () => {
    // The prod overlay ADDS rollout.yaml (the canary Rollout) and $patch:deletes the base
    // Deployment of the same name, so ONLY the Rollout runs in prod. Same Service selector, so
    // traffic routes. dev/staging/preview keep the plain Deployment.
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);
    const reader = treeReader({ '/_contract': contract, '/backend/fastapi': asEntries(FASTAPI) });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws-pd-prod');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    // The prod overlay ships the canary Rollout.
    const rollout = await fs.readFile(
      path.join(ws, '.devops/chart/overlays/prod/rollout.yaml'), 'utf8');
    expect(rollout).toContain('kind: Rollout');
    expect(rollout).toContain('apiVersion: argoproj.io/v1alpha1');
    // `setWeight: 25` only appears in the actual rendered strategy.canary block (never in prose
    // comments, unlike the word "canary" alone), so it's an unambiguous structural marker.
    expect(rollout).toContain('setWeight: 25');
    // The canary must AUTO-COMPLETE: timed pauses (`duration: 30s`) that advance on their own
    // and a terminal `setWeight: 100`, and NO bare indefinite `pause: {}` (which would park the
    // rollout forever with no argo-rollouts plugin to promote it).
    expect(rollout).toContain('duration: 30s');
    expect(rollout).toContain('setWeight: 100');
    expect(rollout).not.toContain('pause: {}');

    // The prod kustomization deletes the base Deployment (so only the Rollout remains) and
    // references rollout.yaml.
    const prodKz = await fs.readFile(
      path.join(ws, '.devops/chart/overlays/prod/kustomization.yaml'), 'utf8');
    expect(prodKz).toContain('rollout.yaml');
    expect(prodKz).toContain('$patch: delete');
    // The #340 replicas patch must target the Rollout GVK in prod (the builtin transformer
    // errors on a Rollout), so a Rollout tenant's prod overlay stays buildable.
    expect(prodKz).toContain('group: argoproj.io');
    expect(prodKz).toContain('kind: Rollout');

    // dev/staging/preview stay plain Deployments — no Rollout, no canary, no rollout.yaml ref.
    for (const env of ['dev', 'staging', 'preview']) {
      const kz = await fs.readFile(
        path.join(ws, `.devops/chart/overlays/${env}/kustomization.yaml`), 'utf8');
      expect(kz).not.toContain('rollout.yaml');
      expect(kz).not.toContain('group: argoproj.io');
      expect(kz).toContain('kind: Deployment');
    }
  });

  it('progressive delivery (env-based): frontend-backend stays plain Deployments in EVERY env, prod included (no Rollout)', async () => {
    // values.single is false for FE+BE, so the prod overlay does NOT delete Deployments or ship
    // a Rollout — multi-component apps stay plain Deployments everywhere (the Basic Canary is a
    // single-Service, single-component pattern). rollout.yaml renders comment-only + unreferenced.
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);
    const reader = treeReader({
      '/_contract': contract,
      '/frontend/react': asEntries(REACT),
      '/backend/express': asEntries(EXPRESS),
    });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws-pd-febe');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'frontend-backend' as const,
        frontendFragment: 'frontend/react',
        backendFragment: 'backend/express',
        database: 'none' as const,
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const base = await fs.readFile(path.join(ws, '.devops/chart/base/deployments.yaml'), 'utf8');
    const deploymentCount = (base.match(/kind: Deployment/g) || []).length;
    expect(deploymentCount).toBe(2);
    expect(base).not.toContain('kind: Rollout');

    // The prod overlay must NOT convert a multi-component app: no Deployment delete, no rollout ref.
    const prodKz = await fs.readFile(
      path.join(ws, '.devops/chart/overlays/prod/kustomization.yaml'), 'utf8');
    expect(prodKz).not.toContain('rollout.yaml');
    expect(prodKz).not.toContain('$patch: delete');
    expect(prodKz).not.toContain('group: argoproj.io');
    // rollout.yaml still renders (contract file) but contains no actual Rollout for FE+BE.
    const rollout = await fs.readFile(
      path.join(ws, '.devops/chart/overlays/prod/rollout.yaml'), 'utf8');
    expect(rollout).not.toContain('kind: Rollout');
    expect(rollout).not.toContain('setWeight: 25');
  });

  it('copies a binary fragment file (a committed .pyc) byte-for-byte instead of nunjucks-rendering it', async () => {
    // ROOT-CAUSE regression for the "Python single-webapp template fails" report: a stray
    // committed __pycache__/*.pyc under a fragment skeleton is BINARY and its body embeds
    // `{%` (pytest's assertion-rewrite format strings), so nunjucks threw
    // "tag name expected" on the compose step. The action must detect binary content (NUL
    // byte) / the __pycache__ path and ship it VERBATIM, never through env.renderString.
    const fastapiWithPyc: Entry[] = [
      ...asEntries(FASTAPI),
      { path: 'skeleton/app/__pycache__/main.cpython-314.pyc', content: async () => PYC_BYTES },
    ];
    const reader = treeReader({ '/_contract': asEntries(CONTRACT), '/backend/fastapi': fastapiWithPyc });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('wspyc');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
      },
      workspacePath: ws,
    });

    // Pre-fix this REJECTS with a nunjucks "tag name expected"; post-fix it resolves.
    await expect(action.handler(ctx)).resolves.toBeUndefined();

    // The .pyc was copied byte-for-byte — NUL + `{%` bytes preserved exactly, not rendered.
    const written = await fs.readFile(path.join(ws, 'app/app/__pycache__/main.cpython-314.pyc'));
    expect(written.equals(PYC_BYTES)).toBe(true);
    // The adjacent real .py source still rendered with ${{ }} substitution (text path intact).
    expect(await fs.readFile(path.join(ws, 'app/app/main.py'), 'utf8')).toBe('APP = "notes-api"\n');
  });

  it('renders a {#-using framework fragment (Svelte {#if}/{#each}) verbatim while still substituting ${{ }} and running {% %} — no {% raw %} wrapper needed', async () => {
    // The durable comment-delimiter fix: the engine's comment token is `{#!`/`!#}`, not the
    // stock `{#`/`#}`, so Svelte's `{#if}`/`{#each}` (and any other `{#`-using framework) pass
    // through untouched instead of being swallowed as comments. This is the follow-up to #342,
    // which wrapped the file in `{% raw %}` — that wrapper is now removed on disk and unneeded.
    const reader = mockReader({ '/_contract': CONTRACT, '/fullstack/sveltekit': SVELTE });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('wssvelte');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: { ...common, projectType: 'web' as const, layout: 'single' as const, singleFragment: 'fullstack/sveltekit', database: 'host-mysql' as const },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const rendered = await fs.readFile(path.join(ws, 'app/src/routes/items/+page.svelte'), 'utf8');
    // Svelte control blocks survive literally (pre-fix: eaten by the `{#` comment start).
    expect(rendered).toContain('{#if data.dbError}');
    expect(rendered).toContain('{:else if data.items.length === 0}');
    expect(rendered).toContain('{#each data.items as item (item.id)}');
    expect(rendered).toContain('{/each}');
    expect(rendered).toContain('{/if}');
    // The real ${{ }} variable still substitutes.
    expect(rendered).toContain("let appName = 'notes-api'");
    // The {% for %} block still runs (single plan -> one component named `app`).
    expect(rendered).toContain('<span>app</span>');
    // The new {#! … !#} comment is stripped, its body gone.
    expect(rendered).not.toContain('this comment must vanish');
    expect(rendered).not.toContain('{#!');
    // Literal `{'{ … }'}` braces (a Svelte idiom for printing a literal brace) untouched.
    expect(rendered).toContain('literal={\'{ "name": "..." }\'}');
  });

  /* -------------------------------------------------------------------------------------
   * ABSENT `database` — the Group (a) submission (board #139).
   *
   * WHY A SCHEMA TEST AND NOT ONLY A HANDLER TEST: `createMockActionContext` hands the input
   * straight to `handler()`; it does NOT run the action's zod/JSON schema. The real scaffolder
   * DOES — `createTemplateAction` runs the `z => …` map through zod-to-json-schema and the step
   * input is validated against that JSON Schema before `handler()` is ever called. So a
   * handler-only test that omits `database` passes even on the BROKEN code, which is exactly
   * how a suite where "every test passes `database` explicitly" hid this for so long. The
   * assertions below are on `action.schema.input` — the artefact that actually rejected the
   * submission — so they fail on the pre-fix action and pass on the fixed one.
   * ----------------------------------------------------------------------------------- */
  describe('#139: the wizard omits `database` for DB-less stacks', () => {
    const action = createComposeProjectAction({ reader: mockReader({}) });
    // `schema.input` is the JSON Schema createTemplateAction() derived from the `z => …` map
    // (zod-to-json-schema); narrow it to the two members these assertions read.
    const inputSchema = action.schema?.input as unknown as {
      required?: string[];
      properties?: Record<string, { type?: string; enum?: string[] }>;
    };

    it('exposes a derived JSON Schema at all (guards the assertions below from vacuity)', () => {
      expect(inputSchema).toBeDefined();
      expect(Object.keys(inputSchema.properties ?? {})).toContain('database');
    });

    it('does NOT list `database` as required (Group (a) sends no `database` key)', () => {
      // Pre-fix this array contains 'database', and the scaffolder rejects every
      // frontend/angular, static/bare-html and static/react-static submission with
      // "must have required property 'database'" before a single file is written.
      expect(inputSchema.required ?? []).not.toContain('database');
    });

    it('still constrains `database` to the four valid choices when it IS supplied', () => {
      // The enum is the guard that stops a typo'd DB choice reaching the CapstoneTenant claim
      // (where it fails much later and far less legibly). Optional must not mean permissive —
      // widening to z.string() would "fix" #139 by removing this.
      expect(inputSchema.properties?.database?.enum).toEqual([
        'host-mysql',
        'host-postgres',
        'bring-your-own',
        'none',
      ]);
    });

    it('keeps the genuinely-required identity inputs required', () => {
      // Guard against a blanket `.optional()` sweep: only `database` moves.
      expect(inputSchema.required ?? []).toEqual(
        expect.arrayContaining(['fragmentsUrl', 'projectType', 'appName', 'team', 'semester']),
      );
    });

    it('composes a static single-component project with NO database key at all', async () => {
      const reader = mockReader({ '/_contract': CONTRACT, '/static/bare-html': BARE_HTML });
      const staticAction = createComposeProjectAction({ reader });
      const ws = mockDir.resolve('ws139');
      await fs.ensureDir(ws);
      // NOTE the shape: `database` is absent entirely, not `database: 'none'`. This is the
      // literal step input the template produces for Group (a).
      const ctx = createMockActionContext({
        input: {
          ...common,
          projectType: 'web' as const,
          layout: 'single' as const,
          singleFragment: 'static/bare-html',
        },
        workspacePath: ws,
      });

      await staticAction.handler(ctx);

      expect(await fs.readFile(path.join(ws, 'app/index.html'), 'utf8')).toBe(
        '<title>notes-api</title>\n',
      );
      // The missing choice resolves to 'none' in the planner — no engine provisioned, nothing wired.
      expect(await fs.readFile(path.join(ws, '.devops/app-metadata.yaml'), 'utf8')).toContain(
        'database: none',
      );
      expect(ctx.output).toHaveBeenCalledWith('database', 'none');
      expect(ctx.output).toHaveBeenCalledWith('dbWired', false);
      expect(ctx.output).toHaveBeenCalledWith('single', true);
    });
  });

  it('fails closed on a bad appName', async () => {
    const action = createComposeProjectAction({ reader: mockReader({}) });
    await expect(
      action.handler(
        createMockActionContext({
          input: { ...common, appName: 'Bad_App', projectType: 'web', layout: 'single', singleFragment: 'backend/fastapi', database: 'none' },
          workspacePath: mockDir.resolve('wsbad'),
        }),
      ),
    ).rejects.toThrow(/invalid appName/);
  });
});
