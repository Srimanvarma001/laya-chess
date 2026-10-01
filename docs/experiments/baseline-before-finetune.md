# Baseline before fine-tuning (Laya_Chess_Training_Guide.pdf step 11)

Date: 2026-09-30. The "before" numbers every fine-tuning run is compared against.

## Setup

- **Test set:** `chess_training/data/test.jsonl`, with 332 positions from 166 games. The games are the first
  1,500 games in `lichess_db_standard_rated_2025-08` where both players are rated 2000+, the time
  control is not bullet, the game ended normally and it has at least 30 plies. Only games whose sha1(Site)
  hash falls in the **test** bucket (10%) are used. The split is by game, so any later train/calib data
  stays disjoint from this set. Two random positions are taken per game, from ply 8 onward.
  Positions already beyond ±800 cp are skipped.
- **Labels:** Stockfish 19, depth 12, one MultiPV search over **every** legal move.
- **Candidate sets:** `k16` is the guide's `candidates.py` filter (15.3 options on average).
  `all` is every legal move (33.7 on average), which is what the app sends today.
- **Metrics:** each is measured against the best Stockfish score within the offered set. Scores are clamped to ±1500 cp.
  Blunder means a loss of more than 200 cp. ECE uses 10 bins on `answer_confidence` against top-1 hits.
  Latency is wall-clock per request from Python on the same machine. The server was already running;
  whether it was started through `serve_laya.py` was not checked.
- **Random** is the exact expectation. **Material** is the app's one-ply baseline, with ties broken
  uniformly at random and reported as the expectation.

Reproduce (from `chess_training/`, with `.venv-train` active):

```
python fetch_games.py --month 2025-08 --max-games 1500 --out data/games.pgn
python gen_dataset.py --pgn data/games.pgn --stockfish ../tools/stockfish/stockfish-windows-x86-64-universal.exe \
    --out data --splits test --positions-per-game 2 --depth 12 --workers 8
python evaluate.py --predictor material --set k16
python evaluate.py --predictor laya --set k16 --state fen --model typed-decisions
```

## Results (n = 332)

| predictor | set | top-1 | top-3 | ACPL | blunder | ECE | mean conf | median ms | p90 ms | input tokens |
|---|---|---|---|---|---|---|---|---|---|---|
| random | all | 4.7% | 13.4% | 411 | 57.2% | | | | | |
| material | all | 14.0% | 27.3% | 411 | 57.5% | | | | | |
| **Laya english, fen (= app today)** | all | 6.3% | 17.2% | 379 | 52.1% | 0.156 | 0.219 | 691 | 797 | 233 |
| random | k16 | 7.9% | 22.7% | 402 | 55.1% | | | | | |
| material | k16 | 16.8% | 35.5% | 386 | 54.4% | | | | | |
| Laya english, fen | k16 | 9.3% | 26.5% | 414 | 56.6% | 0.148 | 0.242 | 670 | 751 | 217 |
| Laya english, state_text | k16 | 5.7% | 23.2% | 376 | 52.4% | 0.418 | 0.475 | 924 | 998 | 298 |
| Laya typed-decisions, fen | k16 | 10.5% | 23.5% | 376 | 52.4% | 0.064 | 0.164 | 666 | 719 | 217 |
| Laya typed-decisions, state_text | k16 | 5.1% | 21.7% | 390 | 54.2% | 0.242 | 0.293 | 917 | 984 | 298 |

With n = 332, top-1 has a standard error of about 1.5 percentage points. ACPL is noisy, roughly ±25 cp.
Treat ACPL gaps smaller than about 40 cp as noise.

## Findings

1. **Base Laya plays at about random strength.** Every Laya configuration falls within noise of random on
   top-1, top-3, ACPL and blunder rate. It is well below the material baseline on top-1 (for example 6.3% vs
   14.0% on `all`). Its lower ACPL than material (379 vs 411) mostly reflects material's habit of grabbing
   defended pieces, not skill on Laya's part.
2. **ACPL and blunder rate are poor for every predictor** (about 52–57% blunders). Neither baseline sets a
   high bar there, so a fine-tuned model has room to beat both.
3. **The `k16` filter's recall is 66%.** The guide's target is at least 90%. In a third of positions,
   Stockfish's best move is not among the 16 options at all. Fix `move_priority()` or raise K before
   generating training data.
4. **Option count barely changes latency:** 34 options took 691 ms and 16 took 670 ms, a 3% difference.
   **State length does change it:** `state_text` (298 tokens) is about 250 ms (+38%) slower than FEN (217 tokens).
5. **Routing:** without a `model` field, chess requests are auto-routed to the `english` checkpoint.
   `typed-decisions` can be pinned with `"model": "typed-decisions"`. It is the best calibrated
   (ECE 0.064), but only because its confidence is uniformly low. Neither checkpoint can play yet.
6. `state_text` raised the model's confidence without raising its accuracy, which made ECE worse. On the base
   model it has no benefit. Whether it helps after fine-tuning is still an open question (guide Part E).

Raw per-position outputs are in `chess_training/results/*.json`.
