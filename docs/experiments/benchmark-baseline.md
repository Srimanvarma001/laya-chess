# Benchmark baseline — fill this in (PROJECT.md §15–18)

Record numbers **before** changing `LAYA_THREADS`, device, or model, so every
later tuning run has something to compare against. Generated from
`scripts/benchmark_laya.py` + `docs/experiments/positions.json`.

## Environment

- Date:
- Laya version (`pip show laya`):
- Checkpoint(s) loaded (`/health` → `loaded`, `revisions`):
- Device (`LAYA_DEVICE` / `/health` → `device`):
- `LAYA_THREADS`:
- `LAYA_PRELOAD`:
- CPU / RAM / GPU (`nvidia-smi` if present):

## Test 1 — single decision (cold vs warm)

| run | ms |
|---|---|
| cold (first call) | |
| warm 1 | |
| warm 2 | |
| warm 3 | |
| warm 4 | |
| warm 5 | |
| warm mean | |

## Test 2 — batch size sweep (synthetic options)

| options | ms |
|---|---|
| 1 | |
| 5 | |
| 10 | |
| 20 | |
| 30 | |

## Test 4 — real chess positions

| id | legal moves | ms |
|---|---|---|
| startpos | 20 | |
| italian_middlegame | 35 | |
| tactic_fork | 33 | |
| back_rank_mate_pattern | 15 | |
| kp_endgame | 8 | |
| rook_endgame | 22 | |
| few_legal_moves | 1 | |

## Decision (PROJECT.md §35)

- Warm latency acceptable for a game? (y/n):
- If no: next lever to try (`LAYA_THREADS` sweep / CUDA / smaller model / candidate cap):
