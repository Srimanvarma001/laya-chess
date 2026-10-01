# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-only chess prototype that tests whether **Laya** (an external Python decision model, installed via `pip install "laya[serve]"`, not vendored here) can pick useful chess moves fast enough. The human plays white; Laya plays black. Every Laya pick is shown next to a zero-AI one-ply material evaluation in a calibration panel. `docs/PROJECT.md` is the full spec; code comments cite it by section number (e.g. "section 12"). `README.md` has the setup; `ARCHITECTURE.md` has the detailed design. No deployment, auth, or GPU hosting is in scope yet (PROJECT.md §27).

## Commands

Laya server (separate terminal, from repo root with `.venv` activated), listens on `:8000`:
```powershell
$env:LAYA_DEVICE="cpu"; $env:LAYA_PRELOAD="1"; python scripts/serve_laya.py   # = laya-serve with Windows power throttling off (~2x faster here)
```

Frontend (`frontend/`):
```bash
npm install
cp .env.example .env.local
npm run dev      # Vite on :5173
npm run build    # tsc -b && vite build — this is the only type check; there is no lint or test runner
```

Python scripts (`pip install -r scripts/requirements.txt` for python-chess):
```bash
python scripts/test_chess_requests.py            # /health + one raw /v1/systemone call
python scripts/generate_positions.py             # writes docs/experiments/positions.json
python scripts/benchmark_laya.py --base-url http://127.0.0.1:8000
```
Benchmark results go in `docs/experiments/`.

## Architecture

The frontend has a strict layering; keep it:

- **`frontend/src/chess/engine.ts`**: all deterministic chess logic (chess.js wrapper). It handles legality, FEN, snapshots, material, `evaluateCandidatesByMaterial` (the one-ply baseline), `materialVerdict` (agree / disagree / no_signal when every move ties), and `evaluateSettledMaterial` (capture-only search behind the eval bar). It never touches Laya. The game state is an immutable `GameSnapshot` built from FEN + SAN history, and moves are applied by candidate id (`"e2e4"`, `"e7e8q"`).
- **`frontend/src/api/layaClient.ts`**: the **only** file that knows Laya's URL, auth, and request/response shape. `decideMove(fen, candidates)` sends **one batched** `choice` request per position to `POST /v1/systemone`. It never sends one call per move. `reduceCandidates` deterministically caps the list at 64, keeping captures, checks, and promotions first, because the server rejects more than 100 options with a 413. Parsing is deliberately defensive against Laya version skew. The verified response shape for laya 0.3.20 is recorded in `laya/README.md`. Latency numbers must be measured (`performance.now()` deltas or server headers), never estimated. Fields that are unavailable are `null` and render as "n/a".
- **`frontend/src/App.tsx`**: orchestration. `handleUserMove` applies white's move, then `requestLayaBlackMove` calls `decideMove`, validates the pick against the legal moves, and applies it as black. `requestIdRef` discards stale responses. The decision, candidates, and material evals are stored for the *scored* position (black to move), so the panel does not go stale after the reply is played. It also owns the timing-driven board overlays: ghost pieces and considering lines blink while Laya thinks, then a single slide line and landing ghost show during the move animation. Timeouts are hand-tuned to Board's animation durations.
- **`components/`**: presentational pieces (Board, CalibrationPanel, EvalBar, MoveTrails SVG overlay, SessionTally agree/disagree counter). Shared types live in `src/types/index.ts`.

The codebase follows an "honesty rule": what the UI shows (counts, confidences, latencies, which candidates are lit) must reflect exactly what was sent to or returned by Laya. Don't add fabricated or smoothed values.

## Gotchas

- `laya-serve` 0.3.20 has no CORS middleware, so a browser calling `:8000` directly fails preflight. `vite.config.ts` proxies `/api` → `:8000`, so the frontend uses `VITE_API_BASE_URL=/api`.
- On Windows (Intel hybrid CPU), a plain `laya-serve` gets power-throttled onto E-cores: ~1000 ms vs ~520 ms for a 20-candidate request. Start it via `scripts/serve_laya.py`. `LAYA_THREADS` and `LAYA_CPU_AMP=bf16` were both measured slower than the default.
- From Python on Windows, use `127.0.0.1`, not `localhost`: `localhost` tries IPv6 first and adds ~2 s per request.
- `VITE_LAYA_API_KEY` is baked into the bundle. That is acceptable only for localhost (see `docs/experiments/security-notes.md`).
- Request timeout is 15s (`REQUEST_TIMEOUT_MS` in `layaClient.ts`).
