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
