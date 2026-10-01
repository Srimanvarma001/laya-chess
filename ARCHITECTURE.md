# Architecture

How Laya Chess is put together: the processes, the frontend layers, the Laya API contract, the
timing and overlay logic, and the offline evaluation pipeline. For setup, see [`README.md`](README.md).
For the plan and the reasoning behind it, see [`docs/PROJECT.md`](docs/PROJECT.md).

## Contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [System overview](#2-system-overview)
3. [Frontend layers](#3-frontend-layers)
4. [The life of one move](#4-the-life-of-one-move)
5. [Laya API contract](#5-laya-api-contract)
6. [Candidate reduction](#6-candidate-reduction)
7. [Latency measurement](#7-latency-measurement)
8. [The honesty rule](#8-the-honesty-rule)
9. [Board overlays and timing](#9-board-overlays-and-timing)
10. [Connection states and errors](#10-connection-states-and-errors)
11. [Python scripts](#11-python-scripts)
12. [Offline evaluation pipeline](#12-offline-evaluation-pipeline)
13. [Configuration](#13-configuration)
14. [Known limitations](#14-known-limitations)
15. [Out of scope](#15-out-of-scope)

---

## 1. Purpose and scope

The project tests whether Laya, a typed-decision model served over HTTP, can choose useful chess
moves quickly enough to play against. It is an experiment, not a product.

- The human plays white. Laya plays black.
- Chess rules are enforced by deterministic code. Laya only ranks moves that are already legal.
- Every Laya pick is shown next to a one-ply material evaluation that uses no AI.
- Everything runs on one laptop. There is no deployment, auth service, or GPU hosting.

Laya itself is an external package (`pip install "laya[serve]"`). It is not vendored in this repo.

## 2. System overview

### Runtime (playing a game)

```
┌──────────────────────── Browser, http://localhost:5173 ────────────────────────┐
│                                                                                │
│   components/  Board · CalibrationPanel · EvalBar · MoveTrails · SessionTally  │
│        ▲ props                                                                 │
│   App.tsx      orchestration, state, overlay timers                            │
│        │                                   │                                   │
│        ▼                                   ▼                                   │
│   chess/engine.ts                    api/layaClient.ts                         │
│   chess.js wrapper                   the only file that knows Laya             │
│   (no network)                             │ fetch POST /api/v1/systemone      │
└────────────────────────────────────────────┼───────────────────────────────────┘
                                             ▼
                          Vite dev server proxy (vite.config.ts)
                          /api/*  →  http://localhost:8000/*
                                             ▼
                          laya-serve on :8000 (uvicorn, Python)
                          started by scripts/serve_laya.py
                          checkpoints: english, typed-decisions, multilingual
```

Two processes run during a game:

| Process | Port | Started with | Role |
|---|---|---|---|
| Laya server | 8000 | `python scripts/serve_laya.py` | Scores candidate moves |
| Vite dev server | 5173 | `npm run dev` in `frontend/` | Serves the app and proxies `/api` to `:8000` |

The proxy exists because `laya-serve` 0.3.20 has no CORS middleware. A browser page on `:5173`
calling `:8000` directly fails the preflight request (`OPTIONS /v1/systemone` returns 405). The proxy
runs in Node, where CORS does not apply, and the browser sees a same-origin request.

### Offline (measuring the model)

```
Lichess monthly dump ──fetch_games.py──▶ data/games.pgn
                                              │
                          gen_dataset.py + Stockfish (labels every legal move)
                                              ▼
                                       data/test.jsonl
                                              │
                    evaluate.py  (random / material / laya over HTTP)
                                              ▼
                     results/*.json ──▶ docs/experiments/baseline-before-finetune.md
```

This pipeline lives in `chess_training/` and shares nothing with the frontend at runtime. It talks to
the same Laya server over the same endpoint. Section 12 covers it.

## 3. Frontend layers

The frontend has four layers with a strict dependency direction. Keep it.

```
components/  ──▶  types/
App.tsx      ──▶  chess/engine.ts,  api/layaClient.ts,  components/,  types/
api/layaClient.ts  ──▶  types/          (never imports engine.ts)
chess/engine.ts    ──▶  types/, chess.js (never imports layaClient.ts)
```

### 3.1 `src/chess/engine.ts`: deterministic chess

A thin wrapper over `chess.js`. It never touches the network or Laya.

| Function | What it does |
|---|---|
| `startingSnapshot()` | Snapshot of the initial position |
| `getSnapshot(fen, history)` | Builds a `GameSnapshot` from a FEN and SAN history |
| `getLegalMoves(fen, fromSquare?)` | Legal moves as `CandidateMove[]`, optionally for one square |
| `applyMove(fen, history, candidateId)` | Plays a move by id and returns the new snapshot. Throws `Illegal move attempted: ...` if it is not legal |
| `getPieceAt(fen, square)` | Piece on a square, or `null` |
| `computeMaterial(fen)` | Material totals using P=1, N=3, B=3, R=5, Q=9, K=0 |
| `evaluateCandidatesByMaterial(fen, candidates)` | The one-ply baseline: plays each candidate on a scratch board and records the material change for the side to move, then ranks them. Tied moves share a rank |
| `materialVerdict(evals, pickId)` | `agree` if the pick is tied for the best one-ply material, `disagree` if another move wins more, `no_signal` if every move ties or the pick is not a candidate |
| `evaluateSettledMaterial(fen)` | Material balance after the available captures play out: a capture-only search with stand-pat, capped at 20 plies and 500 nodes. Returns `{ diff, complete }`. Feeds the eval bar |

Two design points:

- **State is immutable.** A `GameSnapshot` is rebuilt from scratch after each move. There is no
  long-lived `Chess` instance. A snapshot holds `fen`, `turn`, `legalMoves`, `material`, the check,
  checkmate, stalemate and game-over flags, and `history`.
- **Moves are identified by candidate id.** The id is `from + to + promotion`, for example `e2e4` or
  `e7e8q`. The same string is the option key sent to Laya, so a Laya answer maps straight back to a
  legal move with no translation.

A `CandidateMove` also carries `san`, `isCapture` (including en passant), `isCheck` and `isPromotion`.

### 3.2 `src/api/layaClient.ts`: the Laya boundary

The only file that knows Laya's URL, auth header, request shape and response shape. If the server
moves or Laya changes its JSON, this file and the `.env` value are the only things that should change.

| Export | What it does |
|---|---|
| `decideMove(fen, candidates)` | Sends one batched `choice` request and returns a parsed `LayaDecisionResponse` |
| `reduceCandidates(candidates)` | Deterministically caps the list at 64 (section 6) |
| `checkHealth()` | `GET /health`, returns `{ ok, raw }` and never throws |
| `serverLabel()` | Host string for the header status strip |
| `MAX_CANDIDATES_PER_REQUEST` | 64 |
| `LayaUnavailableError`, `LayaTimeoutError`, `LayaInvalidResponseError` | Error types that `App.tsx` maps to connection states |

`decideMove` sends **one request per position**, never one per move. Section 5 has the contract.

### 3.3 `src/App.tsx`: orchestration

Owns all application state and the turn loop. It is the only place where the engine and the Laya
client meet.

State it holds:

| State | Meaning |
|---|---|
| `snapshot` | The live position |
| `connectionState` | See section 10 |
| `decision`, `decisionCandidates`, `decisionMaterialEvals`, `decisionLatency` | Laya's last answer and the position it was scored on |
| `thinkingSent`, `thinkingLegal` | Counts for the in-flight request |
| `latencies` | Every measured request this session |
| `tally` | Agree / disagree counter against the material baseline |
| `lastMove`, `slideLine`, `landingGhost`, `consideringVisible` | Overlay and animation state (section 9) |
| `requestIdRef` | Monotonic counter used to discard stale responses |

The decision is stored together with **the position it was scored on** (black to move). After
Laya's reply is played, the live snapshot is white to move. If the panel read the live snapshot it
would show the wrong candidates, so it reads the stored ones.

### 3.4 `src/components/`: presentation

Components take props and render. None of them call Laya.

| Component | Role |
|---|---|
| `Board.tsx` | 8×8 grid of buttons. Click a piece to select it, click a highlighted square to move. Also renders ghost pieces, the check glow, last-move tint and the sliding piece animation |
| `CalibrationPanel.tsx` | Sent / legal move counter, top-5 probability bars, latency breakdown, session latency stats and sparkline |
| `MoveTrails.tsx` | SVG overlay of lines on the board. Also exports the square-geometry helpers that `Board` uses |
| `EvalBar.tsx` | Vertical material bar showing `evaluateSettledMaterial`, so a piece that can be won moves the bar before it is taken. Clamps to ±12, shows `#` for mate and `~` when the search was cut short. Hover text gives the plain on-board count |
| `SessionTally.tsx` | Agree / disagree counts and percentage, plus a separate count of "no signal" decisions that are excluded from the percentage |

`Board` calls `getLegalMoves` from the engine to find destinations for the selected piece. The only
way a move reaches the game state is `onMove(candidate)` with a candidate taken from that list, so an
illegal move cannot be produced through the UI.

### 3.5 `src/types/index.ts`

Shared types: `CandidateMove`, `GameSnapshot`, `MaterialBalance`, `MaterialEval`,
`LayaDecisionResponse`, `LayaMoveScore`, `LatencySample`, `LayaConnectionState`, `GhostInfo`.

`DecisionMode` and `LayaDecisionRequest` are declared for the `score` and `noul` modes described in
PROJECT.md §13. Only `choice` is implemented.

## 4. The life of one move

```
User clicks destination square
  │
  ▼
Board.onMove(candidate) ──▶ App.handleUserMove
  │  1. ignore unless it is white's turn
  │  2. engine.applyMove(...)            → next snapshot (black to move)
  │  3. set lastMove + slide line         → white piece animates
  │  4. clear the previous decision
  │  5. stop here if the game is over
  ▼
App.requestLayaBlackMove(next)
  │  6. requestId = ++requestIdRef
  │  7. connectionState = "thinking"
  │  8. thinkingSent / thinkingLegal from reduceCandidates(next.legalMoves)
  │  9. after 450 ms, show ghost pieces + considering lines
  ▼
layaClient.decideMove(next.fen, next.legalMoves)
  │ 10. reduceCandidates → build criteria → POST /v1/systemone
  │ 11. parse probabilities, pick, confidences, routing, usage, timings
  ▼
back in App
  │ 12. drop the result if requestIdRef moved on
  │ 13. hold until the ghost view has been up for 2 s (visual only)
  │ 14. record the LatencySample (first of the session is tagged cold start)
  │ 15. material baseline for the scored position → tally agree / disagree / no signal
  │ 16. validate: the pick must be one of next.legalMoves
  │ 17. engine.applyMove(...)            → snapshot after black's move
  │ 18. set lastMove, slide line, landing ghost → black piece animates
  │ 19. store decision + scored candidates + material evals; connectionState = "connected"
  ▼
White to move again
```

Things worth knowing about this loop:

- **Stale responses are discarded.** Every request captures `requestIdRef.current`. If it has changed
  by the time the response arrives (or during the hold in step 13), the result is dropped. `RESET`
  bumps the counter to invalidate anything in flight.
- **The pick is validated.** If Laya returns an id that is not a legal move, the decision is still
  shown in the panel, an error banner appears, and no move is played. `RETRY LAYA` re-sends the same
  position.
- **The hold in step 13 is not counted as latency.** Timings are captured inside `decideMove` before
  the hold begins. A consequence is that black's reply appears no sooner than about 2.45 s after the
  request starts (450 ms delay + 2000 ms minimum ghost view), even when Laya answers in 400 ms.
- **An illegal pick is tallied as "no signal"**, because the material check has no entry for it.
- **Health is checked once**, on mount. After that, connection state comes from request outcomes.

## 5. Laya API contract

Verified against `laya` 0.3.20. The reference copy of the response shape is in
[`laya/README.md`](laya/README.md).

### Request

`POST {VITE_API_BASE_URL}/v1/systemone`

```json
{
  "state": { "fen": "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2" },
  "questions": {
    "best_move": {
      "type": "choice",
      "instructions": "Which move is best for the side to move in this chess position?",
      "criteria": {
        "g8f6": "Nf6",
        "d7d5": "d5",
        "f8b4": "Bb4+ (check)",
        "d8h4": "Qh4"
      }
    }
  }
}
```

- `criteria` maps candidate id to a short label: the SAN, plus `(capture)`, `(check)` and
  `(promotion)` tags where they apply.
- `Authorization: Bearer <key>` is added only when `VITE_LAYA_API_KEY` is set.
- No `model` field is sent, so the server auto-routes. For a FEN it picks the `english` checkpoint.
  A `"model": "typed-decisions"` field pins the other checkpoint. Only the evaluation script uses that.

### Response

```json
{
  "model": "laya-rl-agent",
  "answers": {
    "best_move": {
      "type": "choice",
      "choice": "g8f6",
      "probabilities": { "g8f6": 0.0712, "d7d5": 0.0655 },
      "confidence": 0.12,
      "answer_confidence": 0.34,
      "action": { "act_probability": 0.99 }
    }
  },
  "usage": { "input_tokens": 223, "output_tokens": 0 },
  "routing": { "model": "english", "reason": "..." }
}
```

How each field is used:

| Field | Becomes | Shown as |
|---|---|---|
| `answers.best_move.probabilities` | `scores[]` (clamped to 0..1) | Probability bars |
| `answers.best_move.choice` | `selectedCandidateId` | The move that is played |
| `answers.best_move.confidence` | `confidence` (1 − normalised entropy) | Not shown |
| `answers.best_move.answer_confidence` | `answerConfidence` | "answer conf" |
| `routing.model`, `routing.reason` | `routingModel`, `routingReason` | "checkpoint", "Routed: ..." |
| `usage.input_tokens` | `usage` | "Tokens: N in" |
| whole body | `raw` | Logged to the console once per session |

### Defensive parsing

Parsing tolerates version skew so that a changed shape shows up as data, not a crash:

- The answer is looked up at `answers.best_move`, then `results.best_move`, then `best_move`.
- The pick is `choice`, then `selected`, then the highest-probability candidate.
- Non-numeric probabilities are skipped.
- If no probabilities are found at all, `LayaInvalidResponseError` is thrown.

### Server limits

Enforced by `laya-serve` before inference: 100 choice options per question, 512 options in total,
64 questions, 50,000 state characters. More than 100 options returns HTTP 413.

### Timing headers

`layaClient.ts` looks for inference time in the body (`timing.model_ms` and similar names) and then in
the `X-Inference-Time-Ms` and `Server-Timing` headers. On the 0.3.20 server used here, the response
carries none of them (headers checked 2026-10-01: `date`, `server`, `content-length`, `content-type`).
So `modelLatencyMs` and `overheadMs` are `null` and the panel shows "n/a" for both.

## 6. Candidate reduction

`reduceCandidates` caps a request at 64 candidates, well under the server's limit of 100.

- 64 or fewer legal moves: every move is sent, in `chess.js` order.
- More than 64: each move gets a priority of `4` for a capture, `+2` for a check, `+2` for a
  promotion. The list is sorted by priority and the top 64 are kept.

It is deterministic, so the same position always produces the same request. `App.tsx` calls the same
function to compute the "sent" count and the squares to light up, which keeps the UI consistent with
what was actually sent.

In practice the cap rarely applies. The test set averages 33.7 legal moves per position.

The offline pipeline has a **different** filter, `candidate_moves(board, k=16)` in
`chess_training/candidates.py`. See section 14.

## 7. Latency measurement

All numbers are `performance.now()` deltas around one `fetch`. Nothing is estimated.

```
t0 ── fetch() ──▶ t1 ── res.json() ──▶ t2
     network+server      parse
└──────────── total ──────────────┘
```

| Field | Definition |
|---|---|
| `networkAndServerMs` | `t1 − t0`: request sent until response headers arrive |
| `parseMs` | `t2 − t1`: reading and parsing the body |
| `totalLatencyMs` | `t2 − t0` |
| `modelLatencyMs` | Server-reported inference time, or `null` |
| `overheadMs` | `total − model`, or `null` when model time is unknown |

Each request becomes a `LatencySample`. `App.tsx` keeps the full list for the session.
`CalibrationPanel` derives LAST, AVG, MIN, MAX and P95 (nearest rank, no interpolation) and a
sparkline of the last 20 totals. The total is coloured green under 250 ms, amber up to 1000 ms,
red above.

The first request after page load or `RESET` is tagged `COLD START`. That tag means "first of this
session", not that the server was cold.

Measured baseline numbers are in
[`docs/experiments/benchmark-baseline.md`](docs/experiments/benchmark-baseline.md).

## 8. The honesty rule

Whatever the UI shows must be exactly what was sent to Laya or returned by it.

- Counts come from the same `reduceCandidates` call that builds the request.
- Confidence bars are the raw returned probabilities. They are not renormalised or smoothed.
- Latency values are measured. A value the server does not provide is `null` and renders as "n/a".
- While Laya is thinking, every sent candidate lights up at once and at equal brightness, because
  the model scores them in a single pass and no ordering exists yet.
- The visual hold that keeps the ghost view on screen is never added to a latency figure.

When adding UI, do not introduce a fabricated, interpolated or estimated value.

## 9. Board overlays and timing

The board has three layers: the grid of squares, an SVG overlay (`MoveTrails`), and a single
absolutely positioned sliding piece.

| Phase | What is on the board |
|---|---|
| White moves | Slide line under white's piece, which fades as the piece travels |
| Laya thinking | After 450 ms: a ghost piece on every candidate destination plus thin "considering" lines, pulsing |
| Laya's move lands | One bright slide line and one pinned landing ghost at the destination. Both vanish as the piece arrives |
| Idle | Only the last-move / top-pick square tint. No candidate lines remain |

Laya's reasoning is kept in the calibration panel. No candidate lines stay on the board after a move.

Timing constants, which are hand-tuned to each other:

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `GHOST_VIEW_DELAY_MS` | 450 | `App.tsx` | Lets white's move land before ghosts appear |
| `GHOST_VIEW_MIN_MS` | 2000 | `App.tsx` | Two full 1 s glow cycles, so the view ends on a fade-out |
| `MOVE_SLIDE_MS` | 380 | `Board.tsx` | Straight slide duration |
| `MOVE_KNIGHT_MS` | 620 | `Board.tsx` | Knight L-hop duration |
| slide line unmount | `MOVE_KNIGHT_MS + 250` | `App.tsx` | Line outlives the glide slightly |
| landing ghost unmount | `MOVE_KNIGHT_MS + 60` | `App.tsx` | Ghost dissolves on arrival |
| sliding piece unmount | `MOVE_KNIGHT_MS + 60` | `Board.tsx` | Hands back to the static piece |
| `--sq-size` | 56px | `styles.css` | Single source of truth for square size |

`MOVE_SLIDE_MS` and `MOVE_KNIGHT_MS` must match `.move-anim` and `.move-knight` in `styles.css`.
Changing one side without the other makes the piece jump at the end of its slide.

Geometry is never hardcoded. `getSquareSizePx()` reads `--sq-size` from the live stylesheet, and both
the SVG coordinates and the slide animation derive from it, so the board scales as one unit.

Knights travel an L, long leg first (`knightCorner`). The trail line and the sliding piece use the
same corner, so the piece rides the line.

`Board` swaps to the sliding copy in `useLayoutEffect`, not `useEffect`. The new FEN already has the
piece on its destination, so the swap has to happen before paint or the piece flashes at the
destination for a frame.

## 10. Connection states and errors

`LayaConnectionState` drives the status pill, the banner text and the banner colour.

| State | Set when |
|---|---|
| `idle` | Initial value, before the health check returns |
| `connected` | Health check passed, or a request completed |
| `thinking` | A request is in flight |
| `unavailable` | Health check failed, network error, HTTP 401, or any other non-OK status |
| `timeout` | Request aborted after 15 s, or HTTP 503 |
| `invalid_response` | HTTP 413 or 422, body is not JSON, or no probabilities found |

`connecting` is declared in the type but `App.tsx` never sets it.

Error mapping inside `decideMove`:

| Condition | Error thrown |
|---|---|
| `fetch` aborted by the 15 s timer | `LayaTimeoutError` |
| `fetch` rejected for any other reason | `LayaUnavailableError` |
| HTTP 413 or 422 | `LayaInvalidResponseError`, message includes how many candidates were sent |
| HTTP 401 | `LayaUnavailableError`, message points at the API key settings |
| HTTP 503 | `LayaTimeoutError` |
| Other non-OK status | `LayaUnavailableError` |
| Body is not valid JSON | `LayaInvalidResponseError` |
| No probabilities in the body | `LayaInvalidResponseError` |

The board is disabled while the game is over, while it is black's turn, and while Laya is thinking.

## 11. Python scripts

All in `scripts/`. They use only the standard library plus `python-chess`
(`scripts/requirements.txt`).

| Script | Purpose |
|---|---|
| `serve_laya.py` | Starts `laya-serve` after opting the process out of Windows power throttling. A no-op wrapper on macOS and Linux |
| `test_chess_requests.py` | Hits `/health`, sends one non-chess `choice` request and prints the raw response |
| `generate_positions.py` | Writes seven fixed FENs to `docs/experiments/positions.json` |
| `benchmark_laya.py` | Latency benchmark: single decision, option-count sweep (1/5/10/20/30), and the seven real positions |

### Why `serve_laya.py` exists

On an Intel hybrid CPU, Windows treats a background console process as low-priority work and
schedules it on the efficiency cores. `serve_laya.py` calls `SetProcessInformation` with
`ProcessPowerThrottling` to turn that off, then imports and runs Laya's server `main`. The opt-out
happens before the import so that torch's worker threads start unthrottled. The measured effect was
roughly 1000 ms down to 520 ms for a 20-candidate request.

## 12. Offline evaluation pipeline

`chess_training/` measures how good Laya's picks are, using Stockfish as ground truth. It follows
`Laya_Chess_Training_Guide.pdf`. It runs in its own virtual environment (`.venv-train`) and needs
`python-chess` and `zstandard`. There is no requirements file for it yet.

### Stages

| Stage | Script | Input | Output |
|---|---|---|---|
| Fetch | `fetch_games.py` | Lichess monthly `.pgn.zst`, streamed | `data/games.pgn` (git-ignored) |
| Label | `gen_dataset.py` | `games.pgn` + a Stockfish binary | `data/{train,calib,test}.jsonl` |
| Score | `evaluate.py` | `data/test.jsonl` + a running Laya server | `results/<predictor>__<set>.json` |

**Fetch.** Streams the start of a monthly Lichess dump and stops after `--max-games` games pass the
filter: both players rated 2000+, base time at least 180 s, normal termination, at least 30 plies.
Only a few megabytes are downloaded.

**Label.** For sampled positions (from ply 8, skipping positions beyond ±800 cp), runs one Stockfish
MultiPV search across **every** legal move. That single search gives labels for both candidate sets
and gives the filter's recall for free. Games are assigned to a split by `sha1(Site) mod 100`:
train below 80, calib 80–89, test 90–99. A game's split never depends on which splits are being
generated, so a test set built now stays disjoint from training data built later. Only the `test`
split exists so far (332 positions from 166 games).

**Score.** Runs one predictor over the test set and writes a summary plus per-position results.

### Row format (`test.jsonl`)

| Field | Meaning |
|---|---|
| `game_id`, `split`, `ply` | Where the position came from |
| `fen` | Position, as the app sends it today |
| `state` | `state_text(board)`: piece lists in words, the guide's alternative format |
| `options` | The `k16` candidate set as `{id, label}` |
| `cp` | Stockfish centipawns for each `k16` candidate |
| `best`, `soft` | Best candidate in the set, and a soft target distribution `exp((cp − best) / 100)` |
| `legal`, `legal_cp` | Every legal move and its score |
| `true_best` | Best move over all legal moves |
| `filter_recall_hit` | Whether `true_best` is inside the `k16` set |

### Predictors and candidate sets

| Predictor | What it is |
|---|---|
| `random` | Uniform over the options, reported as the exact expectation |
| `material` | The app's one-ply material baseline. Ties are scored as the expectation over a uniform tie-break |
| `laya` | One batched `/v1/systemone` request per position, with `--state fen|text` and optional `--model` |

| Set | What it is |
|---|---|
| `all` | Every legal move. This matches what the app sends |
| `k16` | The guide's top-16 filter from `candidates.py` |

### Metrics

All are relative to the best Stockfish score **within the offered set**, with scores clamped to
±1500 cp.

- **top-1 / top-3:** the pick (or one of the three most probable) scores as well as the best option.
- **ACPL:** mean centipawn loss.
- **blunder:** share of picks losing more than 200 cp.
- **ECE:** 10-bin expected calibration error of `answer_confidence` against top-1 hits.
- **latency:** wall-clock per request, median and p90.

Results and findings are in
[`docs/experiments/baseline-before-finetune.md`](docs/experiments/baseline-before-finetune.md).

### `candidates.py`

Copied from the training guide's appendix. It defines `candidate_moves` (the top-K filter),
`state_text` (the wordy state format) and `option_label` (SAN plus tags). The guide requires
training data, evaluation and the app to build questions with identical logic. The label format
already matches `layaClient.ts`. The candidate filter does not (section 14).

## 13. Configuration

### Frontend (`frontend/.env.local`, git-ignored)

| Variable | Value | Notes |
|---|---|---|
| `VITE_API_BASE_URL` | `/api` | Goes through the Vite proxy. Also the fallback in `layaClient.ts` when the variable is unset. Pointing it straight at `http://localhost:8000` fails CORS in a browser |
| `VITE_LAYA_API_KEY` | empty | Set only if the server was started with `LAYA_API_KEY` |

Any `VITE_*` value is compiled into the JavaScript bundle in plain text. That is acceptable only
because everything runs on localhost. See
[`docs/experiments/security-notes.md`](docs/experiments/security-notes.md).

### Laya server (environment variables)

| Variable | Used value | Notes |
|---|---|---|
| `LAYA_DEVICE` | `cpu` | `cuda` if a GPU is available |
| `LAYA_PRELOAD` | `1` | Loads checkpoints at startup |
| `LAYA_THREADS` | unset | Measured slower than the default when set |
| `LAYA_CPU_AMP` | unset | `bf16` was measured slower than the default |
| `LAYA_API_KEY` | unset | Enables bearer auth on the server |

### Constants in code

| Constant | Value | File |
|---|---|---|
| `REQUEST_TIMEOUT_MS` | 15000 | `layaClient.ts` |
| `MAX_CANDIDATES_PER_REQUEST` | 64 | `layaClient.ts` |
| `LATENCY_GREEN_MAX_MS` / `LATENCY_AMBER_MAX_MS` | 250 / 1000 | `CalibrationPanel.tsx` |
| Vite port and proxy target | 5173, `http://localhost:8000` | `vite.config.ts` |

## 14. Known limitations

- **Base Laya plays at about random strength.** See the baseline file. Fine-tuning is the next step.
- **The app and the training pipeline filter candidates differently.** The app sends every legal
  move (up to 64). The pipeline's `k16` filter keeps 16, and its recall is 66% against a 90% target.
  One of them has to change before training data and the app agree.
- **The material check is silent in most quiet positions.** When every move ties on one-ply
  material, the decision is counted as "no signal" and left out of the agreement percentage, so the
  percentage is built only from positions where a capture or promotion was available.
- **The eval bar is material only.** It sees pieces that can be won by captures, but not threats,
  forks, pins or anything positional. Its capture search is capped at 20 plies and 500 nodes; a
  capped result is shown with a `~` prefix.
- **White always promotes to a queen.** `Board` auto-queens. Laya can still under-promote, because
  all four promotion candidates are sent.
- **Black's reply is visually delayed** to at least about 2.45 s (section 4).
- **Server inference time is unavailable** on laya 0.3.20, so MODEL and OVERHEAD show "n/a". The
  installed `laya/serve.py` has no timing header or body field to turn on.
- **Unused code paths:** `MoveTrails` has a `resolved` mode and `App.tsx` has `buildResolvedTrails`,
  but the resolved trails are only logged to the console and not drawn.
- **No automated tests or lint.** `npm run build` (TypeScript) is the only check.
- **Draws other than stalemate have no banner.** `isGameOver` disables the board, but the banner
  only names checkmate and stalemate.

## 15. Out of scope

Deliberately not built yet (PROJECT.md §27): production GPU hosting, payments, user authentication
and accounts, multiplayer servers, databases, analytics, a custom model-serving stack, microservices,
in-browser ONNX inference, and a paid inference API. There is also no public URL or tunnel, and no
server-side proxy for the API key (PROJECT.md §20–22 describe those as later phases).
