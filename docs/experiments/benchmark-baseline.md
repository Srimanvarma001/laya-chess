# Benchmark baseline (PROJECT.md §15–18)

Latency numbers for the base model, recorded **before** fine-tuning or changing
`LAYA_THREADS`, device, or model, so every later run has something to compare against.
Generated from `scripts/benchmark_laya.py` + `docs/experiments/positions.json`.
Move-quality numbers for the same base model are in `baseline-before-finetune.md`.

## Environment

- Date: 2026-10-01
- Laya version (`pip show laya`): 0.3.20 (torch 2.14.0+cpu, Python 3.12.10)
- Checkpoint(s) loaded (`/health` → `loaded`): `multilingual`, `typed-decisions`, `english`.
  `/health` returns no `revisions` field, so the revision is not recorded.
- Checkpoint that answered: `english`. The benchmark sends no `model` field and the response's
  `routing.model` was `english` (checked on the startpos request, 223 input tokens).
- Device (`/health` → `device`): cpu
- `LAYA_THREADS`: not verified. The running server's environment was not inspected.
- `LAYA_PRELOAD`: not verified directly. All three checkpoints were already loaded at `/health`.
- Server start: `python scripts/serve_laya.py` (confirmed from the process command line), so
  Windows power throttling was off. The server had been up since 13:07 and had already served requests.
- CPU / RAM / GPU: Intel Core Ultra 7 255H (16 cores, 16 threads), 47.4 GB RAM, no GPU used.
  On AC power, Windows "Balanced" power plan.
- Client: Python `urllib` on the same machine against `http://127.0.0.1:8000`, wall-clock per request.

The script was run three times back to back. Each table shows all three runs and their median.
Tests 2 and 4 take one sample per row per run, so run-to-run spread is roughly ±15%.

## Test 1 — single decision (1 synthetic option)

| | run 1 ms | run 2 ms | run 3 ms |
|---|---|---|---|
| first call | 104.9 | 98.5 | 95.4 |
| warm 1 | 116.5 | 91.6 | 92.0 |
| warm 2 | 117.1 | 96.0 | 109.3 |
| warm 3 | 104.1 | 94.4 | 102.7 |
| warm 4 | 98.0 | 94.3 | 109.2 |
| warm 5 | 124.2 | 93.8 | 108.7 |
| warm mean | 112.0 | 94.0 | 104.4 |

Warm mean over all 15 calls: 103.5 ms (median 102.7 ms).

**No true cold-start number was measured.** The server was already running with the checkpoints
loaded, so the "first call" of each run is a warm call. A cold number needs a fresh server start.

## Test 2 — batch size sweep (synthetic options)

| options | run 1 ms | run 2 ms | run 3 ms | median ms |
|---|---|---|---|---|
| 1 | 84.4 | 94.4 | 110.7 | 94.4 |
| 5 | 130.2 | 163.7 | 174.6 | 163.7 |
| 10 | 232.2 | 240.4 | 247.6 | 240.4 |
| 20 | 293.1 | 367.5 | 366.8 | 366.8 |
| 30 | 314.6 | 340.4 | 339.7 | 339.7 |

Latency grows up to about 20 options and is flat from 20 to 30.

## Test 4 — real chess positions (every legal move as a candidate)

| id | legal moves | run 1 ms | run 2 ms | run 3 ms | median ms |
|---|---|---|---|---|---|
| startpos | 20 | 388.0 | 427.8 | 485.4 | 427.8 |
| italian_middlegame | 35 | 408.1 | 450.3 | 433.9 | 433.9 |
| tactic_fork | 33 | 393.2 | 515.7 | 445.9 | 445.9 |
| back_rank_mate_pattern | 15 | 367.3 | 334.0 | 358.7 | 358.7 |
| kp_endgame | 8 | 228.7 | 243.0 | 269.8 | 243.0 |
| rook_endgame | 22 | 371.5 | 381.8 | 410.6 | 381.8 |
| few_legal_moves | 1 | 152.6 | 146.0 | 155.6 | 152.6 |

Positions with 15 or more legal moves took 334–516 ms across all runs.

## Not reconciled

`baseline-before-finetune.md` (2026-09-30) reports a median of 670–690 ms for FEN requests of
similar size (217–233 input tokens). The numbers here are about 40% lower. That run used a different
server process and it was not checked whether it was started through `serve_laya.py`, so the gap may
be power throttling. It has not been investigated. Until it is, compare post-fine-tune latency against
this file, not against the latency columns in that one.

## Decision (PROJECT.md §35)

- Warm latency acceptable for a game? yes. A full legal-move request answers in under about 0.5 s.
- Next lever to try: none needed for latency. `LAYA_THREADS` and `LAYA_CPU_AMP=bf16` were already
  measured slower than the default (see `CLAUDE.md`).

## Comparing after fine-tuning

Rerun with the server started the same way (`scripts/serve_laya.py`, cpu, on AC power), three runs:

```
python scripts/benchmark_laya.py --base-url http://127.0.0.1:8000
```

Check `routing.model` in a response to confirm the fine-tuned checkpoint is the one answering.
`benchmark_laya.py` sends no `model` field, so by default it measures whatever the server auto-routes to.
