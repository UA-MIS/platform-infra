// ============================================================================
// queue-status.mjs — tenant-facing "you were in a queue" reporter (operator UX).
//
// THE HARD CONSTRAINT this works around: a GitHub Actions job that is QUEUED
// ("Waiting for a runner") runs NO code until a self-hosted runner picks it up.
// Builds run 2-at-a-time (maxRunners: 2 on the Kaniko scale set — see
// applicationsets/arc-runner-scaleset-app.yaml), so overflow QUEUES in GitHub
// Actions with no pod created. A queued job therefore CANNOT print "you are #N in
// line" while it waits. So this script runs from the FIRST job the moment a runner
// finally starts it, and reports — retrospectively but honestly — how long the
// build sat in the queue and how many of THIS repo's builds were ahead of it when
// it started. Output goes to the run Summary and, on a pull_request, a sticky PR
// comment (the surface students actually watch).
//
// BEST-EFFORT / FAIL-OPEN: this is cosmetic. Any error (missing scope, API
// hiccup) degrades to a generic "builds run 2 at a time" note and the script still
// exits 0 — it must NEVER fail a build. The numbers need `actions: read` (run
// timings + queue depth) and the PR comment needs `pull-requests: write`; both are
// granted by the tenant caller (.github/workflows/build-and-push.yaml). If a caller
// hasn't been re-synced to grant them, you still get the generic note.
//
// TRUTHFULNESS: the position is computed from THIS repo's own workflow runs (a
// repo's GITHUB_TOKEN can only see its own repo). The Kaniko scale set is shared
// across UA-MIS tenants, so cluster-wide contention can be higher than the number
// shown — the wording says "from this repo" and never claims a cluster-wide rank.
// ============================================================================
import fs from "node:fs";

const api = process.env.GITHUB_API_URL || "https://api.github.com";
const repo = process.env.GITHUB_REPOSITORY; // owner/name
const runId = process.env.GITHUB_RUN_ID;
const token = process.env.GITHUB_TOKEN || "";
const eventName = process.env.GITHUB_EVENT_NAME || "";
const prNumber = process.env.PR_NUMBER || "";
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
const MARKER = "<!-- capstone-queue-status -->";

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "capstone-queue-status",
};

function notice(msg) {
  console.log(`::notice title=Build queue::${msg}`);
}
function humanizeSeconds(s) {
  if (s == null || !isFinite(s) || s < 0) return null;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}
async function apiJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Compute wait time + how many of THIS repo's builds were ahead at start.
async function computeQueueFacts() {
  const run = await apiJson(`${api}/repos/${repo}/actions/runs/${runId}`);
  const created = run.created_at ? new Date(run.created_at) : null;
  const started = run.run_started_at ? new Date(run.run_started_at) : new Date();
  let waitedSeconds = null;
  if (created) waitedSeconds = Math.max(0, Math.round((started - created) / 1000));

  // How many runs of THIS SAME workflow were still queued/in_progress and were
  // created BEFORE this run — i.e. ahead of it in this repo's queue at start.
  let ahead = 0;
  if (created && run.workflow_id) {
    for (const status of ["in_progress", "queued"]) {
      const page = await apiJson(
        `${api}/repos/${repo}/actions/workflows/${run.workflow_id}/runs?status=${status}&per_page=100`
      );
      for (const r of page.workflow_runs || []) {
        if (String(r.id) === String(runId)) continue;
        if (r.created_at && new Date(r.created_at) < created) ahead++;
      }
    }
  }
  return { waited: humanizeSeconds(waitedSeconds), ahead };
}

function richMessageMd({ waited, ahead }) {
  const waitedPhrase = waited ? ` after waiting **${waited}** in the queue` : "";
  const aheadPhrase =
    ahead > 0
      ? ` When it started, **${ahead}** build${ahead === 1 ? "" : "s"} from this repo ${
          ahead === 1 ? "was" : "were"
        } ahead of it.`
      : " It was first in this repo's queue when a runner freed up.";
  return [
    "### ⏳ Build queue",
    "",
    `Your build **started automatically**${waitedPhrase}.${aheadPhrase}`,
    "",
    "Builds run **2 at a time** to fit the cluster, so a push can sit in " +
      "*Queued / “Waiting for a runner”* for a bit before a runner picks it up. " +
      "That is expected — nothing is broken and you don't need to do anything; " +
      "it starts on its own as soon as a build slot is free.",
    "",
  ].join("\n");
}
function genericMessageMd() {
  return [
    "### ⏳ Build queue",
    "",
    "Builds run **2 at a time** to fit the cluster. If this run sat in " +
      "*Queued / “Waiting for a runner”* for a while, that's expected — " +
      "it starts automatically as soon as a build slot is free. Nothing is broken and " +
      "no action is needed.",
    "",
  ].join("\n");
}

function writeSummary(md) {
  try {
    if (summaryPath) fs.appendFileSync(summaryPath, md + "\n");
  } catch (e) {
    notice(`could not write the run summary (${e.message})`);
  }
}

// Sticky PR comment: update the existing marker comment if present, else create.
async function upsertPrComment(md) {
  if (eventName !== "pull_request" || !prNumber) return;
  const body = `${MARKER}\n${md}`;
  try {
    const existing = await apiJson(
      `${api}/repos/${repo}/issues/${prNumber}/comments?per_page=100`
    );
    const mine = (existing || []).find((c) => c.body && c.body.includes(MARKER));
    const url = mine
      ? `${api}/repos/${repo}/issues/comments/${mine.id}`
      : `${api}/repos/${repo}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: mine ? "PATCH" : "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      notice(
        `PR comment skipped (${res.status}) — grant pull-requests:write on the caller to enable it. ${detail.slice(0, 140)}`
      );
    }
  } catch (e) {
    notice(`PR comment skipped (${e.message})`);
  }
}

async function main() {
  let md;
  try {
    if (!token) throw new Error("no GITHUB_TOKEN in env");
    const facts = await computeQueueFacts();
    md = richMessageMd(facts);
  } catch (e) {
    notice(
      `showing the generic queue note — could not read run timings (${e.message}). ` +
        "Grant actions:read on the caller to enable wait-time + position."
    );
    md = genericMessageMd();
  }
  writeSummary(md);
  await upsertPrComment(md);
}

// Fail-open: never let this cosmetic step break a build.
main().catch((e) => {
  notice(`queue-status skipped (${e.message})`);
  process.exit(0);
});
