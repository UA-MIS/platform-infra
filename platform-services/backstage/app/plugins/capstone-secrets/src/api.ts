/*
 * The frontend client for the Secrets capability (M3, plan §3 frontend / §2.4 UX).
 *
 * WRITE-ONLY by contract: `listSecrets` returns key NAMES + last-updated ONLY (never values
 * — the backend reads filenames + git commit dates from the team repo, it never decrypts),
 * and `sealSecret` submits a value that is sealed-and-discarded server-side and returns only
 * the opened PR URLs. There is intentionally NO "get value" method.
 *
 * The default implementation talks to the capstone-secrets backend route (POST .../seal,
 * GET .../list) via the discovery + fetch APIs; auth is carried by fetchApi automatically
 * (the Backstage identity token), so the backend re-authorizes per request (the spine).
 */
import { createApiRef, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';

/** A listed secret — its key NAME + when it last changed. NEVER its value (write-only). */
export interface SecretSummary {
  key: string;
  /** Target env this entry exists in (dev/staging/prod). */
  env: string;
  /** ISO timestamp of the last commit that touched the ExternalSecret declaration, if known. */
  lastUpdated?: string;
}

export interface SealSecretRequest {
  entityRef: string;
  key: string;
  value: string;
  envs: string[];
}

export interface SealSecretResult {
  pullRequestUrls: string[];
}

/** A project the signed-in user can manage secrets for (the access-scoped picker). */
export interface ProjectSummary {
  entityRef: string;
  title: string;
  owner: string;
}

export interface DeleteSecretRequest {
  entityRef: string;
  key: string;
}

export interface DeleteSecretResult {
  pullRequestUrl: string;
}

export interface CapstoneSecretsApi {
  /** Projects (Components) the signed-in user can manage secrets for (labmx admin = all). */
  listMyProjects(): Promise<ProjectSummary[]>;
  /** List existing secret key names + last-updated for a Component's repo. Never values. */
  listSecrets(entityRef: string): Promise<SecretSummary[]>;
  /** Seal a secret and open the PR(s). The value is write-only; it is never returned. */
  sealSecret(request: SealSecretRequest): Promise<SealSecretResult>;
  /** Delete (un-seal) a secret key — opens a PR removing it. Not instant (PR-by-default). */
  deleteSecret(request: DeleteSecretRequest): Promise<DeleteSecretResult>;
}

export const capstoneSecretsApiRef = createApiRef<CapstoneSecretsApi>({
  id: 'plugin.capstone-secrets.service',
});

/** Default impl: REST against the capstone-secrets backend plugin route. */
export class CapstoneSecretsClient implements CapstoneSecretsApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('capstone-secrets');
  }

  async listMyProjects(): Promise<ProjectSummary[]> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/my-projects`);
    if (!res.ok) {
      throw new Error(
        `Failed to list projects (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { projects: ProjectSummary[] };
    return body.projects ?? [];
  }

  async listSecrets(entityRef: string): Promise<SecretSummary[]> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(
      `${base}/list?entityRef=${encodeURIComponent(entityRef)}`,
    );
    if (!res.ok) {
      throw new Error(
        `Failed to list secrets (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { secrets: SecretSummary[] };
    return body.secrets ?? [];
  }

  async sealSecret(request: SealSecretRequest): Promise<SealSecretResult> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/seal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      // Surface the backend's message (e.g. 403 not-owner) WITHOUT echoing the value.
      throw new Error(
        `Failed to seal secret (${res.status}): ${await res.text()}`,
      );
    }
    return (await res.json()) as SealSecretResult;
  }

  async deleteSecret(
    request: DeleteSecretRequest,
  ): Promise<DeleteSecretResult> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to delete secret (${res.status}): ${await res.text()}`,
      );
    }
    return (await res.json()) as DeleteSecretResult;
  }
}
