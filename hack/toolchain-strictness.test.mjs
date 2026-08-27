#!/usr/bin/env node
// toolchain-strictness.test.mjs — A4.
//
// The reviewer's point was not that `= "1"` was wrong, it was that NOTHING TESTED IT,
// so the hole was latent rather than known. Fixing the comparison without adding a test
// would leave the next person in the same position. This EXECUTES the real Ruby and PHP
// step bodies -- lifted out of the workflow YAML, not retyped -- against a stubbed
// package manager, once per candidate value of CI_STRICT_TOOLCHAIN, and asserts which
// values actually enforce.
//
// It also pins the retry behaviour (#189.4): a transient install failure must still end
// with the tests having RUN, which is the property the retry exists to provide and which
// nothing else covers.
//
// Node, and a hand-rolled block-scalar reader rather than a YAML dependency, because the
// sync-check job's image is node:*-trixie with no network for `npm i` -- the same
// constraint that made this job unrunnable before #565.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGETS = [
  "platform-services/backstage/templates/_fragments/_contract/.github/workflows/build-and-push.yaml",
  ".github/workflows/tenant-build.yaml",
];
const ROOT = process.argv[2] ?? ".";
let failures = 0;
const ok = (m) => console.log(`    ok   ${m}`);
const bad = (m) => { console.log(`    FAIL ${m}`); failures++; };

// Pull the `args: >-` folded block belonging to the step whose name starts with `prefix`.
function extractArgs(text, prefix) {
  const lines = text.split("\n");
  let i = lines.findIndex((l) => new RegExp(`^\\s*- name: ${prefix}`).test(l));
  if (i < 0) return null;
  while (i < lines.length && !/^\s*args: >-\s*$/.test(lines[i])) {
    if (/^\s*- name: /.test(lines[i]) && !new RegExp(`^\\s*- name: ${prefix}`).test(lines[i])) return null;
    i++;
  }
  if (i >= lines.length) return null;
  const indent = lines[i].match(/^(\s*)/)[1].length + 2;
  const body = [];
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === "") break;
    if (l.match(/^(\s*)/)[1].length < indent) break;
    body.push(l.trim());
  }
  // folded scalar: newlines become spaces
  const folded = body.join(" ");
  const m = folded.match(/^-c\s+'(.*)'$/s);
  return m ? m[1] : null;
}

// Stub package managers: fail `failures` times, then succeed. Record that tests ran.
function makeStubs(dir, tool, nFail) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const counter = join(dir, "n");
  const ran = join(dir, "ran");
  const body = `#!/bin/sh
c=$(cat ${counter} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${counter}
if [ "$c" -le ${nFail} ]; then echo "stub: ${tool} failure $c" >&2; exit 1; fi
if [ "$1" = "exec" ]; then shift; exec "$@"; fi
if [ "$1" = "run-script" ]; then echo "  test"; exit 0; fi
echo RAN > ${ran}
exit 0
`;
  for (const name of [tool, "rake", "phpunit"]) writeFileSync(join(bin, name), body, { mode: 0o755 });
  // Stub `sleep` to return instantly. The step's retry backoff is 10s + 15s, which is
  // right in CI and would make this test ~20 minutes. Stubbing it here keeps the
  // PRODUCTION body untouched -- the alternative, making the interval configurable, would
  // be changing shipped code to suit its test.
  writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "rake"), `#!/bin/sh
[ "$1" = "-T" ] && { echo "rake test  # run"; exit 0; }
echo RAN > ${ran}
exit 0
`, { mode: 0o755 });
  return { bin, ran };
}

function runBody(rawBody, { strict, nFail, tool }) {
  const dir = mkdtempSync(join(tmpdir(), "strict-"));
  const { bin, ran } = makeStubs(dir, tool, nFail);
  const body = rawBody
    .replace(/\$\{\{\s*vars\.CI_STRICT_TOOLCHAIN\s*\}\}/g, strict)
    .replace(/\$\{\{[^}]*\}\}/g, ".");
  const r = spawnSync("sh", ["-c", body], {
    cwd: dir,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_WORKSPACE: dir },
    encoding: "utf8",
  });
  const testsRan = existsSync(ran);
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, testsRan, out: `${r.stdout}${r.stderr}` };
}

// value -> should a PERSISTENT install failure be enforced (red)?
const CASES = [
  ["", false], ["0", false], ["false", false], ["no", false], ["off", false],
  ["1", true], ["true", true], ["TRUE", true], ["True", true], ["yes", true], ["on", true],
  ["banana", false],
];

for (const rel of TARGETS) {
  const text = readFileSync(join(ROOT, rel), "utf8");
  for (const [prefix, tool] of [["Ruby", "bundle"], ["PHP", "composer"]]) {
    const body = extractArgs(text, prefix);
    console.log(`\n  ${rel} :: ${prefix}`);
    if (!body) { bad(`could not extract the ${prefix} step body -- the step was renamed or its shape changed, so this test can no longer see it`); continue; }

    // healthy install: green, tests run
    let r = runBody(body, { strict: "", nFail: 0, tool });
    r.code === 0 && r.testsRan ? ok("healthy install -> green, tests ran") : bad(`healthy install -> code=${r.code} testsRan=${r.testsRan}`);

    // transient: 2 failures then success -- retry must still get the tests run (#189.4)
    r = runBody(body, { strict: "", nFail: 2, tool });
    r.code === 0 && r.testsRan ? ok("transient (2 failures) -> green, tests still RAN") : bad(`transient -> code=${r.code} testsRan=${r.testsRan} (retry did not recover)`);

    // persistent, across every candidate value
    for (const [val, shouldEnforce] of CASES) {
      r = runBody(body, { strict: val, nFail: 99, tool });
      const enforced = r.code !== 0;
      if (enforced === shouldEnforce) {
        ok(`persistent + CI_STRICT_TOOLCHAIN=${JSON.stringify(val)} -> ${enforced ? "RED (enforced)" : "green (permissive)"}`);
      } else {
        bad(`persistent + CI_STRICT_TOOLCHAIN=${JSON.stringify(val)} -> ${enforced ? "RED" : "green"}, expected ${shouldEnforce ? "RED" : "green"}`);
      }
      if (val === "banana" && !/not a recognised boolean/.test(r.out)) {
        bad(`an unrecognised value must WARN that it is being treated as OFF; it did not`);
      }
      if (!shouldEnforce && val !== "" && r.testsRan) {
        bad(`permissive path must not claim tests ran when the install never succeeded`);
      }
    }
  }
}

console.log(`\n  FAILURES: ${failures}`);
process.exit(failures ? 1 : 0);
