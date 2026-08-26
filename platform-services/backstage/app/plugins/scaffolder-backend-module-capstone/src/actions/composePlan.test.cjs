/*
 * composePlan.test.cjs — unit tests for the pure compose planner. Runs under plain
 * `node --test` (no Backstage toolchain needed), so the load-bearing routing logic is
 * proven offline. The TS action delegates to this same module (no drift).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
// composePlan is now native ESM (composePlan.mjs — see its header for why the bundle needs it).
// A .cjs file cannot `require()` an ESM module, so load it once via dynamic import() in a
// root before() hook; every test below reads the populated `planComposition`.
let planComposition;
test.before(async () => {
  ({ planComposition } = await import('./composePlan.mjs'));
});

const react = { id: 'react', category: 'frontend', framework: 'react', slots: ['frontend'], defaultPort: 8080, ingressPath: '/', needsDB: false, buildType: 'container', dockerfile: 'Dockerfile' };
const reactStatic = { id: 'react-static', category: 'static', slots: ['single'], defaultPort: 8080, ingressPath: '/', needsDB: false, buildType: 'static', dockerfile: 'Dockerfile' };
const express = { id: 'express', category: 'backend', slots: ['backend', 'single'], defaultPort: 8080, ingressPath: '/api', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile' };
const fastapi = { id: 'fastapi', category: 'backend', slots: ['backend', 'single'], defaultPort: 8080, ingressPath: '/api', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile' };
const mobile = { id: 'swift-ios', category: 'mobile', slots: ['mobile'], defaultPort: 0, ingressPath: '', needsDB: false, buildType: 'mobile-artifact', dockerfile: '' };
// blank / bring-your-own-code (ADR-035 §D4): single-slot container placeholder, kind backend.
const blank = { id: 'bring-your-own', category: 'blank', slots: ['single'], defaultPort: 8080, ingressPath: '/', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile' };

test('single backend (FastAPI) + host-mysql -> 1 component at /, db provisioned', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: fastapi }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components.length, 1);
  const [c] = p.components;
  assert.equal(c.name, 'app');
  assert.equal(c.context, 'app');
  assert.equal(c.path, '/');
  assert.equal(c.needsDb, true);
  assert.equal(c.buildType, 'container');
  assert.equal(p.database, 'mysql');
  assert.equal(p.dbWired, true);
  assert.deepEqual(p.copies.map(x => [x.fragment.id, x.targetDir]), [['fastapi', 'app']]);
});

test('FE+BE (React + Express) + host-mysql -> frontend / + backend /api', () => {
  const p = planComposition({ projectType: 'web', layout: 'frontend-backend', fragments: { frontend: react, backend: express }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components.length, 2);
  const fe = p.components.find(c => c.name === 'frontend');
  const be = p.components.find(c => c.name === 'backend');
  assert.equal(fe.path, '/');
  assert.equal(fe.needsDb, false);
  assert.equal(be.path, '/api');
  assert.equal(be.needsDb, true);
  assert.equal(p.database, 'mysql');
  assert.equal(p.dbWired, true);
  assert.deepEqual(p.copies.map(x => x.targetDir).sort(), ['backend', 'frontend']);
});

test('static single (react-static) -> no db, single component', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactStatic }, database: 'none' });
  assert.equal(p.components.length, 1);
  assert.equal(p.components[0].needsDb, false);
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
});

test('bring-your-own wires DATABASE_URL but provisions none', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: express }, database: 'bring-your-own' });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, true);
});

test('db=none on a DB-capable backend leaves it unwired', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: express }, database: 'none' });
  assert.equal(p.dbWired, false);
  assert.equal(p.database, 'none');
});

test('single backend (FastAPI) + host-postgres -> postgres provisioned (#192 PG parity)', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: fastapi }, database: 'host-postgres', port: 8080 });
  assert.equal(p.database, 'postgres');
  assert.equal(p.dbWired, true);
});

test('FE+BE (React + Express) + host-postgres -> postgres provisioned, DATABASE_URL wired', () => {
  const p = planComposition({ projectType: 'web', layout: 'frontend-backend', fragments: { frontend: react, backend: express }, database: 'host-postgres', port: 8080 });
  assert.equal(p.database, 'postgres');
  assert.equal(p.dbWired, true);
});

test('host-postgres on a DB-less stack (static) provisions no engine', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactStatic }, database: 'host-postgres' });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
});

test('mobile -> deployed backend at / + mobile-artifact component (not deployed)', () => {
  const p = planComposition({ projectType: 'mobile', fragments: { backend: express, mobile }, database: 'host-mysql', port: 8080 });
  const be = p.components.find(c => c.name === 'backend');
  const mob = p.components.find(c => c.name === 'mobile');
  assert.equal(be.path, '/');
  assert.equal(be.buildType, 'container');
  assert.equal(mob.buildType, 'mobile-artifact');
  assert.equal(p.dbWired, true);
});

test('blank/BYO single + none -> 1 component at /, kind backend, no db', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: blank }, database: 'none' });
  assert.equal(p.components.length, 1);
  const [c] = p.components;
  assert.equal(c.name, 'app');
  assert.equal(c.kind, 'backend'); // blank category maps to kind backend
  assert.equal(c.path, '/');
  assert.equal(c.buildType, 'container');
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
  assert.deepEqual(p.copies.map(x => [x.fragment.id, x.targetDir]), [['bring-your-own', 'app']]);
});

test('blank/BYO single + host-mysql -> db provisioned + wired (wizard DB question is effective)', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: blank }, database: 'host-mysql', port: 8080 });
  assert.equal(p.database, 'mysql');
  assert.equal(p.dbWired, true);
});

// WIZ-007 (FIX-1-REVIEW): blank/bring-your-own + host-postgres was, pre-FIX-16, the ONE
// wizard-reachable Postgres path for a driver-free fragment. FIX-16 added four more
// (django/express/fastapi/go, each with a real driver) — this test pins the driver-free
// case specifically, since it works for a structurally different reason (nothing to
// conflict with, vs. an actual dual-engine driver).
test('blank/BYO single + host-postgres -> postgres provisioned + wired (driver-free path)', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: blank }, database: 'host-postgres', port: 8080 });
  assert.equal(p.database, 'postgres');
  assert.equal(p.dbWired, true);
});

test('slot misuse is rejected (react cannot fill single)', () => {
  assert.throws(() => planComposition({ projectType: 'web', layout: 'single', fragments: { single: react }, database: 'none' }), /cannot fill the 'single' slot/);
});

/* ---------------------------------------------------------------------------------------
 * ABSENT `database` (board #139).
 *
 * The bug: every test above passes `database` EXPLICITLY (usually 'none'), so the suite only
 * ever exercised a shape the wizard does NOT send for DB-less stacks. `new-project/template.yaml`
 * declares the `database` property ONLY inside the needsDB branches of its `singleFragment`
 * schema-dependency, so Group (a) — frontend/angular, static/bare-html, static/react-static —
 * submits with no `database` key at all, and the compose action's non-optional zod enum rejected
 * it before anything was created. The action input is now `.optional()`; THIS is the planner-side
 * half of that contract, pinned so the "test data did not match production data" failure mode
 * cannot recur here.
 * ------------------------------------------------------------------------------------- */
test('#139: database ABSENT on a DB-less single (static) -> resolves to none, unwired', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactStatic } });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
  assert.equal(p.components.length, 1);
  assert.equal(p.components[0].needsDb, false);
});

test('#139: database ABSENT on a DB-less single (frontend in the single slot) -> none, unwired', () => {
  // A frontend fragment that has gained `single` (board #207 does exactly this for
  // react/vue/solid). All are needsDB:false, so they land in Group (a) and send no `database`.
  const reactSingle = { ...react, slots: ['frontend', 'single'] };
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactSingle } });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
  assert.equal(p.components[0].path, '/');
});

test('#139: an EMPTY-STRING database normalises to none too (unset Backstage parameter)', () => {
  // `${{ parameters.database }}` for an unset parameter can arrive as '' rather than undefined
  // depending on how the step input is serialised — both must mean "no database question asked".
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactStatic }, database: '' });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
});

test('#139: database ABSENT on a needsDB fragment provisions nothing (no silent default engine)', () => {
  // Defensive: absent must never be read as "give them a database". A DB-capable stack that
  // somehow arrives without a choice gets no engine and no DATABASE_URL.
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: express } });
  assert.equal(p.database, 'none');
  assert.equal(p.dbWired, false);
});

test('#139: a bogus database is STILL rejected (optional must not become permissive)', () => {
  assert.throws(
    () => planComposition({ projectType: 'web', layout: 'single', fragments: { single: reactStatic }, database: 'host-mysqlx' }),
    /invalid database choice 'host-mysqlx'/,
  );
});

/* ---------------------------------------------------------------------------------------
 * DEPLOY-TIME MIGRATION contract (D-123, board #48).
 *
 * The bug: four fragments (nextjs/django/laravel/rails) shipped migration assets, documented
 * that "the chart's migration initContainer" applies them, and nothing ever ran them — every
 * tenant on those stacks deployed Healthy and served "table does not exist". The chart now
 * renders that initContainer, gated ONLY on the fragment declaring `migrate`. These tests pin
 * both halves of the gate, because a WRONGLY-ON migrator is as harmful as a missing one: the
 * 11+ fragments that self-migrate at boot would get a command their image does not have and
 * wedge in Init.
 * ------------------------------------------------------------------------------------- */
const nextjs = { id: 'nextjs', category: 'fullstack', slots: ['single'], defaultPort: 3000, ingressPath: '/', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile', migrate: 'node /app/prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema=/app/prisma/schema.prisma' };
const django = { id: 'django', category: 'backend', slots: ['backend', 'single'], defaultPort: 8080, ingressPath: '/api', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile', migrate: 'python manage.py migrate --noinput' };

test('a fragment declaring migrate propagates the command onto its component', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: nextjs }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components[0].migrate, nextjs.migrate);
});

test('a fragment with NO migrate declaration gets migrate: "" (chart renders no initContainer)', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: express }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components[0].migrate, '');
});

test('migrate is PER-COMPONENT: a FE+BE app migrates only the backend', () => {
  const p = planComposition({ projectType: 'web', layout: 'frontend-backend', fragments: { frontend: react, backend: django }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components.find(c => c.name === 'frontend').migrate, '');
  assert.equal(p.components.find(c => c.name === 'backend').migrate, django.migrate);
});

test('the mobile-artifact component always has migrate: "" (it is not a k8s workload)', () => {
  const p = planComposition({ projectType: 'mobile', fragments: { backend: django, mobile }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components.find(c => c.name === 'mobile').migrate, '');
});

test('migrate is trimmed, so trailing YAML block-scalar whitespace never reaches the chart', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: { ...django, migrate: '  python manage.py migrate --noinput\n' } }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components[0].migrate, 'python manage.py migrate --noinput');
});

test('a non-string migrate is rejected (it must be one shell command, not an argv array)', () => {
  assert.throws(() => planComposition({ projectType: 'web', layout: 'single', fragments: { single: { ...django, migrate: ['python', 'manage.py', 'migrate'] } }, database: 'host-mysql' }), /non-string `migrate`/);
});

test('a blank migrate is rejected (omit the key instead of declaring an empty migrator)', () => {
  assert.throws(() => planComposition({ projectType: 'web', layout: 'single', fragments: { single: { ...django, migrate: '   ' } }, database: 'host-mysql' }), /blank `migrate`/);
});

test('migrate without needsDB is rejected — the chart would never give it a DATABASE_URL', () => {
  assert.throws(() => planComposition({ projectType: 'web', layout: 'single', fragments: { single: { ...django, needsDB: false } }, database: 'none' }), /declares `migrate` but not `needsDB`/);
});
