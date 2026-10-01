# Laya Chess

A local-only chess prototype that tests one question: can **Laya** (an external Python
decision model) pick useful chess moves, fast enough to play against?

You play white. Laya plays black. Every Laya pick is shown next to a zero-AI one-ply
material check in a live calibration panel. Nothing is deployed and nothing leaves your machine.

## Status

| | result | source |
|---|---|---|
| Move quality (base model) | about random strength: 6.3% top-1 vs 14.0% for plain material | [`baseline-before-finetune.md`](docs/experiments/baseline-before-finetune.md) |
| Latency (CPU, warm) | about 360–450 ms for a position with 15+ legal moves | [`benchmark-baseline.md`](docs/experiments/benchmark-baseline.md) |

Fine-tuning is the next step. These two files are the "before" numbers.

## Requirements

- Python 3.10+
- Node.js 18+
- Laya is **not** vendored here. It is installed with pip (below).

## Run it

**1. Laya server** (terminal 1, repo root). Listens on `:8000`.

```powershell
# Windows PowerShell
python -m venv .venv
.venv\Scripts\activate
pip install "laya[serve]" -r scripts/requirements.txt
$env:LAYA_DEVICE="cpu"; $env:LAYA_PRELOAD="1"; python scripts/serve_laya.py
```

```bash
# macOS / Linux
python3 -m venv .venv && source .venv/bin/activate
pip install "laya[serve]" -r scripts/requirements.txt
LAYA_DEVICE=cpu LAYA_PRELOAD=1 python scripts/serve_laya.py
```

Check it: `curl http://127.0.0.1:8000/health`

**2. Frontend** (terminal 2). Opens on `http://localhost:5173`.

```bash
cd frontend
npm install
cp .env.example .env.local
npm run dev
```

The app calls Laya through the Vite proxy at `/api`, because `laya-serve` sends no CORS headers.

**3. Play.** Click a white piece, click a highlighted square. Laya replies as black.

## Other commands

```bash
npm run build                                   # in frontend/: tsc + vite build, the only type check
python scripts/test_chess_requests.py           # /health plus one raw request
python scripts/generate_positions.py            # writes docs/experiments/positions.json
python scripts/benchmark_laya.py                # latency benchmark
```

There is no lint or test runner.

## Layout

```
frontend/         React + Vite + TypeScript app
scripts/          Laya launcher, smoke test, latency benchmark
chess_training/   Stockfish-labelled test set and move-quality evaluation
docs/PROJECT.md   full spec (code comments cite it by section number)
docs/experiments/ benchmark results, test positions, security notes
laya/             notes on the local Laya install and its response shape
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| Banner says "LAYA UNAVAILABLE" | Server not running, or `VITE_API_BASE_URL` is not `/api` |
| Requests take about 1 s on Windows | Server started with plain `laya-serve`. Use `scripts/serve_laya.py` |
| Python requests take 2 s longer | Using `localhost`. Use `127.0.0.1` |
| "Could not find move probabilities" | Laya version changed the response shape. Fix `frontend/src/api/layaClient.ts` |
| Laya "TIMED OUT" | Request exceeded 15 s. Check the server terminal |

## More

- [`ARCHITECTURE.md`](ARCHITECTURE.md): how the pieces fit together, in detail
- [`docs/PROJECT.md`](docs/PROJECT.md): the full plan and what is out of scope
- [`docs/experiments/security-notes.md`](docs/experiments/security-notes.md): why the API key setup is localhost-only
