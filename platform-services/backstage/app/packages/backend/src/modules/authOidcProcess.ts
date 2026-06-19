/*
 * Custom OIDC auth provider module for "The Process".
 *
 * Why a custom module (not the stock @backstage/plugin-auth-backend-module-oidc-provider
 * with a config resolver): the stock OIDC module only ships email-based config resolvers
 * (emailLocalPartMatchingUserEntityName, emailMatchingUserEntityProfileEmail). The Process
 * signs in via the shared Dex broker, which emits the GitHub login as `preferred_username`
 * (Dex `useLoginAsID`). M1 resolves that login -> a Backstage User entity.
 *
 * M2 TIGHTENS THE RESOLVER (this is the linchpin of the permission spine, see
 * artifacts/planning/M2-github-teams-visibility-plan.md §3.1). M1 used a catalog FALLBACK
 * (dangerousEntityRefFallback) because the seed catalog had only placeholder Users. That
 * fallback minted a synthetic identity whose ownershipEntityRefs carried ONLY the user's
 * own ref -- NO group memberships -- which would make the M2 permission policy inert
 * (everyone denied, no admin). M2 removes the fallback and resolves STRICTLY to a real
 * ingested catalog User (GitHub-org ingestion, see authOidcProcess's sibling githubOrg
 * provider) so Backstage derives ownershipEntityRefs from the User's spec.memberOf (the
 * GitHub teams) -> the policy's isEntityOwner({ claims }) becomes meaningful.
 *
 * BEHAVIOR CHANGE (acknowledged): a Dex-authenticated UA-MIS member who is NOT on any
 * ingested team can no longer sign in (signInWithCatalogUser throws "no matching entity").
 * This is the correct tightening; all real students are on a project team, and admins
 * (labmx) are org members on an ingested team so they resolve normally. Org gating remains
 * enforced UPSTREAM at Dex (SEC-007); Backstage trusts the broker for org membership.
 *
 * The provider id MUST be "oidc" so it matches auth.providers.oidc in app-config and the
 * Dex redirect URI (/api/auth/oidc/handler/frame). A code-defined signInResolver takes
 * effect only when app-config carries NO auth.providers.oidc.<env>.signIn.resolvers list
 * (config resolvers win) -- so app-config.production.yaml omits that list on purpose.
 */
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import type { AuthService } from '@backstage/backend-plugin-api';
import {
  authProvidersExtensionPoint,
  createOAuthProviderFactory,
  OAuthAuthenticatorResult,
  SignInResolver,
  SignInInfo,
  AuthResolverContext,
} from '@backstage/plugin-auth-node';
import {
  oidcAuthenticator,
  OidcAuthResult,
} from '@backstage/plugin-auth-backend-module-oidc-provider';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import type { CatalogService } from '@backstage/plugin-catalog-node';
import { stringifyEntityRef } from '@backstage/catalog-model';

/**
 * Catalog-lookup retry tuning. The sign-in catalog lookup is an in-process loopback call
 * (http://localhost:7007/api/catalog/...) that has been observed to intermittently drop
 * mid-response ("Premature close") under loopback connection churn — NOT a logic error and
 * NOT resource pressure (the entity is present + the endpoint is fast). A small
 * retry-with-backoff makes sign-in resilient: it succeeds on a later attempt regardless of
 * the underlying socket churn. Kept tiny so a genuinely-missing user still fails quickly.
 */
const LOOKUP_MAX_ATTEMPTS = 3;
const LOOKUP_BACKOFF_MS = 150;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * True for errors worth retrying: transient connection/stream drops on the internal catalog
 * call. A real "User not found" (the user genuinely isn't ingested) is NOT retryable — we
 * surface it immediately so a non-member fails fast (the §3.1 tightening).
 */
function isRetryableLookupError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'NotFoundError') {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /premature close|socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|network|fetch failed|terminated/i.test(
    message,
  );
}

/**
 * Run `fn` up to LOOKUP_MAX_ATTEMPTS times, retrying only transient lookup errors with a
 * short linear backoff. Re-throws a non-retryable error immediately; after the final failed
 * attempt re-throws the last error (the caller wraps it with context).
 */
async function withLookupRetry<T>(
  fn: () => Promise<T>,
  login: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= LOOKUP_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableLookupError(error) || attempt === LOOKUP_MAX_ATTEMPTS) {
        throw error;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[authOidcProcess] catalog lookup attempt ${attempt}/${LOOKUP_MAX_ATTEMPTS} for ` +
          `login=${login} failed transiently (${
            (error as Error)?.message
          }); retrying in ${LOOKUP_BACKOFF_MS * attempt}ms`,
      );
      await sleep(LOOKUP_BACKOFF_MS * attempt);
    }
  }
  throw lastError;
}

/**
 * F1 — relations-lag fix (the ownership augmentation).
 *
 * `ctx.resolveOwnershipEntityRefs(user)` derives ownership from the User's COMPUTED
 * `memberOf` relations. Those relations are stitched by the catalog AFTER raw ingestion
 * (from each Group's `spec.members`), so for a large org (144 groups) they can LAG the
 * initial commit — during that window the User has no group relations, so a fresh login
 * (e.g. a `labmx` admin) resolves with ZERO groups: admin-override never fires and the user
 * sees nothing. This bug self-heals once relation-stitching completes, but it makes admin
 * look broken on a clean sign-in (D-027). To make membership recognized AS SOON AS the
 * Group entities exist (independent of relation lag), we ALSO query Groups whose raw
 * `spec.members` lists this login and union them into the ownership claims.
 *
 * Fully GUARDED: this is an AUGMENTATION on top of the standard refs — if the Group query
 * fails for any reason it degrades to the standard refs, so F1 can never break sign-in.
 * Returns the extra group refs (e.g. ["group:default/labmx", ...]) to union in.
 */
async function resolveGroupsByMembership(
  login: string,
  catalog: CatalogService,
  auth: AuthService,
): Promise<string[]> {
  try {
    const userRef = stringifyEntityRef({
      kind: 'User',
      namespace: 'default',
      name: login,
    });
    const { items } = await catalog.getEntities(
      {
        // Match Groups that list this user directly. `spec.members` is the RAW field
        // (populated at ingestion, no relation stitching); `relations.hasMember` is the
        // computed form. Filter entries are OR'd, so we catch either representation —
        // whichever is available first — and the username-vs-ref forms members may take.
        filter: [
          { kind: 'Group', 'spec.members': login },
          { kind: 'Group', 'spec.members': userRef },
          { kind: 'Group', 'relations.hasMember': userRef },
        ],
        fields: ['kind', 'metadata.name', 'metadata.namespace'],
      },
      { credentials: await auth.getOwnServiceCredentials() },
    );
    return items.map(group => stringifyEntityRef(group));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(
      `[authOidcProcess] F1 group-membership lookup failed for login=${login} ` +
        `(${(error as Error)?.message}); falling back to standard ownership refs`,
    );
    return [];
  }
}

/**
 * The Dex sign-in resolver, as a FACTORY so the catalog + auth services can be injected
 * (needed for the F1 group-membership augmentation). Resolves the OIDC profile's GitHub
 * login (Dex preferred_username, on OidcAuthResult.userinfo) to a REAL ingested catalog
 * User; throws if none exists. Unit-testable: pass mock catalog/auth (or omit for the
 * lookup-only paths).
 */
export function createProcessOidcSignInResolver(deps: {
  catalog: CatalogService;
  auth: AuthService;
}): SignInResolver<OAuthAuthenticatorResult<OidcAuthResult>> {
  const { catalog, auth } = deps;
  return async (
    info: SignInInfo<OAuthAuthenticatorResult<OidcAuthResult>>,
    ctx: AuthResolverContext,
  ) => {
    // Dex emits the GitHub login as preferred_username (useLoginAsID).
    const userinfo = info.result.fullProfile.userinfo;
    const rawLogin =
      (userinfo.preferred_username as string | undefined) ??
      (userinfo.name as string | undefined) ??
      userinfo.sub;

    if (!rawLogin) {
      throw new Error(
        'OIDC profile is missing preferred_username / name / sub; cannot resolve a Backstage user.',
      );
    }

    // Login-case gotcha (M2 R2): the github-org provider normalizes ingested
    // User.metadata.name to lowercase, but Dex's preferred_username is the GitHub login
    // as-is. Lowercase the login before matching so a user whose GitHub login has uppercase
    // characters still resolves to their ingested User.
    const login = rawLogin.toLowerCase();

    // Resolve the REAL ingested catalog User by name (GitHub login == the canonical User
    // entity name after GitHub-org ingestion). NO dangerousEntityRefFallback: resolving to a
    // real User is what populates ownershipEntityRefs (the user's group/team refs) so the M2
    // permission policy can filter by ownership. A login with no matching ingested User fails
    // sign-in by design (§3.1).
    //
    // Done in EXPLICIT steps (rather than the one-liner ctx.signInWithCatalogUser) so the
    // lookup can be RETRIED, the F1 group augmentation can run, and the resolved sub +
    // ownership-ref count + the precise failing step can be logged. The sign-in pipeline's
    // frame handler swallows resolver throws into a client-side web-message (the pod shows
    // only "200 contentLength 0" with no server stack), so without this logging we are blind
    // to WHY a step fails. console.* is captured by the backend root logger, so these
    // surface in pod logs WITHOUT a global debug-log flag.
    try {
      // RETRY the catalog lookup + ownership resolution as a unit: both are internal loopback
      // calls subject to the same intermittent "Premature close". Retrying the pair means a
      // drop on either one recovers on the next attempt. A genuine NotFound is not retried.
      const { entity, ownershipEntityRefs } = await withLookupRetry(async () => {
        const found = await ctx.findCatalogUser({ entityRef: { name: login } });
        const ownership = await ctx.resolveOwnershipEntityRefs(found.entity);
        return {
          entity: found.entity,
          ownershipEntityRefs: ownership.ownershipEntityRefs,
        };
      }, login);

      // F1: augment with groups that list this user via spec.members (robust to the
      // relation-stitching lag — see resolveGroupsByMembership). Unioned + de-duped with the
      // standard refs. Guarded internally: returns [] on any failure, so this never breaks
      // sign-in and never REGRESSES the standard ownership behaviour.
      const groupRefsByMembership = await resolveGroupsByMembership(
        login,
        catalog,
        auth,
      );
      const ent = Array.from(
        new Set([...ownershipEntityRefs, ...groupRefsByMembership]),
      );

      const sub = stringifyEntityRef(entity);
      // eslint-disable-next-line no-console
      console.info(
        `[authOidcProcess] resolved login=${login} -> sub=${sub} ` +
          `ownershipEntityRefs=${ownershipEntityRefs.length} ` +
          `+F1groups=${groupRefsByMembership.length} -> ent=${ent.length}`,
      );
      // issueToken is a local operation (no catalog loopback), so it is outside the retry.
      return await ctx.issueToken({ claims: { sub, ent } });
    } catch (error) {
      const name = (error as Error)?.name ?? 'Error';
      const message = (error as Error)?.message ?? String(error);
      // eslint-disable-next-line no-console
      console.error(
        `[authOidcProcess] sign-in FAILED for login=${login} after up to ` +
          `${LOOKUP_MAX_ATTEMPTS} attempt(s): ${name}: ${message}`,
        error,
      );
      // Clearer surfaced error: distinguish "no such user" (expected for a non-member) from a
      // persistent infrastructure failure, so the failure mode is legible in the popup + logs.
      if (name === 'NotFoundError') {
        throw new Error(
          `Sign-in failed: no catalog User matches GitHub login "${login}". ` +
            `You must be a member of an ingested UA-MIS team to sign in.`,
        );
      }
      throw new Error(
        `Sign-in failed: could not resolve catalog User for "${login}" after ` +
          `${LOOKUP_MAX_ATTEMPTS} attempt(s) (last error: ${name}: ${message}).`,
      );
    }
  };
}

export const authModuleOidcProcess = createBackendModule({
  // Targets the core "auth" plugin.
  pluginId: 'auth',
  moduleId: 'oidc-process-provider',
  register(reg) {
    reg.registerInit({
      // catalog + auth are needed for the F1 group-membership augmentation in the resolver.
      deps: {
        providers: authProvidersExtensionPoint,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({ providers, catalog, auth }) {
        providers.registerProvider({
          // Must be "oidc" to match the app-config provider key + the Dex redirect URI.
          providerId: 'oidc',
          factory: createOAuthProviderFactory({
            authenticator: oidcAuthenticator,
            signInResolver: createProcessOidcSignInResolver({ catalog, auth }),
          }),
        });
      },
    });
  },
});

export default authModuleOidcProcess;
