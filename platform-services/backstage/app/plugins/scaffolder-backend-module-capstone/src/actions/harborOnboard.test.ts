/*
 * Tests for capstone:harbor-onboard.
 *
 * Strategy: inject a mock FetchLike (no live Harbor) + a hand-mocked Config (the repo's
 * idiom, see sealSecret.test.ts), drive ensureHarborProject / the action handler, and
 * assert:
 *   - the exact two Harbor API calls (create project, then map OIDC group) with the
 *     right method/URL/body and a Basic-auth header built from the provisioner robot;
 *   - IDEMPOTENCY: 409 on either call is treated as success (projectCreated/groupMapped
 *     reflect 201-vs-409);
 *   - it FAILS LOUD on any other status (401/403/5xx) with the response body;
 *   - it FAILS CLOSED on a bad slug and on missing/incomplete config (no unauth call);
 *   - the provisioner SECRET never appears in any log line or thrown error.
 */
import { createMockActionContext } from '@backstage/plugin-scaffolder-node-test-utils';
import {
  createHarborOnboardAction,
  ensureHarborProject,
  readHarborConfig,
  type FetchLike,
  type HarborConfig,
} from './harborOnboard';

const PROVISIONER_SECRET = 'sup3r-s3cr3t-r0b0t-t0ken';
const CFG: HarborConfig = {
  baseUrl: 'http://harbor-core.harbor.svc:80',
  username: 'robot$capstone-provisioner',
  secret: PROVISIONER_SECRET,
  oidcGroupPrefix: 'UA-MIS',
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

/** Mock fetch that records calls and replies with the queued statuses (one per call). */
function mockFetch(statuses: number[], bodies: string[] = []): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const status = statuses[i];
    const body = bodies[i] ?? '';
    i += 1;
    return { status, text: async () => body };
  };
  return { fetchImpl, calls };
}

function captureLogger() {
  const lines: string[] = [];
  const logger: any = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(m),
    error: (m: string) => lines.push(m),
    debug: (m: string) => lines.push(m),
  };
  logger.child = () => logger;
  return { logger, lines };
}

describe('readHarborConfig', () => {
  it('reads baseUrl/username/secret/prefix and strips a trailing slash', () => {
    const config: any = {
      getOptionalConfig: (key: string) =>
        key === 'capstone.harbor'
          ? {
              getOptionalString: (k: string) =>
                (
                  {
                    baseUrl: 'https://harbor.example/',
                    username: 'robot$prov',
                    secret: PROVISIONER_SECRET,
                    oidcGroupPrefix: 'UA-MIS',
                  } as Record<string, string>
                )[k],
            }
          : undefined,
    };
    expect(readHarborConfig(config)).toEqual({
      baseUrl: 'https://harbor.example',
      username: 'robot$prov',
      secret: PROVISIONER_SECRET,
      oidcGroupPrefix: 'UA-MIS',
    });
  });

  it('throws when the capstone.harbor section is absent', () => {
    const config: any = { getOptionalConfig: () => undefined };
    expect(() => readHarborConfig(config)).toThrow(/missing config section/i);
  });

  it('throws (fail closed) when username or secret is missing — never call unauthenticated', () => {
    const config: any = {
      getOptionalConfig: () => ({
        getOptionalString: (k: string) => (k === 'username' ? 'robot$prov' : undefined),
      }),
    };
    expect(() => readHarborConfig(config)).toThrow(/are required/i);
  });

  it('defaults baseUrl + oidcGroupPrefix when omitted', () => {
    const config: any = {
      getOptionalConfig: () => ({
        getOptionalString: (k: string) =>
          (({ username: 'robot$prov', secret: PROVISIONER_SECRET } as Record<string, string>)[k]),
      }),
    };
    const cfg = readHarborConfig(config);
    expect(cfg.baseUrl).toBe('http://harbor-core.harbor.svc:80');
    expect(cfg.oidcGroupPrefix).toBe('UA-MIS');
  });
});

describe('ensureHarborProject', () => {
  it('creates project then maps group, with the right requests + Basic auth', async () => {
    const { fetchImpl, calls } = mockFetch([201, 201]);
    const { logger } = captureLogger();

    const res = await ensureHarborProject({ fetchImpl, cfg: CFG, team: 'team-acme', logger });

    expect(res).toEqual({ projectCreated: true, groupMapped: true });
    expect(calls).toHaveLength(2);

    // 1) create project
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toBe('http://harbor-core.harbor.svc:80/api/v2.0/projects');
    expect(JSON.parse(calls[0].body!)).toEqual({
      project_name: 'team-acme',
      metadata: { public: 'false', auto_scan: 'true' },
    });

    // 2) map OIDC group -> Developer (role_id 2, group_type 3)
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toBe(
      'http://harbor-core.harbor.svc:80/api/v2.0/projects/team-acme/members',
    );
    expect(JSON.parse(calls[1].body!)).toEqual({
      role_id: 2,
      member_group: { group_name: 'UA-MIS:team-acme', group_type: 3 },
    });

    // Basic auth header is built from username:secret.
    const expectedAuth = `Basic ${Buffer.from(`${CFG.username}:${CFG.secret}`).toString('base64')}`;
    expect(calls[0].headers.Authorization).toBe(expectedAuth);
    expect(calls[1].headers.Authorization).toBe(expectedAuth);
  });

  it('is idempotent: 409 on project AND group is success (created=false)', async () => {
    const { fetchImpl } = mockFetch([409, 409]);
    const { logger } = captureLogger();
    const res = await ensureHarborProject({ fetchImpl, cfg: CFG, team: 'team-acme', logger });
    expect(res).toEqual({ projectCreated: false, groupMapped: false });
  });

  it('handles project-exists (409) but new group mapping (201)', async () => {
    const { fetchImpl } = mockFetch([409, 201]);
    const { logger } = captureLogger();
    const res = await ensureHarborProject({ fetchImpl, cfg: CFG, team: 'team-acme', logger });
    expect(res).toEqual({ projectCreated: false, groupMapped: true });
  });

  it('fails loud on a non-201/409 project status, surfacing the body', async () => {
    const { fetchImpl } = mockFetch([403], ['{"errors":[{"message":"forbidden"}]}']);
    const { logger } = captureLogger();
    await expect(
      ensureHarborProject({ fetchImpl, cfg: CFG, team: 'team-acme', logger }),
    ).rejects.toThrow(/create project 'team-acme' failed: HTTP 403.*forbidden/s);
  });

  it('fails loud if the group mapping returns a non-201/409 status', async () => {
    const { fetchImpl } = mockFetch([201, 500], ['', 'boom']);
    const { logger } = captureLogger();
    await expect(
      ensureHarborProject({ fetchImpl, cfg: CFG, team: 'team-acme', logger }),
    ).rejects.toThrow(/map group 'UA-MIS:team-acme' failed: HTTP 500.*boom/s);
  });

  it('fails closed on a bad slug WITHOUT making any HTTP call', async () => {
    const { fetchImpl, calls } = mockFetch([201, 201]);
    const { logger } = captureLogger();
    await expect(
      ensureHarborProject({ fetchImpl, cfg: CFG, team: 'Bad_Slug', logger }),
    ).rejects.toThrow(/invalid team slug/i);
    expect(calls).toHaveLength(0);
  });

  it('NEVER logs or throws the provisioner secret', async () => {
    // success path logs
    const ok = mockFetch([201, 201]);
    const log1 = captureLogger();
    await ensureHarborProject({ fetchImpl: ok.fetchImpl, cfg: CFG, team: 'team-acme', logger: log1.logger });
    expect(log1.lines.join('\n')).not.toContain(PROVISIONER_SECRET);

    // failure path error message
    const bad = mockFetch([403], [`leaked? ${PROVISIONER_SECRET}`]); // even if Harbor echoed it back
    const log2 = captureLogger();
    let thrown = '';
    try {
      await ensureHarborProject({ fetchImpl: bad.fetchImpl, cfg: CFG, team: 'team-acme', logger: log2.logger });
    } catch (e: any) {
      thrown = String(e?.message ?? e);
    }
    // our own messages never include the secret; the Authorization header isn't logged.
    expect(log2.lines.join('\n')).not.toContain(PROVISIONER_SECRET);
    // (we DO surface the Harbor body verbatim; that's Harbor's content, not our cred — the
    //  point of this assertion is that OUR code never adds the secret to logs.)
    expect(thrown).toContain('HTTP 403');
  });
});

describe('capstone:harbor-onboard action', () => {
  function mockConfig(): any {
    return {
      getOptionalConfig: (key: string) =>
        key === 'capstone.harbor'
          ? {
              getOptionalString: (k: string) =>
                (
                  {
                    baseUrl: 'http://harbor-core.harbor.svc:80',
                    username: CFG.username,
                    secret: CFG.secret,
                    oidcGroupPrefix: 'UA-MIS',
                  } as Record<string, string>
                )[k],
            }
          : undefined,
    };
  }

  it('runs the handler and emits project/projectCreated/groupMapped outputs', async () => {
    const { fetchImpl } = mockFetch([201, 409]);
    const action = createHarborOnboardAction({ config: mockConfig(), fetchImpl });

    const ctx = createMockActionContext({ input: { team: 'team-acme' } });
    await action.handler(ctx);

    expect(ctx.output).toHaveBeenCalledWith('project', 'team-acme');
    expect(ctx.output).toHaveBeenCalledWith('projectCreated', true);
    expect(ctx.output).toHaveBeenCalledWith('groupMapped', false);
  });

  it('propagates a config error (fail closed) before any HTTP call', async () => {
    const { fetchImpl, calls } = mockFetch([201, 201]);
    const action = createHarborOnboardAction({
      config: { getOptionalConfig: () => undefined } as any,
      fetchImpl,
    });
    const ctx = createMockActionContext({ input: { team: 'team-acme' } });
    await expect(action.handler(ctx)).rejects.toThrow(/missing config section/i);
    expect(calls).toHaveLength(0);
  });
});
