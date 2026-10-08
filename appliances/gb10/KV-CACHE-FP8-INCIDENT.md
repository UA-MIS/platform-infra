# Repeating output on the GB10: `--kv-cache-dtype=fp8` (found 2026-10-08)

**Rule: do not pass `--kv-cache-dtype=fp8` to vLLM on this machine.** It is
removed from `docker-compose.yml`; this page is why.

## Symptom

A tester saw output like `!ductductduct` and Continue's "model is repeating the
same chunk" error mid-task.

## Cause

On GB10 (SM121), vLLM warns at boot that the fp8 KV cache has **no calibration
data** and falls back to `q_scale=1.0`. The quantisation error compounds with
sequence depth until the output locks into a repetition loop. Same failure,
documented elsewhere:
<https://ai-muninn.com/en/blog/dgx-spark-fp8-kvcache-repetition>.

## Measurement

Free-text prose, temperature 0, a repeat detector over substring periods 1..24.

| prompt tokens | with fp8            | without fp8   |
|---------------|---------------------|---------------|
| 11,224        | clean               | clean         |
| 17,624        | **99x ' Register'** | clean         |
| 56,024        | degenerate          | clean         |
| 112,024       | —                   | clean (61 s)  |

Removing it also made generation **~40% faster: 25.84 → 36.13 tok/s.**
Mechanism: fp8 corrupted the target model's distribution, so the DFlash2
speculative drafts were rejected wholesale. Draft acceptance was pinned at
exactly 1.00 (i.e. nothing accepted) while the drafter still produced
53 tok/s of wasted work. With BF16 KV, acceptance is 3.0–7.3. fp8 therefore
cost correctness *and* throughput, to save memory the box has plenty of.

BF16 KV on this config: `Available KV cache memory: 53.62 GiB`,
`GPU KV cache size: 605,692 tokens` → a full 262,144-token request still leaves
about 2.3x concurrency.

## What changed in git

- `--kv-cache-dtype=fp8` removed from the `vllm` service, with a do-not-re-add
  comment.
- `--max-model-len=262144` (it was already 262144 in git; the box had been
  hand-edited to 131072 as a conservative measure, which the measurement shows
  was unnecessary).
- `litellm-config.yaml`: `max_input_tokens` 24576 → **253952** on both model
  entries, `max_output_tokens` stays 8192, so 253952 + 8192 = 262144. The old
  pair summed to 32768 — the window before commit `07e901c` raised it to
  262144 — so for nine days LiteLLM was capping requests at ~24k of a 262k
  window. These numbers must move with `--max-model-len`.

## Honest caveat: the fix is not formally isolated

`--max-model-len` changed in the same edit as removing fp8, and some models
derive their RoPE scaling from it. fp8 is the documented cause and the failure
began at 17.6k tokens, far below either window, so it is the likely whole story —
but the two changes were not separated. Raising the window to 262144 is itself
partly the test. Follow-up: re-run the correctness sweep at 150k / 200k / 250k
on the deployed config.

## Why the 2026-09-29 long-context test cleared a broken config

The 2026-09-29 long-context tool-call test (`artifacts/exploration/2026-09-29-gb10-longcontext-toolcall-test.md` in the project workspace, not this repo) tested to
118,337 tokens and passed. It measured **tool-call structural integrity only**:
short structured output (a JSON tool call) stays valid under fp8 error, while
free-text prose rots. Nothing regressed afterwards: `--kv-cache-dtype=fp8` was already live
about four hours before that test (`cc5a3dd` at 02:27 vs the artifact at
06:38; at that commit `--max-model-len` was still 32768; the 262144 window
arrived later, in `07e901c`). The artifact stated its limitation honestly; the conclusion drawn from
it ("long context is fine") quietly exceeded what it measured. When testing a
long-context change, **generate long free-text prose and run a repeat detector**
— do not rely on structured-output checks alone.

## Second SM121 hazard (credible, NOT observed or tested here)

CUTLASS FP4 kernels target SM120, not SM121, and can emit `!!!!!`. This box logs
`Using FlashInferCutlassNvFp4LinearKernel for NVFP4 GEMM` and sets no `VLLM_*`
overrides. If garbage output ever returns and it is *not* the KV cache, try:

```
VLLM_NVFP4_GEMM_BACKEND=marlin
VLLM_MXFP4_USE_MARLIN=1
VLLM_USE_FLASHINFER_MOE_FP4=0
--attention-backend=TRITON_ATTN
```

## Process lesson

This box has no reconciler, so the hand-edit that fixed it was invisible to git
and a pull would have silently reverted it (the same gap served an eight-day-old
build earlier the same day). Fix it in the repo, then pull.
