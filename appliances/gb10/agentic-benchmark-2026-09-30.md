# Agentic reasoning-effort benchmark — 2026-09-30

**Question:** what `reasoning_effort` should students get in Continue's
agent mode against the local Qwen3.8-27B appliance?

**Answer: `off`.** Across four independent task sets at three
difficulty levels, no reasoning-effort arm reliably outperformed any
other on correctness, while `low`/`medium`/`xhigh` cost 1.2x-2.5x more
wall time in aggregate and `xhigh` (occasionally `medium`) can produce
single requests exceeding fifteen minutes. This matches the config
already shipped to production, where thinking is off across all
Continue roles — this benchmark is an independent confirmation of that
choice, not merely consistent with it having been made for other
reasons. Everything below is support for that answer, the honest limits
of how hard it was tested, and a methodology record of what it took to
trust the numbers.

Raw results, per-task transcripts, and the harness itself are on the
appliance host under `/home/uamis/agentic-bench/` (`results/*.json` for
summaries, `results/*-transcript.json` for full per-task tool-call
transcripts, `harness/` for the code, `*-DEFECTS.md` for every task's
written-before-scoring specification).

## How confident this is, precisely

This did **not** show the four arms are equivalent. It showed that
across four task sets, this benchmark could not distinguish them on
correctness — a different and weaker claim, and the difference matters.
The clearest illustration: on the one task set that got a 5-sample
follow-up (below), `off` and `medium` tied at 4/5 while `low` sat at
2/5 — a spread that large, at five samples, is also exactly what pure
noise looks like. Nothing here rules out a real effect that this task
set was too easy, too narrow, or too small a sample to see.

**What would change the answer:** a task set built specifically to be
hard enough that `off` starts failing while a higher-effort arm keeps
passing (nothing tried tonight found that point at three difficulty
levels); more than 5 samples per cell on the tasks that did show
movement; or a task shape genuinely different from the ones tried here
(see "What did not discriminate," below, for the two shapes that
turned out not to test anything).

## Results: easy and hard task sets (100% pass, every arm)

Three synthetic repos, one per course shape (C#/ASP.NET, Python/OOP,
TypeScript/Jest), each with a `DEFECTS.md` written and live-verified
**before** any task was scored. Three task sets at increasing
difficulty all returned a clean sweep:

| set | tasks | off | low | medium | xhigh |
|---|---|---|---|---|---|
| Easy A (C#+Python, 10 tasks) | 10 | 100% | 100% | 100% | 100% |
| Easy B (TypeScript, 5 tasks) | 5 | 100% | 100% | 100% | 100% |
| Hard (1 multi-file task/repo, 3 tasks) | 3 | 100% | 100% | 100% | 100% |

This is a ceiling effect, not evidence effort never matters — these
three levels don't discriminate. A fourth axis (held-out tests, below)
was needed to get any spread at all.

### The timing finding — stated precisely, because it does not hold at the per-task level

Aggregate cost, same three sets:

| set | off | low | medium | xhigh |
|---|---|---|---|---|
| Easy A avg wall (ratio) | 26.8s (1.00x) | 41.4s (1.54x) | 31.8s (1.19x) | 51.3s (1.91x) |
| Easy B avg wall (ratio) | 24.0s (1.00x) | 37.2s (1.55x) | 38.0s (1.58x) | 51.7s (2.15x) |
| Hard avg wall (ratio) | 41.5s (1.00x) | 60.3s (1.45x) | 46.8s (1.13x) | 101.9s (2.46x) |

**The aggregate trend is real and stable: effort costs more, and the
`xhigh` penalty grows with difficulty (1.91x → 2.15x → 2.46x).** These
agentic-loop ratios are meaningfully lower than the existing
single-turn benchmark's 3.8x for `xhigh` — a chunk of an agentic task's
wall time is fixed cost (tool round-trips, `dotnet build`, test runs)
that doesn't scale with reasoning effort, diluting the multiplier
relative to one completion call.

**The per-task ordering between `low` and `medium` is NOT predictable
from the labels.** A 5-sample follow-up on the two escalation tasks
that showed any movement (below) found `low` costing *more* than
`medium` on one task and resolving to the expected order on the other,
at the same sample size. Quote the aggregate trend; never predict a
specific task's low-vs-medium cost from the label alone.

Tool-call counts stayed flat across all arms and all three sets
(7–15, overlapping ranges throughout). Higher reasoning effort is not
buying broader exploration — it spends its extra tokens on longer
deliberation per step, not more steps or more tool calls, and so far
that deliberation has bought no additional correctness.

## Results: escalation set (held-out tests — the one axis that produced any spread)

Every task above included a pre-written test sitting in the repo,
readable by the agent with `search`/`read_file` — which means the
"ambiguity" in those prompts was never actually resolved by the
model's own judgment; the answer key was one tool call away. Six new
tasks closed that gap: the branch adds no test at all, and the harness
copies a held-out test into the scratch directory only **after** the
agent's final answer.

| task | off | low | medium | xhigh | shape |
|---|---|---|---|---|---|
| E1 major-counts | F | F | F | F | ambiguous wording, no visible test |
| E2 checkout-batch | T | T | T | F | stated contract + one unstated exception path |
| E3 migrate-summary | T | F | T | F | ambiguous wording, no visible test |
| E4 update-email | T | T | T | T | contract + unstated null-reference path |
| E5 return-batch | T | T | T | T | contract + unstated exception path (E2's shape) |
| E6 seq-numbers | T | T | T | T | contract + unstated throw-in-helper path |

### What did not discriminate: E1 and E3

**E1 is a replicated task-design finding, not a model finding.** All
four arms — on two independent runs, the second with a verified working
grader — wrote the identical, idiomatic, case-sensitive
`.GroupBy(s => s.Major)`. The prompt ("returns a Dictionary<string,int>
mapping each major to the number of students in it") gives no signal
toward case-folding a major's name. A competent 321 student writes
exactly what all four arms wrote. This measures the test author's
unstated assumption, not the model's reasoning, and is kept in the
record because it is more useful to whoever builds the next version of
this benchmark than a silently-dropped task would be.

**E3** turned out to be the same class of problem in miniature: `off`
returned `"No migrations."` against a hidden test expecting the exact
string `"No migrations found."` — a wording guess, not a reasoning
failure, on a prompt that only said to "handle the empty-list case
appropriately."

**E4 and E6 are clean 4/4 sweeps and also don't discriminate**, for a
different reason: the traps are easier to notice than E2/E5's. C#'s own
nullable-reference compiler warning (`CS8602`) flags E4's exact bug at
build time, and TypeScript's `throw` for E6 sits directly in the file
being edited. Every arm caught both.

### E2 and E3: the only cells that moved — and a 5-sample follow-up showing why that's not enough

E2 and E3 each moved between the buggy-grader run and the fixed-grader
run, in different directions, which is what triggered a dedicated
5-sample-per-arm re-run rather than trusting either single sample.

| task | off | low | medium | xhigh |
|---|---|---|---|---|
| E2 pass rate (n=5) | 4/5 (.80) | 2/5 (.40) | 4/5 (.80) | 3/5 (.60) |
| E3 pass rate (n=5) | 2/5 (.40) | 2/5 (.40) | 2/5 (.40) | 3/5 (.60) |

**No stable ordering survives at n=5.** On E2, `off` ties `medium` for
best; `low` is worst. On E3, three arms tie and `xhigh`'s edge is one
sample's difference (3-of-5 vs 2-of-5). This is the dataset that
retracts both of E2's earlier single-sample stories (an early read
favoring `medium`, a later one favoring `off`) — neither survived a
second look.

Timing at n=5, same two tasks:

| task | off mean | low mean | medium mean | xhigh mean |
|---|---|---|---|---|
| E2 | 69.5s | 116.0s | 166.7s | 176.6s |
| E3 | 52.2s | 88.2s | 68.3s | 100.4s |

E2 resolved to the expected monotonic cost order at n=5. **E3 still
shows `low` (88.2s) costing more than `medium` (68.3s) at the same
sample size.** This is the concrete evidence behind the timing-finding
caveat above: the low-vs-medium ordering is noisy per task, not a fixed
property of the labels.

## Deployment note (independent of the correctness data)

`xhigh` at `max_tokens=8000` (matching the deployed Continue `agent`
role's own setting) exceeded a client-side request timeout **four
times** over the course of these runs — twice at an initial 300s
ceiling, twice more after raising it to 900s (1102s and 1112s wall
time on those two). **A student running agent mode at `xhigh`, or
occasionally `medium`, should expect single requests that take
5–15+ minutes.** This is precisely the pathology avoided by shipping
`enable_thinking: false` across every Continue role in production —
the benchmark independently confirms that decision rather than merely
being consistent with a choice already made for other reasons.

**One subtlety worth stating on its own:** both timed-out runs still
graded `passed=True`, because a `write_file` call earlier in the
interaction had already landed correct code before the final summary
turn ran out of time. A timeout is not automatically a failure — the
code on disk is real regardless of whether the model's closing message
ever arrived. A naive harness that treated `termination=error` as
`passed=False` outright would have been wrong on both of these,
scoring a real pass as a failure. This harness excludes timed-out runs
from timing statistics (the "wall time" recorded is a timeout artifact,
not a real completion time) but still counts their on-disk code for
pass/fail, and flags the distinction explicitly in the result record
rather than silently picking one interpretation.

## Methodology: five failures that produced plausible output instead of an error

The pattern across tonight's incidents matters more than any one of
them: each produced a clean, believable number that was wrong, and
each was only caught by checking a specific dependency's actual
behavior instead of its assumed behavior.

1. **A macOS checksum assertion that passed vacuously**, regardless of
   whether the underlying value was actually correct — an earlier
   incident from the same overall engagement, included here because it
   is the same failure class as everything below.
2. **A fixed-filename report overwrite.** An earlier version of the
   matrix runner wrote every run's report to the same path regardless
   of which task list it was scoring — a second matrix run would have
   silently overwritten the first's report, making a completed result
   indistinguishable from a comparison against itself. Caught between
   launching the second run and its completion.
3. **jest's zero-match filter behavior, assumed rather than checked.**
   A `-t` filter matching nothing was assumed to print "No tests
   found." Live-checked: it exits 0 with a "N skipped, N total"
   summary, and that string never appears. Would have silently
   mis-graded every filtered TypeScript test on the untested guess.
4. **`max_tokens=2000` truncating heavy reasoning turns, read as a
   genuine final answer.** Two cells ended mid-sentence with 8–9k
   characters of reasoning content and no tool call. The harness's
   "no tool_calls → treat content as the final answer" logic cannot by
   itself distinguish a genuine stop from running out of budget.
   Detected by scanning all 84 transcripts collected up to that point
   for the signature; found in exactly 2, confirming the rest were
   clean. Fixed by raising the budget to 8000 (production's own
   value) — which means every matrix run before that fix used a
   tighter-than-production budget. Their pass/fail verdicts stand;
   their timing and verbosity numbers do not represent the deployed
   configuration.
5. **`held_out_files` never actually reached the box — the most
   severe incident.** The mechanism that copies a hidden arbiter test
   into the scratch directory was written, compiled, and confirmed
   locally, but the modified `grading.py` was never re-synced before
   16 task-runs executed against the stale copy on the box.
   `g.get("held_out_files", [])` on that stale file silently returned
   an empty list — no error, no crash, just a quiet no-op. The result
   was a clean-looking verdict on every one of those 16 runs that was
   actually grading against whatever pre-existing or self-authored
   test happened to exist, never against the intended arbiter. Caught
   by manually re-reading a transcript that looked odd, then confirmed
   by reproducing the grading step outside the matrix and finding the
   expected file simply wasn't there. Every number from those 16
   runs was discarded and the full set re-run clean.

**The lesson, stated once:** a grader that returns `False` is
indistinguishable from a grader that never actually ran, unless it is
built to fail loudly when it cannot produce a real verdict. Three
guards now exist in the harness specifically because of incident 5,
and all three would have caught it in seconds instead of an hour:

- Copying a held-out file now verifies byte-for-byte that it landed
  and raises a `GradingIntegrityError` if not.
- Every matrix run hashes its own harness code (`harness.py`,
  `grading.py`, `run_matrix.py`) at startup and can be given an
  expected hash to abort against if the two don't match — closing the
  exact sync gap behind incident 5.
- A mandatory pre-flight step grades one task's own known-unimplemented
  baseline before any real run starts, and aborts if the grader
  reports a pass on code that should not pass. A grader that cannot
  fail cannot be trusted with the real run.
- "Zero tests matched the filter" (dotnet's "no test matches," jest's
  "0 selected," pytest's exit code 5) is now treated as an error
  condition inside the grader itself, never folded into a `False`
  verdict — it is the same trap in three toolchains: zero tests
  selected and zero tests failed are indistinguishable at the exit-code
  level alone.

## Limitations

- **n=1 for every cell outside the E2/E3 multi-sample follow-up.**
  Every other pass/fail and timing number in this report is a single
  sample per (task, arm) cell.
- **The first two matrices (Easy A, Easy B) ran at `max_tokens=2000`**,
  not the production value of 8000 — their correctness verdicts stand
  (nothing was truncated at that budget except two cells fixed and
  re-run later), but their timing and token-usage numbers were
  produced under a tighter-than-deployed cap.
- **All three repos are synthetic**, built for this benchmark rather
  than drawn from real student submissions, and the TypeScript repo
  specifically never installs or runs the actual Next.js framework —
  a deliberate scope cut under a 45-minute timebox that protected the
  rest of the matrix from an open-ended `next build`/npm-install risk,
  but it means that repo's numbers don't reflect the toolchain a real
  421/521 student runs.
- **The same agent that designed every task and its expected answer
  also ran the grading.** DEFECTS.md files were written and
  live-verified against real branches before any task was scored, and
  the harness itself is fully automated and doesn't consult the task
  author's judgment at grading time — but the tasks, the held-out
  tests, and the "correct" interpretation for every ambiguous case
  were all authored by one party, not by an independent test-writer
  or the course instructors whose assignments these are modeled on.

## What's next, if this question needs a tighter answer

Six tasks were built at E2's specific shape (a stated general contract
plus one unstated exception path); only E2 itself ever showed movement,
and it moved in both directions across two samples. That is the shape
telling us it is not a reliable discriminator at this task's scale —
more tasks at this same difficulty would buy more noise, not more
signal. If a tighter answer is needed: more samples per cell (5 wasn't
enough to fully resolve E2/E3), a genuinely harder axis (larger
cross-file spans, or a task that requires revising an already-wrong
approach mid-task — nothing tried tonight required that), or grading
against real student-submitted code rather than synthetic repos
authored by the same party that wrote the tasks.
