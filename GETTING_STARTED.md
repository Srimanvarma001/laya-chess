# Getting Started — Laya Chess (Phase 0–3, local only)

This walks through getting the whole thing running **on your own laptop**,
nothing public yet. It follows the phases in [`docs/PROJECT.md`](docs/PROJECT.md)
sections 7–14 and the task list in section 36, in order. Don't skip ahead —
each phase exists to isolate a specific failure mode (model won't load vs.
server is slow vs. chess logic is wrong vs. Laya just isn't good at chess).

**What's already built for you in this repo:**
- `frontend/` — a working React+Vite+TS app: board with click-to-move (only
  legal destinations are selectable), material calculation, a calibration
  panel, and an API client (`frontend/src/api/layaClient.ts`) that calls
  Laya's `/v1/systemone` endpoint.
- `scripts/` — Python scripts for the health check, the first smoke test, and
  the latency benchmarks from PROJECT.md sections 9 and 16–18.

**What you still need to do:** install Laya itself (it's not vendored here —
Laya's license and install path are its own thing, see `laya/README.md`),
run it, and confirm the frontend can actually talk to it — because the exact
JSON shape `/v1/systemone` returns depends on your installed Laya version,
and `layaClient.ts` currently parses a *documented but unverified* shape.
That verification step is called out explicitly below (Phase 3, step 3.3) —
don't skip it.

---

## Prerequisites

- Python 3.10+
- Node.js 18+ and npm
- (Optional but recommended for Test 4 in the benchmark) `python-chess`,
  installed via `scripts/requirements.txt`
- (Optional) an NVIDIA GPU with a working CUDA + PyTorch setup, if you want
  to compare CPU vs. CUDA later. CPU-only is completely fine to start.

Commands below are given for both PowerShell (Windows) and bash (macOS/Linux)
where they differ.

---

## Phase 0 — Environment (PROJECT.md Tasks 1–4)

### 0.1 Check your machine

```powershell
# PowerShell
python --version
nvidia-smi        # only if you have an NVIDIA GPU; "not recognized" is fine, it just means CPU-only
```

```bash
# bash
python3 --version
nvidia-smi
```

### 0.2 Create a virtual environment for Laya

Do this **outside** `frontend/` — Laya is a separate Python process, not part
of the web app.

```powershell
cd laya-chess
python -m venv .venv
.venv\Scripts\activate
```

```bash
cd laya-chess
python3 -m venv .venv
source .venv/bin/activate
```

### 0.3 Install Laya with the HTTP server extra

```bash
python -m pip install --upgrade pip
pip install "laya[serve]"
pip install -r scripts/requirements.txt   # adds python-chess, used by the benchmark script
```

### 0.4 Start Laya

CPU:

```powershell
$env:LAYA_DEVICE="cpu"
$env:LAYA_PRELOAD="1"
laya-serve
```

```bash
LAYA_DEVICE=cpu LAYA_PRELOAD=1 laya-serve
```

CUDA (only if step 0.1 showed a working GPU):

```powershell
$env:LAYA_DEVICE="cuda"
$env:LAYA_PRELOAD="1"
laya-serve
```

```bash
LAYA_DEVICE=cuda LAYA_PRELOAD=1 laya-serve
```

Leave this terminal running — it's your local Laya server on `:8000`. Every
other step below happens in a **second terminal**.

**Checkpoint:** if `laya-serve` doesn't start cleanly, stop here and fix it
before continuing. Nothing downstream will work without this.

---

## Phase 1 — Confirm the server works, independent of chess (PROJECT.md §8–9, Tasks 5–8)

In a second terminal, with the same virtual environment activated:

### 1.1 Health check

```bash
curl http://localhost:8000/health
```

You should get some JSON back with something like `status`/`loaded`/`device`.
If this fails, Laya isn't actually listening — go back to Phase 0.

### 1.2 First non-chess request + latency benchmark

```bash
python scripts/test_chess_requests.py
```

This hits `/health`, then sends one simple non-chess `choice` decision and
prints the raw response. **Read the printed JSON carefully** — you'll need
its exact shape in Phase 3.

Then run the fuller benchmark:

```bash
python scripts/generate_positions.py      # writes docs/experiments/positions.json
python scripts/benchmark_laya.py
```

This runs, in order: a cold-vs-warm single-decision test, a batch-size sweep
(1/5/10/20/30 options), and a real-chess-position sweep using the positions
file. **Write the numbers down somewhere in `docs/experiments/`** — you'll
want a baseline before trying CPU thread tuning (`LAYA_THREADS`) or CUDA
later (PROJECT.md §17–18).

**Checkpoint:** if latency here already feels unacceptable for a game (many
seconds per move on the position with the most legal moves), that's real
signal — see PROJECT.md §37, Risk 2, before investing time in the frontend.

---

## Phase 2 — Run the chess frontend on its own (PROJECT.md §10, 23)

This part needs no AI at all — it's just the deterministic chess app.

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

Open the printed local URL (default `http://localhost:5173`). You should be
able to:
- click a piece → see its legal destination squares highlighted
- click a destination → the move is made
- see material balance update
- see check/checkmate/stalemate states
- reset the game

At this point the calibration panel will show `unavailable` or an error,
because nothing has connected it to Laya yet — that's expected, move to
Phase 3.

**Checkpoint:** if illegal-looking moves ever go through, or the board
desyncs from what a real chess game should allow, fix this before touching
Laya at all — everything downstream assumes this layer is 100% correct.

---

## Phase 3 — Connect the frontend to your local Laya server (PROJECT.md §11–14, Task 9)

### 3.1 Point the frontend at your running Laya server

`frontend/.env.local` (copied in step above) already defaults to:

```
VITE_API_BASE_URL=http://localhost:8000
```

which matches the `laya-serve` default port. Only change this if you started
Laya on a different port, or set `LAYA_API_KEY` (then also fill in
`VITE_LAYA_API_KEY`).

### 3.2 Play a move

With `laya-serve` still running in terminal 1 and `npm run dev` running in
terminal 2, play a legal move on the board. The calibration panel status
should go `thinking` → `connected`.

### 3.3 Verify the response parsing (do this even if step 3.2 looked fine)

`frontend/src/api/layaClient.ts` parses `/v1/systemone`'s response using a
best-effort guess at the field names (`answers.best_move.probabilities`,
etc.), based on the documented-but-not-yet-observed shape. Open your browser
console after making a move and look at what actually came back:

```js
// in decideMove(), `raw` is already returned in the response object —
// temporarily log it if you want it in the console:
console.log(decision.raw)
```

Compare that against what `layaClient.ts` expects around the comment
`// NOTE: this parsing is intentionally defensive...`. If the field names
differ, fix them there — this is the one place in the whole frontend that
needs to match your exact installed Laya version.

**Checkpoint (this is Phase 3's real goal, and PROJECT.md's central
question):** once parsing is correct, look at the calibration panel over
10–20 moves. Does Laya's top pick ever agree with the one-ply material top
pick? Does its claimed confidence look like a real probability (varies
sensibly with position) or does it look flat/random? This is the "is Laya
even useful at chess" experiment — record what you see in
`docs/experiments/`.

---

## What to do after this works

Do **not** jump to deployment yet. Next, in order, per `docs/PROJECT.md`:

1. §12 — try candidate-move reduction (top-K, captures/checks first) if the
   starting position or other high-legal-move positions are too slow.
2. §13 — try Laya's `score` or `noul` modes as alternatives to `choice` and
   compare.
3. §16 Test 3 and Test 5 — CPU vs CUDA if you have a GPU, and a reference
   engine comparison if you want a real strength baseline.
4. §5 — only once the local prototype is *actually good*, read
   "Future Deployment Option A/B/C" and the cost strategy in §34 before
   spending anything on hosting.

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---|---|---|
| `laya-serve` won't start | Python version, missing `[serve]` extra | Phase 0.3 |
| `/health` fails | server not actually running, wrong port | Phase 0.4, 1.1 |
| Board lets you make a move you don't expect | bug in `frontend/src/chess/engine.ts`, not Laya | Phase 2 checkpoint |
| Calibration panel stuck on "thinking" | request timeout (15s default in `layaClient.ts`) — check server terminal for errors | 3.2 |
| Calibration panel shows "unavailable" | server not running, wrong `VITE_API_BASE_URL`, or CORS — check Laya's server logs | 3.1 |
| Error mentions "Could not find move probabilities" | response shape doesn't match `layaClient.ts`'s parsing | 3.3 |
| Everything works but is slow | that's real signal, not a bug — see PROJECT.md §37 Risk 2 | Phase 1 benchmark numbers |
