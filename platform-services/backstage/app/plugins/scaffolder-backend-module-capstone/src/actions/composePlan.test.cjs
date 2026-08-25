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

// ---------------------------------------------------------------------------------
// F-1 / #48 — deploy-time migrations. The planner's only job here is to carry a
// fragment's declared `migrate` argv onto the component (the chart decides whether to
// RENDER it) and to reject a malformed declaration at compose time, where the wizard
// shows the error, rather than at deploy time, where it shows up as a wedged pod.
// ---------------------------------------------------------------------------------
const nextjs = { id: 'nextjs', category: 'fullstack', slots: ['single'], defaultPort: 3000, ingressPath: '/', needsDB: true, buildType: 'container', dockerfile: 'Dockerfile', migrate: ['node', '/app/prisma-cli/node_modules/prisma/build/index.js', 'migrate', 'deploy'] };

test('a fragment declaring migrate carries the argv onto its component', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: nextjs }, database: 'host-mysql', port: 8080 });
  assert.deepEqual(p.components[0].migrate, ['node', '/app/prisma-cli/node_modules/prisma/build/index.js', 'migrate', 'deploy']);
});

test('a fragment that self-migrates gets migrate: null (chart gate stays closed)', () => {
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: express }, database: 'host-mysql', port: 8080 });
  assert.equal(p.components[0].migrate, null);
});

test('migrate is carried in the backend slot too, not just single', () => {
  const be = { ...nextjs, id: 'django-like', category: 'backend', slots: ['backend', 'single'], ingressPath: '/api' };
  const p = planComposition({ projectType: 'web', layout: 'frontend-backend', fragments: { frontend: react, backend: be }, database: 'host-mysql', port: 8080 });
  const backend = p.components.find(c => c.name === 'backend');
  assert.deepEqual(backend.migrate, nextjs.migrate);
  assert.equal(p.components.find(c => c.name === 'frontend').migrate, null);
});

test('the plan is unchanged by the DB choice — gating on database is the chart\'s job', () => {
  // The planner must NOT drop the argv for database:none; the chart's own condition is
  // what keeps a migrator from wedging a DB-less pod. Keeping both rules in the planner
  // would hide the chart's gate from anyone reading the manifests.
  const p = planComposition({ projectType: 'web', layout: 'single', fragments: { single: nextjs }, database: 'none', port: 8080 });
  assert.deepEqual(p.components[0].migrate, nextjs.migrate);
});

test('a malformed migrate is rejected at compose time', () => {
  const bad = argv => () => planComposition({ projectType: 'web', layout: 'single', fragments: { single: { ...nextjs, migrate: argv } }, database: 'host-mysql' });
  assert.throws(bad('npm run migrate'), /invalid 'migrate'/);   // string, not argv
  assert.throws(bad([]), /invalid 'migrate'/);                  // empty
  assert.throws(bad(['ruby', '']), /invalid 'migrate'/);        // empty member
  assert.throws(bad([1, 2]), /invalid 'migrate'/);              // non-strings
});

test('migrate without needsDB is rejected (an unreachable migrator)', () => {
  const meta = { ...nextjs, needsDB: false };
  assert.throws(
    () => planComposition({ projectType: 'web', layout: 'single', fragments: { single: meta }, database: 'none' }),
    /declares 'migrate' but not needsDB/,
  );
});
