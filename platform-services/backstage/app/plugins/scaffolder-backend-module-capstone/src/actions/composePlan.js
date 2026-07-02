/*
 * composePlan.js — the PURE planning core of the unified "New Project" wizard's compose
 * engine (capstone:compose-project, ADR-034). Given the wizard choices + the chosen
 * fragments' fragment.yaml metadata, it computes:
 *   - components[]  : the .devops/components.yaml model (1 entry for single, 2 for FE+BE,
 *                     backend+mobile-artifact for a mobile project)
 *   - copies[]      : which fragment skeleton dir is rendered into which target dir
 *   - database      : the resolved tenant DB mode (none|mysql) for the CapstoneTenant claim
 *   - dbWired       : whether any component will receive a DATABASE_URL (drives the chart)
 *
 * It is PURE (no fs, no network, no Backstage deps) so the SAME logic runs in three places
 * with NO drift: the TS action (composeProject.ts), the offline dry-render harness
 * (templates/_fragments/_tools/dry-render.py, via a tiny node shim), and a node --test unit
 * test (composePlan.test.cjs). This is the project's "one source, build-read it" rule
 * (copy-not-reference is the bug generator).
 *
 * CommonJS on purpose: importable by the esbuild/TS backend build, by `node --test`, and by
 * a plain `require()` harness alike.
 */
'use strict';

/** A category maps to a components.yaml `kind` (descriptive; ingress is `path`, DB is needsDb). */
const CATEGORY_KIND = {
  frontend: 'frontend',
  static: 'frontend',
  backend: 'backend',
  fullstack: 'backend',
  mobile: 'backend',
};

const VALID_CATEGORIES = Object.keys(CATEGORY_KIND);
const VALID_BUILDTYPES = ['container', 'static', 'mobile-artifact'];
const VALID_DBCHOICES = ['host-mysql', 'host-postgres', 'bring-your-own', 'none'];

/** Validate one parsed fragment.yaml meta. Throws on a malformed fragment (fail closed). */
function validateMeta(meta, where) {
  if (!meta || typeof meta !== 'object') {
    throw new Error(`compose: ${where} fragment metadata missing`);
  }
  if (!meta.id) throw new Error(`compose: ${where} fragment.yaml has no id`);
  if (!VALID_CATEGORIES.includes(meta.category)) {
    throw new Error(
      `compose: ${where} fragment '${meta.id}' has invalid category '${meta.category}' ` +
        `(expected one of ${VALID_CATEGORIES.join('|')})`,
    );
  }
  if (!VALID_BUILDTYPES.includes(meta.buildType)) {
    throw new Error(
      `compose: ${where} fragment '${meta.id}' has invalid buildType '${meta.buildType}' ` +
        `(expected one of ${VALID_BUILDTYPES.join('|')})`,
    );
  }
  if (!Array.isArray(meta.slots) || meta.slots.length === 0) {
    throw new Error(`compose: ${where} fragment '${meta.id}' declares no slots`);
  }
  return meta;
}

/** Assert a fragment can fill the requested slot. */
function requireSlot(meta, slot) {
  if (!meta.slots.includes(slot)) {
    throw new Error(
      `compose: fragment '${meta.id}' (category ${meta.category}) cannot fill the ` +
        `'${slot}' slot — its slots are [${meta.slots.join(', ')}].`,
    );
  }
}

/** The container port for a component: the wizard's port wins, else the fragment default. */
function portFor(meta, port) {
  return Number(port) || Number(meta.defaultPort) || 8080;
}

/** Build one components[] entry from a slot assignment. */
function component({ name, meta, context, path, port }) {
  return {
    name,
    kind: CATEGORY_KIND[meta.category],
    context,
    dockerfile: meta.dockerfile || 'Dockerfile',
    port: portFor(meta, port),
    path,
    needsDb: Boolean(meta.needsDB),
    buildType: meta.buildType,
  };
}

/**
 * planComposition — the heart of the engine. See file header for I/O.
 * @param {object} input
 * @param {'web'|'mobile'} input.projectType
 * @param {'single'|'frontend-backend'} [input.layout]   (web only)
 * @param {object} input.fragments   { single?, frontend?, backend?, mobile? } parsed metas
 * @param {string} input.database    one of VALID_DBCHOICES (wizard DB choice)
 * @param {number} [input.port]      container port (default 8080)
 */
function planComposition(input) {
  const port = Number(input.port) || 8080;
  const dbChoice = input.database || 'none';
  if (!VALID_DBCHOICES.includes(dbChoice)) {
    throw new Error(
      `compose: invalid database choice '${dbChoice}' (expected ${VALID_DBCHOICES.join('|')})`,
    );
  }

  const f = input.fragments || {};
  const components = [];
  const copies = [];

  if (input.projectType === 'web') {
    if (input.layout === 'single') {
      const meta = validateMeta(f.single, 'single');
      requireSlot(meta, 'single');
      // The single component owns "/" and is named `app` (context dir `app/`).
      components.push(component({ name: 'app', meta, context: 'app', path: '/', port }));
      copies.push({ fragment: meta, targetDir: 'app' });
    } else if (input.layout === 'frontend-backend') {
      const fe = validateMeta(f.frontend, 'frontend');
      const be = validateMeta(f.backend, 'backend');
      requireSlot(fe, 'frontend');
      requireSlot(be, 'backend');
      // Frontend owns "/"; backend owns its declared ingressPath ("/api").
      components.push(component({ name: 'frontend', meta: fe, context: 'frontend', path: '/', port }));
      components.push(
        component({ name: 'backend', meta: be, context: 'backend', path: be.ingressPath || '/api', port }),
      );
      copies.push({ fragment: fe, targetDir: 'frontend' });
      copies.push({ fragment: be, targetDir: 'backend' });
    } else {
      throw new Error(`compose: web project requires layout single|frontend-backend (got '${input.layout}')`);
    }
  } else if (input.projectType === 'mobile') {
    // Mobile = a deployed backend (the API the app calls) + a build-artifact mobile app
    // that is NOT a k8s workload. The backend owns "/" (it is the only web component).
    const be = validateMeta(f.backend, 'backend');
    const mob = validateMeta(f.mobile, 'mobile');
    requireSlot(be, 'backend');
    requireSlot(mob, 'mobile');
    components.push(component({ name: 'backend', meta: be, context: 'backend', path: '/', port }));
    // The mobile component is tracked in components.yaml but the chart skips it
    // (buildType mobile-artifact -> no Deployment/Service/Ingress).
    components.push({
      name: 'mobile',
      kind: 'mobile',
      context: 'mobile',
      dockerfile: '',
      port: 0,
      path: '',
      needsDb: false,
      buildType: 'mobile-artifact',
    });
    copies.push({ fragment: be, targetDir: 'backend' });
    copies.push({ fragment: mob, targetDir: 'mobile' });
  } else {
    throw new Error(`compose: invalid projectType '${input.projectType}' (expected web|mobile)`);
  }

  // DB resolution. dbWired = a component reads DATABASE_URL AND the user did not pick "none".
  // Provisioned `database` is mysql ONLY for host-mysql (the XRD/ADR-033 enum is none|mysql;
  // host-postgres + bring-your-own are user-supplied -> provision none, but still wire the
  // DATABASE_URL ExternalSecret so the team can set the value via the Secrets tab).
  const anyNeedsDb = components.some(c => c.needsDb);
  const dbWired = anyNeedsDb && dbChoice !== 'none';
  // Provision mysql ONLY when host-mysql is chosen AND a component actually uses a DB —
  // never stand up an unused database for a DB-less stack (defensive against a mis-pick).
  const database = dbChoice === 'host-mysql' && anyNeedsDb ? 'mysql' : 'none';

  return {
    components,
    copies,
    database,
    dbWired,
    single: input.projectType === 'web' && input.layout === 'single',
  };
}

module.exports = {
  planComposition,
  validateMeta,
  CATEGORY_KIND,
  VALID_CATEGORIES,
  VALID_BUILDTYPES,
  VALID_DBCHOICES,
};
