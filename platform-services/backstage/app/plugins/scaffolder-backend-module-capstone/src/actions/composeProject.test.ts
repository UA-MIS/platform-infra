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

  it('progressive delivery: single + toggle on renders the REAL deployments.yaml as an Argo Rollouts Rollout with a canary strategy', async () => {
    // Exercises the actual on-disk shared contract (not the minimal CONTRACT mock above) so
    // this proves the real `{% if values.single and values.progressiveDelivery %}` gate in
    // .devops/chart/base/deployments.yaml, not just a test fixture.
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);
    const reader = treeReader({ '/_contract': contract, '/backend/fastapi': asEntries(FASTAPI) });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws-pd-on');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
        progressiveDelivery: true,
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const rendered = await fs.readFile(path.join(ws, '.devops/chart/base/deployments.yaml'), 'utf8');
    expect(rendered).toContain('kind: Rollout');
    expect(rendered).toContain('apiVersion: argoproj.io/v1alpha1');
    // `setWeight: 25` only appears in the actual rendered strategy.canary block (never in
    // prose comments, unlike the word "canary" alone), so it's an unambiguous structural marker.
    expect(rendered).toContain('setWeight: 25');
    // The canary must AUTO-COMPLETE: timed pauses (`duration: 30s`) that advance on their
    // own and a terminal `setWeight: 100`, and NO bare indefinite `pause: {}` (which would
    // park the rollout forever with no argo-rollouts plugin to promote it — the #meow bug).
    expect(rendered).toContain('duration: 30s');
    expect(rendered).toContain('setWeight: 100');
    expect(rendered).not.toContain('pause: {}');
    expect(rendered).not.toContain('kind: Deployment');
    expect(rendered).not.toContain('apiVersion: apps/v1');
  });

  it('progressive delivery: default (toggle omitted) still renders the REAL deployments.yaml as a plain Deployment', async () => {
    // The toggle is optional on the action input (Backstage sends parameters.progressiveDelivery
    // as a real boolean, but this guards the action's own default so a caller that omits it
    // entirely — e.g. an older cached template render — never silently gets a Rollout).
    const contract = await readContractWithReaderQuirk(CONTRACT_DIR);
    const reader = treeReader({ '/_contract': contract, '/backend/fastapi': asEntries(FASTAPI) });
    const action = createComposeProjectAction({ reader });
    const ws = mockDir.resolve('ws-pd-default');
    await fs.ensureDir(ws);
    const ctx = createMockActionContext({
      input: {
        ...common,
        projectType: 'web' as const,
        layout: 'single' as const,
        singleFragment: 'backend/fastapi',
        database: 'none' as const,
        // progressiveDelivery intentionally omitted
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const rendered = await fs.readFile(path.join(ws, '.devops/chart/base/deployments.yaml'), 'utf8');
    expect(rendered).toContain('kind: Deployment');
    expect(rendered).toContain('apiVersion: apps/v1');
    expect(rendered).not.toContain('kind: Rollout');
    expect(rendered).not.toContain('argoproj.io/v1alpha1');
    expect(rendered).not.toContain('setWeight: 25');
  });

  it('progressive delivery: toggle on but frontend-backend layout still renders plain Deployments for both components', async () => {
    // values.single is false for FE+BE, so the contract's gate (`values.single AND
    // values.progressiveDelivery`) must stay off even though the caller asked for the toggle.
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
        progressiveDelivery: true,
      },
      workspacePath: ws,
    });

    await action.handler(ctx);

    const rendered = await fs.readFile(path.join(ws, '.devops/chart/base/deployments.yaml'), 'utf8');
    const deploymentCount = (rendered.match(/kind: Deployment/g) || []).length;
    expect(deploymentCount).toBe(2);
    expect(rendered).not.toContain('kind: Rollout');
    expect(rendered).not.toContain('setWeight: 25');
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
