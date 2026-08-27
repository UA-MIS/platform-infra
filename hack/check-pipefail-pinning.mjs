#!/usr/bin/env node
// check-pipefail-pinning.mjs — A2. Every `run:` step that relies on `pipefail`
// inside a CONTAINER job must carry `shell: bash`.
//
// WHY THIS IS A CHECK AND NOT A CONVENTION. For a container job the runner does NOT
// use bash for a bare `run:` — it uses `sh -e {0}` (observed directly in run
// 33027282352: pinned steps log `bash --noprofile --norc -e -o pipefail {0}`,
// unpinned ones log `shell: sh -e {0}`). `set -o pipefail` then survives only because
// Debian trixie's dash happens to implement it. Ubuntu's dash (0.5.12-6ubuntu5)
// rejects it and the script dies on the `set` line. So an unpinned step is one base
// image bump away from either silently losing pipefail or hard-failing at line 1.
//
// PR #578 applied this rule by hand to three files and missed promote-to-prod.yaml --
// the prod promotion path. That is the failure mode this file removes: the rule is now
// enforced over every workflow instead of remembered for the ones someone thought of.
//
// NON-CONTAINER jobs are reported but NOT failed: with no container the runner resolves
// bash on the host (`bash -e {0}`), so an in-body `set -o pipefail` is honoured. The
// hazard is specific to container jobs. Node, not Python, because the sync-check job's
// image is node:*-trixie and node is the one interpreter guaranteed to be there.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.argv[2] ?? ".";

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ya?ml$/.test(e.name) && /\.github[/\\]workflows$/.test(dir)) out.push(p);
  }
  return out;
}

// A deliberately small indentation walker rather than a YAML parser: the sync-check
// image has no yaml module, and adding a network install to this job is exactly the
// thing that made it unrunnable before #565.
function auditFile(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const findings = [];
  let jobIndent = null, curJob = null, jobHasContainer = false;
  let step = null;

  const flush = () => {
    if (step && step.pipefail && !step.shell) {
      findings.push({ file, job: curJob, name: step.name, container: jobHasContainer, line: step.line });
    }
    step = null;
  };

  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (/^jobs:\s*$/.test(ln)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const jm = ln.match(/^(\s\s)([A-Za-z0-9_-]+):\s*$/);
    if (jm) { flush(); curJob = jm[2]; jobIndent = jm[1].length; jobHasContainer = false; continue; }
    if (curJob === null) continue;
    if (/^\s{4}container:/.test(ln)) jobHasContainer = true;
    const sm = ln.match(/^(\s+)-\s+(name|uses|run|id|shell):/);
    if (sm && sm[1].length > jobIndent) {
      flush();
      step = { name: "?", shell: null, pipefail: false, line: i + 1 };
      const nm = ln.match(/-\s+name:\s*(.*)$/);
      if (nm) step.name = nm[1].trim().slice(0, 46);
    }
    if (!step) continue;
    if (/^\s+shell:\s*\S/.test(ln)) step.shell = ln.split(":").slice(1).join(":").trim();
    if (/pipefail/.test(ln) && !/^\s*#/.test(ln.trim())) step.pipefail = true;
  }
  flush();
  return findings;
}

const files = walk(ROOT);
const all = files.flatMap(auditFile);
const blocking = all.filter((f) => f.container);
const advisory = all.filter((f) => !f.container);

console.log(`scanned ${files.length} workflow files`);
for (const f of advisory) {
  console.log(`  note: ${relative(ROOT, f.file)}:${f.line} [${f.job}] "${f.name}" sets pipefail unpinned, but the job has no container: the runner resolves bash on the host, so pipefail is honoured. Pin it anyway if you like; not failing on it.`);
}
if (blocking.length) {
  for (const f of blocking) {
    console.log(`${relative(ROOT, f.file)}:${f.line} [${f.job}] "${f.name}"`);
  }
  console.log(
    `::error::${blocking.length} CONTAINER-job step(s) above rely on 'pipefail' without 'shell: bash'. ` +
    `A container job's bare 'run:' is executed as 'sh -e {0}', so pipefail depends on whatever /bin/sh ` +
    `the image ships -- Debian trixie's dash implements it, Ubuntu's rejects it. Add 'shell: bash' to ` +
    `pin the step to 'bash --noprofile --norc -eo pipefail {0}'. Do NOT drop pipefail instead.`
  );
  process.exit(1);
}
console.log(`OK: 0 container-job steps rely on pipefail without 'shell: bash' (${advisory.length} non-container note(s) above).`);
