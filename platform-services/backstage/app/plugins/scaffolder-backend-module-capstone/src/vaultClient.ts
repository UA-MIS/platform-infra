/*
 * vaultClient — the minimal HashiCorp Vault KV-v2 client the secrets-UX uses to WRITE secret
 * material (ADR-030 B1 / ESO model). This is the "no secret in git" half of the rework: the
 * plaintext VALUE lands in Vault here; only an `ExternalSecret` declaration (key NAMES +
 * remoteRef pointers, NO values) is committed to the tenant repo by sealCore.
 *
 * AUTH: Backstage authenticates to Vault with its OWN Kubernetes ServiceAccount JWT
 * (a projected token with audience=vault, mounted by the deploy at saTokenPath) via k8s-auth
 * (POST /v1/auth/<mount>/login {jwt, role}) and uses the returned client_token for the KV-v2
 * call. The Vault role `backstage-writer` (eso-vault domain, vault-policies) binds ONLY the
 * dedicated Backstage SA (backstage-vault-writer) to a write-scoped policy over
 * secret/data/tenants/* (create/update/read/patch) — least privilege. The token can write ANY
 * tenant path (coarse by design); per-tenant authz is enforced in sealCore BEFORE the write.
 *
 * SECURITY INVARIANTS (mirror sealCore R2): the plaintext VALUE is only ever in the request
 * BODY (never an argv, never a path, never a log line); the client_token + the value are NEVER
 * logged or placed in a thrown error (errors surface Vault's status + the path, never the
 * body); TLS is verified against the Vault CA bundle (node:https `ca` option). List returns
 * KEY NAMES only — the value bytes never leave this module on the read path.
 *
 * Uses node:https directly (not fetch): native fetch cannot take a per-request CA, and we add
 * NO new dependency. The single httpsRequest() seam is what the unit tests mock.
 */
import { readFile } from 'fs/promises';
import { request as httpsRequest } from 'https';

/** Resolved Vault connection config (from capstone.secrets.vault.*). */
export interface VaultClientConfig {
  /** Vault base address, e.g. https://vault.vault.svc.cluster.local:8200 . */
  addr: string;
  /** KV-v2 mount, e.g. "secret". */
  mount: string;
  /** k8s-auth mount path, e.g. "kubernetes". */
  authMount: string;
  /** Vault k8s-auth role bound to the Backstage SA, e.g. "backstage-secrets". */
  role: string;
  /** Path to the projected SA JWT (default the standard projected-token path). */
  saTokenPath: string;
  /** Path to the PEM CA bundle that signed the Vault server cert (TLS verify). */
  caPath: string;
}

/** A raw Vault HTTP response: status + parsed JSON body (or undefined for an empty body). */
interface VaultResponse {
  status: number;
  body: unknown;
}

/**
 * A tiny Vault KV-v2 client. One instance per request is fine (it logs in lazily and caches
 * the short-lived token for the lifetime of the instance only). All write/read methods throw
 * on an unexpected non-2xx Vault response with the status + path (NEVER the body) in the
 * message.
 */
export class VaultClient {
  private token?: string;
  private ca?: string;

  constructor(private readonly cfg: VaultClientConfig) {}

  /** One HTTPS request to Vault, TLS-verified against the configured CA. Never logs the body. */
  private async httpRequest(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<VaultResponse> {
    if (this.ca === undefined) {
      this.ca = await readFile(this.cfg.caPath, 'utf8');
    }
    const url = new URL(`${this.cfg.addr}${path}`);
    return new Promise<VaultResponse>((resolve, reject) => {
      const req = httpsRequest(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            ...headers,
            ...(body !== undefined
              ? { 'content-length': Buffer.byteLength(body).toString() }
              : {}),
          },
          ca: this.ca, // verify the Vault server cert against the platform CA
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', c => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode ?? 0, body: parsed });
          });
        },
      );
      // NB: never include `body` in the error — it may carry the plaintext value (R2).
      req.on('error', err =>
        reject(new Error(`Vault request to ${path} failed: ${err.message}`)),
      );
      if (body !== undefined) {
        req.write(body);
      }
      req.end();
    });
  }

  /**
   * Log in via k8s auth (SA JWT -> client_token) and cache the token on this instance.
   * The JWT + the client_token are NEVER logged. Throws with status only on failure.
   */
  private async login(): Promise<string> {
    if (this.token) {
      return this.token;
    }
    const jwt = (await readFile(this.cfg.saTokenPath, 'utf8')).trim();
    const res = await this.httpRequest(
      'POST',
      `/v1/auth/${this.cfg.authMount}/login`,
      { 'content-type': 'application/json' },
      JSON.stringify({ jwt, role: this.cfg.role }),
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Vault k8s-auth login failed (HTTP ${res.status}) for role ` +
          `"${this.cfg.role}" at ${this.cfg.authMount}/login.`,
      );
    }
    const token = (res.body as { auth?: { client_token?: string } } | undefined)
      ?.auth?.client_token;
    if (!token) {
      throw new Error('Vault login returned no client_token.');
    }
    this.token = token;
    return token;
  }

  /**
   * Set (create or rotate) ONE key at a KV-v2 path WITHOUT disturbing the other keys, via a
   * JSON merge-patch (PATCH application/merge-patch+json {data:{<key>:<value>}}). The value is
   * only in the request body. If the path does not exist yet, Vault PATCH 404/405s — we fall
   * back to a create (POST {data:{<key>:<value>}}). Returns nothing (write-only).
   */
  async setKey(secretPath: string, key: string, value: string): Promise<void> {
    const token = await this.login();
    const dataPath = `/v1/${this.cfg.mount}/data/${secretPath}`;
    const res = await this.httpRequest(
      'PATCH',
      dataPath,
      {
        'x-vault-token': token,
        'content-type': 'application/merge-patch+json',
      },
      JSON.stringify({ data: { [key]: value } }),
    );
    if (res.status >= 200 && res.status < 300) {
      return;
    }
    // PATCH fails (404/405) when the path has no existing version — create it instead.
    if (res.status === 404 || res.status === 405) {
      const createRes = await this.httpRequest(
        'POST',
        dataPath,
        { 'x-vault-token': token, 'content-type': 'application/json' },
        JSON.stringify({ data: { [key]: value } }),
      );
      if (createRes.status < 200 || createRes.status >= 300) {
        throw new Error(
          `Vault KV-v2 create failed (HTTP ${createRes.status}) at ` +
            `${this.cfg.mount}/data/${secretPath}.`,
        );
      }
      return;
    }
    throw new Error(
      `Vault KV-v2 patch failed (HTTP ${res.status}) at ` +
        `${this.cfg.mount}/data/${secretPath}.`,
    );
  }

  /**
   * Delete ONE key from a KV-v2 path via a merge-patch that sets it to null (JSON merge-patch
   * removes a key whose value is null) — the other keys are preserved. A 404 path is a no-op
   * (nothing to delete). Returns nothing.
   */
  async deleteKey(secretPath: string, key: string): Promise<void> {
    const token = await this.login();
    const dataPath = `/v1/${this.cfg.mount}/data/${secretPath}`;
    const res = await this.httpRequest(
      'PATCH',
      dataPath,
      {
        'x-vault-token': token,
        'content-type': 'application/merge-patch+json',
      },
      JSON.stringify({ data: { [key]: null } }),
    );
    if ((res.status >= 200 && res.status < 300) || res.status === 404) {
      return;
    }
    throw new Error(
      `Vault KV-v2 delete-key failed (HTTP ${res.status}) at ` +
        `${this.cfg.mount}/data/${secretPath}.`,
    );
  }

  /**
   * List the KEY NAMES present at a KV-v2 path — NAMES ONLY (the value bytes are read from
   * Vault to enumerate the map keys but are NEVER returned to the caller; this preserves the
   * write-only contract). A 404 path returns [] (nothing set yet).
   */
  async listKeys(secretPath: string): Promise<string[]> {
    const token = await this.login();
    const res = await this.httpRequest(
      'GET',
      `/v1/${this.cfg.mount}/data/${secretPath}`,
      { 'x-vault-token': token },
    );
    if (res.status === 404) {
      return [];
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `Vault KV-v2 read failed (HTTP ${res.status}) at ` +
          `${this.cfg.mount}/data/${secretPath}.`,
      );
    }
    const data = (
      res.body as { data?: { data?: Record<string, unknown> } } | undefined
    )?.data?.data;
    // Return ONLY the key names — never the values.
    return Object.keys(data ?? {});
  }
}
