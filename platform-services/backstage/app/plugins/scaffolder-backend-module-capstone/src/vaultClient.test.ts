/*
 * Unit tests for VaultClient (the KV-v2 write path of the ESO secrets rework).
 *
 * SECURITY-CRITICAL ASSERTIONS:
 *  - the SA JWT + the client_token are forwarded as designed (login -> x-vault-token), and the
 *    plaintext VALUE is only ever in the request BODY (never a header value, never logged),
 *  - setKey rotates one key (merge-patch) and falls back to create on a 404/405 path,
 *  - deleteKey uses a merge-patch null and treats 404 as a no-op,
 *  - listKeys returns KEY NAMES ONLY (never the values), and [] on 404,
 *  - errors carry the HTTP status + path but NEVER the request body (no value leak).
 *
 * We mock node:https (the single httpRequest seam) + fs/promises (token + CA reads).
 */

// ── Mock fs/promises: SA token + CA file reads ───────────────────────────────────────────
jest.mock('fs/promises', () => ({
  readFile: jest.fn(async (p: string) => {
    if (p.endsWith('/token')) return 'SA-JWT-TOKEN';
    if (p.endsWith('ca.crt')) return 'CA-PEM';
    return '';
  }),
}));

// ── Mock node:https.request: record each call, return a queued canned response ─────────────
type HttpCall = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
  ca?: string;
};
const httpCalls: HttpCall[] = [];
let responseQueue: Array<{ status: number; json?: unknown }> = [];

jest.mock('https', () => ({
  request: jest.fn(
    (
      opts: {
        method: string;
        path: string;
        headers: Record<string, string>;
        ca?: string;
      },
      cb: (res: any) => void,
    ) => {
      let body: string | undefined;
      const handlers: Record<string, (chunk?: Buffer) => void> = {};
      const req = {
        on: (_e: string, _h: (e: Error) => void) => req,
        write: (data: string) => {
          body = data;
        },
        end: () => {
          httpCalls.push({
            method: opts.method,
            path: opts.path,
            headers: opts.headers,
            body,
            ca: opts.ca,
          });
          const next = responseQueue.shift() ?? { status: 200, json: {} };
          const text =
            next.json !== undefined ? JSON.stringify(next.json) : '';
          const res = {
            statusCode: next.status,
            on: (event: string, h: (chunk?: Buffer) => void) => {
              handlers[event] = h;
              return res;
            },
          };
          cb(res);
          if (text) handlers.data?.(Buffer.from(text, 'utf8'));
          handlers.end?.();
        },
      };
      return req;
    },
  ),
}));

// eslint-disable-next-line import/first
import { VaultClient, type VaultClientConfig } from './vaultClient';

const CFG: VaultClientConfig = {
  addr: 'https://vault.vault.svc.cluster.local:8200',
  mount: 'secret',
  authMount: 'kubernetes',
  role: 'backstage-secrets',
  saTokenPath: '/var/run/secrets/kubernetes.io/serviceaccount/token',
  caPath: '/etc/backstage/vault-ca/ca.crt',
};

/** Queue the login response (a client_token) + the given operation responses. */
function queue(...responses: Array<{ status: number; json?: unknown }>) {
  responseQueue = [
    { status: 200, json: { auth: { client_token: 'VAULT-CLIENT-TOKEN' } } },
    ...responses,
  ];
}

beforeEach(() => {
  httpCalls.length = 0;
  responseQueue = [];
});

describe('VaultClient login', () => {
  it('logs in via k8s auth with the SA JWT + role, then uses the client_token', async () => {
    queue({ status: 204 });
    const c = new VaultClient(CFG);
    await c.setKey('tenants/t/dev/app', 'K', 'v');

    const login = httpCalls[0];
    expect(login.method).toBe('POST');
    expect(login.path).toBe('/v1/auth/kubernetes/login');
    expect(JSON.parse(login.body!)).toEqual({
      jwt: 'SA-JWT-TOKEN',
      role: 'backstage-secrets',
    });
    // The CA bundle is passed for TLS verification.
    expect(login.ca).toBe('CA-PEM');
    // The KV write carries the client_token.
    expect(httpCalls[1].headers['x-vault-token']).toBe('VAULT-CLIENT-TOKEN');
  });

  it('caches the token across calls (one login per instance)', async () => {
    queue({ status: 204 }, { status: 204 });
    const c = new VaultClient(CFG);
    await c.setKey('tenants/t/dev/app', 'A', '1');
    await c.setKey('tenants/t/dev/app', 'B', '2');
    const logins = httpCalls.filter(h => h.path.endsWith('/login'));
    expect(logins).toHaveLength(1);
  });

  it('throws (status only) on a login failure', async () => {
    responseQueue = [{ status: 403 }];
    const c = new VaultClient(CFG);
    await expect(c.setKey('tenants/t/dev/app', 'K', 'v')).rejects.toThrow(
      /login failed \(HTTP 403\)/,
    );
  });
});

describe('VaultClient setKey', () => {
  it('patches one key (merge-patch) with the value ONLY in the body', async () => {
    queue({ status: 204 });
    const c = new VaultClient(CFG);
    await c.setKey('tenants/t/dev/app', 'DATABASE_URL', 'postgres://secret');

    const patch = httpCalls[1];
    expect(patch.method).toBe('PATCH');
    expect(patch.path).toBe('/v1/secret/data/tenants/t/dev/app');
    expect(patch.headers['content-type']).toBe('application/merge-patch+json');
    expect(JSON.parse(patch.body!)).toEqual({
      data: { DATABASE_URL: 'postgres://secret' },
    });
    // The value is NOT in any header.
    expect(JSON.stringify(patch.headers)).not.toContain('postgres://secret');
  });

  it('falls back to POST create when the path does not exist yet (404)', async () => {
    queue({ status: 404 }, { status: 200, json: {} });
    const c = new VaultClient(CFG);
    await c.setKey('tenants/t/dev/app', 'K', 'v');

    expect(httpCalls[1].method).toBe('PATCH');
    const create = httpCalls[2];
    expect(create.method).toBe('POST');
    expect(create.headers['content-type']).toBe('application/json');
    expect(JSON.parse(create.body!)).toEqual({ data: { K: 'v' } });
  });

  it('throws (status + path, no body) on a patch error', async () => {
    queue({ status: 500 });
    const c = new VaultClient(CFG);
    const err = await c
      .setKey('tenants/t/dev/app', 'K', 'super-secret')
      .then(() => undefined as unknown as Error)
      .catch((e: Error) => e);
    expect(err.message).toMatch(/patch failed \(HTTP 500\)/);
    expect(err.message).toContain('secret/data/tenants/t/dev/app');
    expect(err.message).not.toContain('super-secret');
  });
});

describe('VaultClient deleteKey', () => {
  it('merge-patches the key to null (removing it; other keys preserved)', async () => {
    queue({ status: 204 });
    const c = new VaultClient(CFG);
    await c.deleteKey('tenants/t/dev/app', 'OLD_KEY');

    const patch = httpCalls[1];
    expect(patch.method).toBe('PATCH');
    expect(patch.headers['content-type']).toBe('application/merge-patch+json');
    expect(JSON.parse(patch.body!)).toEqual({ data: { OLD_KEY: null } });
  });

  it('treats a 404 path as a no-op (nothing to delete)', async () => {
    queue({ status: 404 });
    const c = new VaultClient(CFG);
    await expect(c.deleteKey('tenants/t/dev/app', 'K')).resolves.toBeUndefined();
  });
});

describe('VaultClient listKeys', () => {
  it('returns the key NAMES only — never the values', async () => {
    queue({
      status: 200,
      json: {
        data: { data: { DATABASE_URL: 'postgres://secret', API_KEY: 'abc' } },
      },
    });
    const c = new VaultClient(CFG);
    const keys = await c.listKeys('tenants/t/dev/app');

    expect(keys.sort()).toEqual(['API_KEY', 'DATABASE_URL']);
    // None of the recorded requests returned a value to the caller; the values stay in Vault.
    // (We assert the contract: listKeys returns only strings that are the map KEYS.)
    expect(keys).not.toContain('postgres://secret');
    expect(keys).not.toContain('abc');
  });

  it('returns [] for a path that does not exist yet (404)', async () => {
    queue({ status: 404 });
    const c = new VaultClient(CFG);
    await expect(c.listKeys('tenants/t/dev/app')).resolves.toEqual([]);
  });
});
