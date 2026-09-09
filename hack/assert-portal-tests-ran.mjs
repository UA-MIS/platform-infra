#!/usr/bin/env node
// assert-portal-tests-ran.mjs — #232.
//
// The portal's 21 test files have never executed in any workflow. The point of adding a
// job that runs them is defeated if that job can pass while running nothing, and there
// are THREE independent ways it can:
//
//   1. `backstage-cli repo test` defaults to jest's CHANGED-FILES scoping. On a clean
//      checkout it prints "No tests found related to files changed since last commit"
//      and EXITS 0. A workflow that just called `yarn test` would have been green from
//      day one having run zero tests. (Verified locally: bare `yarn test` on a clean
//      tree does exactly this; `CI=true` is what makes it run everything.)
//   2. A failed install leaves no jest, and a `|| true` anywhere upstream turns that
//      into a pass.
//   3. A workspace can silently drop out of the run -- renamed, testless, or its glob
//      stops matching -- and the aggregate total stays healthy because the other six
//      still report.
//
// So the count is asserted PER WORKSPACE against a committed floor, never as a global
// total. That distinction is not theoretical: it is the same trap that let
// `.github/workflows` be emptied while a repo-wide `files.length > 0` still passed in
// hack/check-pipefail-pinning.mjs (B1, PR #581). An aggregate is not a guard.
//
// Input is jest's own --json report, so this asserts what jest ACTUALLY RAN, not what
// the filesystem contains.
import { readFileSync } from "node:fs";

const REPORT = process.argv[2];
if (!REPORT) {
  console.error("usage: assert-portal-tests-ran.mjs <jest-json-report>");
  process.exit(2);
}

// Committed floor: the minimum number of test FILES each workspace must contribute to a
// run. Deliberately a floor, not an equality -- adding tests must never fail the build,
// removing the last one from a workspace must. Update it when a workspace legitimately
// loses coverage, and say why in the commit.
const FLOOR = {
  "plugins/scaffolder-backend-module-capstone": 11,
  "plugins/capstone-secrets": 3,
  "plugins/capstone-secrets-backend": 1,
  "plugins/capstone-tenants": 1,
  "plugins/capstone-tenants-backend": 1,
  "packages/app": 1,
  "packages/backend": 2,
};

let report;
try {
  report = JSON.parse(readFileSync(REPORT, "utf8"));
} catch (e) {
  console.log(`::error::could not read jest's JSON report at ${REPORT}: ${e.message}. The test step did not produce a report, which means it did not run -- refusing to pass.`);
  process.exit(1);
}

const results = report.testResults ?? [];
if (results.length === 0) {
  console.log(`::error::jest's report contains ZERO test suites. Something ran and reported nothing -- most likely the changed-files default (see this file's header) or a failed install. Refusing to report success over an empty run.`);
  process.exit(1);
}

// Attribute each executed suite to the workspace it lives in.
const seen = new Map();      // workspace -> file count
const testCounts = new Map(); // workspace -> individual test count
for (const r of results) {
  const m = r.name.match(/(plugins|packages)\/[^/]+/);
  if (!m) continue;
  const ws = m[0];
  seen.set(ws, (seen.get(ws) ?? 0) + 1);
  const n = (r.assertionResults ?? []).length;
  testCounts.set(ws, (testCounts.get(ws) ?? 0) + n);
}

const w = Math.max(...Object.keys(FLOOR).map((k) => k.length));
console.log(`${"workspace".padEnd(w)}  suites  floor  tests`);
const problems = [];
for (const [ws, floor] of Object.entries(FLOOR)) {
  const got = seen.get(ws) ?? 0;
  const tests = testCounts.get(ws) ?? 0;
  const bad = got < floor;
  console.log(`${ws.padEnd(w)}  ${String(got).padStart(6)}  ${String(floor).padStart(5)}  ${String(tests).padStart(5)}${bad ? "   <-- BELOW FLOOR" : ""}`);
  if (bad) problems.push(`${ws}: jest ran ${got} test file(s), floor is ${floor}`);
  else if (tests === 0) problems.push(`${ws}: ${got} suite(s) ran but contained ZERO individual tests`);
}

// A workspace that appears in the run but not in FLOOR is new coverage: report it so the
// floor gets updated deliberately, but do not fail on it (adding tests must never break
// the build).
for (const ws of seen.keys()) {
  if (!(ws in FLOOR)) console.log(`  note: ${ws} ran ${seen.get(ws)} suite(s) and is not in FLOOR — add it to hack/assert-portal-tests-ran.mjs so its coverage is pinned too.`);
}

const totalTests = report.numTotalTests ?? 0;
const totalSuites = results.length;
console.log(`\ntotals: ${totalSuites} suites, ${totalTests} tests (passed=${report.numPassedTests ?? 0}, failed=${report.numFailedTests ?? 0})`);

if (problems.length) {
  for (const p of problems) console.log(`  ${p}`);
  console.log(`::error::${problems.length} workspace(s) above ran fewer tests than their committed floor. Either coverage was deleted, or the test run silently skipped a workspace. A per-workspace floor exists precisely because the ${totalSuites}-suite aggregate above still looks healthy when one workspace drops out.`);
  process.exit(1);
}
console.log(`OK: every workspace met its floor.`);
