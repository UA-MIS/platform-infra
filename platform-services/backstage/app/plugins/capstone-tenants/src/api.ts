/*
 * The frontend client for the admin Tenant Teardown capability.
 *
 * Talks to the capstone-tenants backend route (GET .../tenants, POST .../teardown) via the
 * discovery + fetch APIs; auth is carried by fetchApi automatically (the Backstage identity
 * token), so the backend re-authorizes ADMIN-ONLY per request (teardownCore.requireAdmin).
 *
 * Teardown is NOT instant: `teardownTenant` opens a PR removing the tenant's CapstoneTenant
 * claim file and returns the PR URL. Merging that PR is what triggers the Crossplane cascade
 * that actually frees cluster resources — the UI communicates this explicitly.
 */
import { createApiRef, DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';

/** A provisioned tenant (one CapstoneTenant claim) shown in the admin list. */
export interface TenantSummary {
  /** `<team>-<appName>` — the claim's name AND the delete key (type-to-confirm target). */
  name: string;
  team: string;
  appName: string;
  semester: string;
  /** Provisioned database engine (none|mysql|postgres), if declared. */
  database?: string;
  /** Repo-relative path of the claim file the teardown PR removes. */
  claimPath: string;
}

export interface TeardownRequest {
  /** The tenant `name` to tear down. */
  name: string;
  /** Type-to-confirm text — MUST equal `name` (the server re-checks, fail-closed). */
  confirmName: string;
  /** Also archive the tenant's GitHub app repo (UA-MIS/<appName>). */
  archiveRepo?: boolean;
}

export interface TeardownResult {
  /** The PR removing the claim. Merge it to start the cascade. */
  pullRequestUrl: string;
  /** The claim file the PR removes. */
  claimPath: string;
  /** Whether the app repo was archived. */
  repoArchived: boolean;
}

export interface CapstoneTenantsApi {
  /** List the live provisioned tenants (admin-only server-side). */
  listTenants(): Promise<TenantSummary[]>;
  /** Tear down a tenant — opens a PR removing its claim; not instant (cascade on merge). */
  teardownTenant(request: TeardownRequest): Promise<TeardownResult>;
}

export const capstoneTenantsApiRef = createApiRef<CapstoneTenantsApi>({
  id: 'plugin.capstone-tenants.service',
});

/** Default impl: REST against the capstone-tenants backend plugin route. */
export class CapstoneTenantsClient implements CapstoneTenantsApi {
  private readonly discoveryApi: DiscoveryApi;
  private readonly fetchApi: FetchApi;

  constructor(options: { discoveryApi: DiscoveryApi; fetchApi: FetchApi }) {
    this.discoveryApi = options.discoveryApi;
    this.fetchApi = options.fetchApi;
  }

  private async baseUrl(): Promise<string> {
    return this.discoveryApi.getBaseUrl('capstone-tenants');
  }

  async listTenants(): Promise<TenantSummary[]> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/tenants`);
    if (!res.ok) {
      throw new Error(
        `Failed to list tenants (${res.status}): ${await res.text()}`,
      );
    }
    const body = (await res.json()) as { tenants: TenantSummary[] };
    return body.tenants ?? [];
  }

  async teardownTenant(request: TeardownRequest): Promise<TeardownResult> {
    const base = await this.baseUrl();
    const res = await this.fetchApi.fetch(`${base}/teardown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      // Surface the backend's message (e.g. 403 not-admin, 400 confirm mismatch).
      throw new Error(
        `Failed to tear down tenant (${res.status}): ${await res.text()}`,
      );
    }
    return (await res.json()) as TeardownResult;
  }
}
