# Laya Chess — Local-First AI Chess Decision Game

## Project Overview

**Laya Chess** is a web-based chess game that uses **Laya**, a non-autoregressive System 1 decision engine, to make or evaluate chess decisions.

The project is intentionally designed **local-first**:

- The chess board and all deterministic chess logic run in the browser.
- Laya initially runs on the developer's own laptop.
- The browser talks to Laya through a small local HTTP API.
- A tunnel can later expose that API to the public internet for testing.
- Only after the local version is proven useful will deployment, public hosting, GPU infrastructure, scaling, or paid APIs be considered.

The main goal of the first phase is **not to make the project production-ready**. The goal is to answer a much more important question:

> **Can Laya make useful chess decisions fast enough on the available laptop hardware to create a good game experience?**

If the answer is yes, the same API architecture can later be moved from the laptop to a GPU server with minimal changes to the frontend.

---

## 1. Why This Architecture?

There were initially two obvious approaches:

### Option A — Run Laya inside every user's browser

```text
User opens website
        ↓
Download a large Laya model
        ↓
Initialize ONNX Runtime Web
        ↓
Run inference on user's CPU/GPU
```

This removes inference-server costs, but it creates a major UX problem: the browser model can be hundreds of megabytes. For a small chess game, forcing a new visitor to download hundreds of megabytes before playing is undesirable.

### Option B — Run Laya on a server

```text
Browser
   ↓
small API request
   ↓
Laya server
   ↓
response
```

This produces a much better user experience, but a permanently available GPU server introduces cost.

### Chosen Phase-1 approach — Run Laya on the laptop

```text
                    DEVELOPMENT LAPTOP

        ┌──────────────────────────────────────┐
        │                                      │
        │   Laya model                         │
        │       ↓                              │
        │   Laya HTTP server :8000             │
        │       ↑                              │
        │       │                              │
        │   Chess/API test client              │
        │                                      │
        └──────────────────────────────────────┘

                 later, optionally
                        ↓
                 Cloudflare Tunnel
                        ↓
                  public test URL
```

This gives the project a **zero-cost development path** and lets us measure real performance before spending money.

---

## 2. Current Laya Capabilities Relevant to This Project

The current Laya project describes itself as a multilingual, non-autoregressive System 1 decision engine. It supports typed decisions such as:

- `choice` — select one option from several alternatives
- `score` — return a score on a defined scale
- `noul` — return a yes/no probability

Laya exposes a local HTTP server through `laya.serve` with a Jev-compatible `POST /v1/systemone` endpoint. The server supports environment-based configuration including device selection, model preloading, CPU thread limits, model selection, and an optional bearer token.

The official repository also documents direct model loading through the Python SDK and batched decision inference in a single forward pass.

### Important research conclusion

Laya's published benchmark results demonstrate decision-making performance and latency on classification/decision workloads. They **do not prove that Laya is already a strong chess engine**.

Therefore, this project must treat chess performance as an experiment rather than an assumption.

Official sources:

- https://github.com/NandhaKishorM/laya
- https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py
- https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md

---

## 3. Core Product Idea

The game should feel like a normal lightweight chess website.

The user should be able to:

1. Open the game.
2. See a chess board immediately.
3. Make legal moves.
4. Receive an AI response/evaluation.
5. See useful information such as material balance, AI confidence/probabilities, candidate moves, or calibration information.
6. Continue playing without needing to understand the underlying AI architecture.

The AI layer should be invisible from a UX perspective.

---

## 4. High-Level System Architecture

### Phase 1 — Everything local

```text
┌──────────────────────────────────────────────────────────┐
│                    DEVELOPMENT LAPTOP                    │
│                                                          │
│  ┌─────────────────────┐       ┌─────────────────────┐   │
│  │   Web App           │       │   Laya Server       │   │
│  │   React / Vite      │◄─────►│   localhost:8000    │   │
│  │                     │ HTTP  │                     │   │
│  │ - Board             │       │ - Model             │   │
│  │ - Legal moves       │       │ - Inference         │   │
│  │ - FEN               │       │ - /health           │   │
│  │ - Material          │       │ - /v1/systemone     │   │
│  │ - UI / calibration  │       │                     │   │
│  └─────────────────────┘       └─────────────────────┘   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### Phase 2 — Public testing from the laptop

```text
Browser
   │
   ▼
Static frontend
   │
   │ HTTPS request
   ▼
Public tunnel URL
   │
   ▼
Developer laptop
   │
   ▼
Laya :8000
```

### Phase 3 — Optional production deployment

```text
Browser
   │
   ▼
Static frontend
   │
   ▼
Small API / gateway
   │
   ▼
GPU inference provider
   │
   ▼
Laya
```

The frontend should use an environment-configurable API base URL so this migration does not require a rewrite.

---

## 5. Technology Stack

### Frontend

Recommended:

- React
- Vite
- TypeScript
- CSS or Tailwind CSS
- A chess rules library such as `chess.js` or an equivalent deterministic implementation

### Backend / Local API

Initially:

- Laya's built-in HTTP server
- FastAPI/Uvicorn only if a custom gateway becomes necessary

### AI

- Laya
- PyTorch backend initially
- CUDA when a supported NVIDIA GPU is available
- CPU fallback otherwise

### Future deployment options

Not part of Phase 1, but possible later:

- Cloudflare Pages / Vercel / GitHub Pages for static frontend
- RunPod Serverless, Replicate, or another GPU service for Laya
- A lightweight API gateway to protect credentials and normalize requests

---

## 6. Repository Structure

A practical initial structure:

```text
laya-chess/
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── chess/
│   │   ├── api/
│   │   ├── calibration/
│   │   ├── hooks/
│   │   └── types/
│   ├── public/
│   └── package.json
│
├── laya/
│   └── local server / environment notes
│
├── scripts/
│   ├── benchmark_laya.py
│   ├── test_chess_requests.py
│   └── generate_positions.py
│
├── docs/
│   └── experiments/
│
├── .env.example
├── README.md
└── PROJECT.md
```

The actual Laya installation should remain outside the frontend source tree when convenient, using a Python virtual environment.

---

## 7. Local Environment Setup

### 7.1 Check Python

Laya currently requires Python 3.10 or newer.

```powershell
python --version
```

### 7.2 Check NVIDIA GPU

On Windows with an NVIDIA GPU:

```powershell
nvidia-smi
```

This tells us whether CUDA-capable hardware is available and shows the GPU/VRAM information.

### 7.3 Create a virtual environment

```powershell
mkdir laya-chess
cd laya-chess

python -m venv .venv
.venv\Scripts\activate
```

### 7.4 Install Laya with the HTTP server extra

```powershell
python -m pip install --upgrade pip
pip install "laya[serve]"
```

The official Laya README documents `laya[serve]` for the HTTP server.

### 7.5 Start Laya on CPU

```powershell
$env:LAYA_DEVICE="cpu"
$env:LAYA_PRELOAD="1"
laya-serve
```

### 7.6 Start Laya on CUDA

When the local environment has a working CUDA-enabled PyTorch installation:

```powershell
$env:LAYA_DEVICE="cuda"
$env:LAYA_PRELOAD="1"
laya-serve
```

The default listening port is `8000`.

Official server source:

https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py

---

## 8. Health Check

Once Laya is running, test it independently of the chess app.

```powershell
curl http://localhost:8000/health
```

Expected conceptually:

```json
{
  "status": "ok",
  "loaded": true,
  "device": "cpu"
}
```

or `cuda` when running on CUDA.

The exact response should be treated as whatever the currently installed Laya version returns.

---

## 9. First API Test

The first successful test should be a non-chess decision.

This isolates model/API problems from chess problems.

Example request shape:

```json
{
  "state": {
    "body": "billed twice, refund please or we cancel"
  },
  "questions": {
    "dept": {
      "type": "choice",
      "instructions": "which team?",
      "criteria": {
        "billing": "refunds",
        "tech": "bugs"
      }
    }
  }
}
```

The purpose is simply to verify:

- Laya loads.
- The HTTP server works.
- JSON requests work.
- A typed decision comes back.
- Latency is measurable.

Do not build the complete chess frontend until this works reliably.

---

## 10. Chess Representation

Chess should be represented deterministically in the frontend.

The browser should maintain the authoritative game state and generate a standard chess position representation such as FEN.

For example:

```text
Current board state
      ↓
FEN
      ↓
legal moves
      ↓
candidate move representations
```

For every user move, the application should know:

- current FEN
- side to move
- legal moves
- material balance
- game status
- move history

The browser should calculate these locally because there is no reason to ask Laya to perform deterministic chess bookkeeping.

---

## 11. The Initial-Move / Many-Legal-Moves Problem

A starting chess position can contain many legal candidate moves.

A bad architecture would make one HTTP request per legal move:

```text
move 1 → Laya
move 2 → Laya
move 3 → Laya
...
move N → Laya
```

This introduces unnecessary network requests and inference overhead.

### Preferred approach: batch the decision

Represent the candidate moves as a single decision request where practical:

```text
Current position
      ↓
Generate legal moves
      ↓
Build candidate options
      ↓
ONE Laya request
      ↓
Probability / score for candidates
```

Laya supports multiple typed questions in one forward pass, and its current published benchmarks show substantial batching benefits.

However, Laya documentation also recommends keeping a `choice` decision to a manageable number of options. Therefore, the project should **not blindly pass every legal chess move into one giant choice list**.

This is an experimental problem to solve.

---

## 12. Candidate-Move Reduction Strategy

The preferred architecture is to separate **chess logic** from **AI decision selection**.

### Layer 1 — Deterministic chess filtering

Use the chess rules engine to remove illegal moves.

### Layer 2 — Candidate reduction

Possible candidate-reduction ideas to benchmark:

- Keep all legal moves when the count is small.
- Use simple deterministic filters for obviously poor moves.
- Limit candidates to a configurable top-K set.
- Treat captures, checks, promotions, and tactical responses as priority candidates.
- Explore a shallow traditional-engine prefilter later if required.

### Layer 3 — Laya decision

Send the reduced candidate set to Laya.

### Layer 4 — Calibration

Convert raw model outputs into a calibrated probability/score representation for the UI.

The important principle is:

> **Do not ask Laya to solve deterministic chess rules. Use Laya where actual judgment is required.**

---

## 13. What Laya Should Actually Predict

Several possible product modes should be tested rather than assuming one format.

### Mode A — Best move selection

```text
Position + candidate moves
        ↓
Laya choice
        ↓
selected move
```

### Mode B — Move quality scoring

```text
Position + one candidate move
        ↓
Laya score
        ↓
quality score
```

Run once per candidate or in a batched request where appropriate.

### Mode C — Win/lose preference question

```text
Position + candidate move
        ↓
Laya noul
        ↓
probability of desired outcome
```

### Mode D — Hybrid evaluation

Use one decision for move selection and additional decisions for explanation or confidence.

The first version should compare these approaches experimentally.

---

## 14. Calibration Panel

A calibration panel is a first-class part of the research/demo UI.

It should expose:

- raw model probability
- calibrated probability
- temperature value
- number of candidate moves
- inference time
- total request time
- selected move
- confidence
- model/checkpoint name

Example:

```text
Laya
────────────────────────
Selected move: Nf3
Raw confidence:        0.71
Calibrated confidence: 0.64
Temperature:           1.20
Candidates evaluated:  12
Model latency:       180 ms
Request latency:     235 ms
```

This makes the project useful as an experiment even when the model's chess quality is still being investigated.

---

## 15. Performance Metrics

The project should record at least these timings:

### Startup metrics

- Python/server startup time
- model loading time
- first inference time
- warm inference time

### Per-move metrics

- legal-move generation time
- request serialization time
- network/HTTP time
- Laya inference time
- response parsing time
- total AI response time

### Chess metrics

- number of legal moves
- number of candidate moves sent to Laya
- selected move
- optional comparison against a reference engine

---

## 16. Benchmark Plan

The first benchmark should be local and reproducible.

### Test 1 — Single decision

Measure:

```text
cold start
warm start
1 decision
```

### Test 2 — Batch size

Measure:

```text
1 candidate
5 candidates
10 candidates
20 candidates
30 candidates
```

Do not assume that larger batches are always better; measure actual latency.

### Test 3 — CPU vs CUDA

When both are available:

```text
CPU
vs
CUDA
```

### Test 4 — Real chess positions

Create a fixed benchmark set containing:

- opening positions
- middlegame positions
- tactical positions
- endgame positions
- positions with many legal moves
- positions with very few legal moves

### Test 5 — Reference-engine comparison

Use a conventional chess engine only as a **benchmark/reference**, not as a replacement for the Laya experiment.

Possible reference metrics:

- whether Laya's top move matches the reference engine's top move
- ranking overlap
- whether tactical blunders occur
- move consistency
- confidence calibration

The reference engine should provide an evaluation baseline; it should not be allowed to leak the answer into Laya's inputs.

---

## 17. Important Current Laya Performance Information

The current Laya repository reports published T4 measurements around:

| Questions / call | Laya | Laya multilingual |
|---:|---:|---:|
| 1 | ~39.5 ms | ~32.8 ms |
| 5 | ~84.5 ms | ~40.1 ms |
| 10 | ~158.6 ms | ~72.3 ms |
| 50 | ~771 ms | ~337 ms |

These are GPU benchmark results and are **not a prediction for the developer's laptop**.

The same benchmark file contains a Ryzen 9 6900HX laptop-CPU measurement in which thread tuning reduced a three-question HTTP call from roughly 9.4 seconds to about 783 ms on a busy WSL2 host. This strongly demonstrates why local benchmarking is necessary.

Sources:

- https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md
- https://github.com/NandhaKishorM/laya/blob/main/README.md

---

## 18. CPU Thread Tuning

On CPU, thread settings can have a large effect.

The current Laya server exposes `LAYA_THREADS` specifically to cap PyTorch intra-op threads.

A future CPU benchmark should test values such as:

```text
LAYA_THREADS=1
LAYA_THREADS=2
LAYA_THREADS=4
LAYA_THREADS=6
LAYA_THREADS=8
```

The best value is hardware-dependent. The benchmark should optimize for **latency per chess move**, not maximum benchmark throughput.

---

## 19. Concurrency Experiment

After one-player performance is understood, test multiple simultaneous requests.

For example:

```text
1 player
2 players
5 players
10 requests
```

Measure:

- p50 latency
- p95 latency
- queueing delay
- error rate
- CPU utilization
- GPU utilization
- RAM/VRAM utilization

This answers whether the laptop can handle a public demo without becoming unusable.

---

## 20. Local Public Testing

After the game works entirely on the laptop, a tunnel can make the local API reachable from another device.

A simple development flow can use a tunnel such as Cloudflare Tunnel.

Conceptually:

```text
localhost:8000
      ↓
cloudflared
      ↓
public HTTPS URL
      ↓
phone / another laptop / friend
```

This should be considered **testing infrastructure**, not production infrastructure.

For example, Cloudflare documents quick tunnels for exposing local development servers for temporary testing.

Official documentation:

https://developers.cloudflare.com/tunnel/get-started/

---

## 21. Security for the Local API

Even during testing, avoid exposing an unrestricted inference endpoint.

The Laya server supports `LAYA_API_KEY` and bearer authentication.

Example concept:

```text
LAYA_API_KEY=<random-secret>
```

The client sends:

```http
Authorization: Bearer <random-secret>
```

For a public tunnel, the preferred architecture is eventually:

```text
Browser
   ↓
small authenticated proxy
   ↓
local Laya API
```

The raw Laya key should not be hard-coded into frontend JavaScript.

---

## 22. Important Product Principle: Don't Expose Secrets in the Browser

Bad:

```text
React app
   ↓
contains provider API key
```

Good:

```text
React app
   ↓
requests your API
   ↓
server-side secret
   ↓
Laya/provider
```

The Phase-1 laptop architecture is useful because Laya itself is local. When the project later uses a paid external inference provider, the same principle must be retained.

---

## 23. Browser Responsibilities

The frontend should own all deterministic and presentation logic:

### Chess

- board rendering
- drag/drop or click-to-move
- legal move validation
- check/checkmate/stalemate detection through the chess library
- FEN generation
- PGN/move history
- turn state
- game reset

### Analysis

- material count
- candidate move display
- confidence charts
- calibration UI
- latency display
- AI status

### Networking

- request creation
- timeout
- retry
- cancellation where possible
- response validation
- error states

The frontend should not know how Laya is hosted.

---

## 24. API Abstraction in the Frontend

Create a tiny API interface rather than calling Laya directly throughout the React codebase.

Example conceptual interface:

```ts
interface LayaDecisionRequest {
  position: string;
  candidates: CandidateMove[];
  mode: "choice" | "score" | "noul";
}

interface LayaDecisionResponse {
  answers: unknown;
  latencyMs: number;
}
```

Then the frontend uses:

```text
Chess UI
   ↓
Game analysis service
   ↓
Laya client
   ↓
HTTP API
```

This is important because later the implementation can change from:

```text
http://localhost:8000
```

to:

```text
https://api.yourdomain.com
```

without changing the chess UI.

---

## 25. Error Handling

The game should never freeze if Laya is unavailable.

Possible states:

```text
Laya connected
Laya thinking
Laya unavailable
Laya timeout
Invalid response
Model still loading
```

If inference fails, the UI should clearly communicate the state and preserve the board.

The chess game itself should remain functional even when AI analysis is temporarily unavailable.

---

## 26. Model Strategy

Do not assume the largest model is automatically the correct model.

The official Laya project contains multiple checkpoints and reports different behavior across them. In its current published benchmark, the `laya-typed-decisions` checkpoint performs differently from the base `laya` and multilingual checkpoints.

More importantly, those benchmark results are on non-chess tasks.

Therefore, model selection for this project must be based on:

1. chess move quality
2. latency
3. memory/VRAM requirements
4. consistency
5. calibration behavior

A smaller model that produces useful chess decisions quickly can be more valuable than a larger model that is too slow.

---

## 27. What We Should NOT Build Yet

Avoid premature complexity.

Do **not** start with:

- production GPU hosting
- payments
- user authentication
- accounts
- multiplayer servers
- databases
- analytics infrastructure
- a custom model-serving stack
- a complicated microservice architecture
- browser ONNX inference
- a paid inference API

First prove that the fundamental Laya + chess idea works.

---

## 28. Development Phases

### Phase 0 — Environment

Goal:

```text
Laya installs and starts locally.
```

Deliverables:

- Python environment
- Laya installed
- model loaded
- `/health` works

### Phase 1 — API benchmark

Goal:

```text
Measure local Laya latency.
```

Deliverables:

- single-request benchmark
- batch-request benchmark
- CPU/CUDA comparison
- memory measurements

### Phase 2 — Chess logic

Goal:

```text
Build a reliable browser chess board without AI.
```

Deliverables:

- legal moves
- FEN
- material
- game state
- move history

### Phase 3 — Laya + chess

Goal:

```text
One chess position → Laya decision → UI result
```

Deliverables:

- candidate encoding
- API adapter
- response parsing
- move selection
- latency display

### Phase 4 — Candidate strategy

Goal:

```text
Many legal moves without unacceptable latency.
```

Deliverables:

- candidate reduction experiment
- batch experiment
- top-K strategy
- quality comparison

### Phase 5 — Calibration

Goal:

```text
Make the confidence output meaningful and observable.
```

Deliverables:

- calibration UI
- temperature parameter
- raw vs calibrated probabilities
- benchmark report

### Phase 6 — Local public demo

Goal:

```text
Another device can play using the developer's laptop.
```

Deliverables:

- tunnel
- safe authentication
- stable API URL
- two-device test

### Phase 7 — Deployment decision

Only now choose between:

- laptop hosting
- CPU server
- GPU server
- serverless GPU
- external decision API
- browser ONNX

The choice should be based on measured traffic and latency requirements.

---

## 29. Success Criteria for the Prototype

The prototype is considered successful if all of the following are true:

### Technical

- Laya runs reliably on the laptop.
- The model remains loaded between requests.
- The HTTP API works reliably.
- The chess frontend communicates with the API.

### Performance

- Warm inference latency is measured.
- Initial inference latency is measured.
- Typical chess positions can be processed without excessive waiting.
- Candidate batching/reduction produces an acceptable response time.

### Quality

- Laya produces non-random chess decisions.
- Laya demonstrates meaningful preferences between candidate moves.
- Tactical failures and obvious blunders are measurable.
- Results can be compared against a reference engine.

### UX

- The board remains responsive while Laya thinks.
- Users can play without waiting for a model download.
- AI failures do not destroy the game state.
- The calibration panel makes model behavior understandable.

---

## 30. What Success Does NOT Mean

A fast response does not automatically mean a good chess engine.

Likewise, a model that agrees with a reference engine on some positions is not automatically strong enough for a complete game.

The prototype must separately measure:

```text
Speed
Quality
Consistency
Calibration
```

---

## 31. Future Deployment Option A — GPU Server

Once the local prototype is proven:

```text
Static website
     ↓
API gateway
     ↓
GPU-backed Laya service
```

The model stays loaded on the server.

Advantages:

- no model download for users
- predictable performance
- works when the developer's laptop is off
- easier to support multiple users

Disadvantages:

- ongoing compute cost
- deployment/monitoring complexity

---

## 32. Future Deployment Option B — Serverless GPU

A scale-to-zero GPU service can be attractive for a low-traffic project.

Conceptually:

```text
no players
   ↓
no active GPU worker

player arrives
   ↓
worker starts
   ↓
inference
   ↓
scale down again
```

This minimizes idle cost but can create cold-start behavior, so actual UX must be measured.

---

## 33. Future Deployment Option C — Browser ONNX

The browser architecture remains a possible future experiment:

```text
Browser
   ↓
onnxruntime-web
   ↓
Laya ONNX
   ↓
WebGPU / WASM
```

ONNX Runtime Web supports WebGPU for browser-based inference, and WebGPU is designed for general-purpose GPU compute. However, model download size remains an important UX constraint for a large Laya model.

Official documentation:

https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html

This should therefore be treated as a **separate optimization experiment**, not the default product architecture.

---

## 34. Cost Strategy

### Phase 1

```text
Laptop inference = $0
Local API = $0
Local frontend = $0
```

### Phase 2

Public testing can still be close to $0 if a free static host and a development tunnel are sufficient.

### Phase 3

A paid GPU/API service becomes justified only after measuring real demand.

The guiding principle is:

> **Do not pay for infrastructure until the model and game have already proven that they are worth deploying.**

---

## 35. Decision Tree for the Next Step

```text
Can Laya run locally?
        │
        ├── NO → fix environment/model/runtime
        │
        └── YES
             ↓
Is warm latency acceptable?
        │
        ├── NO → CPU tuning / CUDA / smaller model / batching
        │
        └── YES
             ↓
Does Laya make useful chess decisions?
        │
        ├── NO → experiment with representation/model/candidates
        │
        └── YES
             ↓
Can the laptop support multiple requests?
        │
        ├── NO → GPU deployment later
        │
        └── YES
             ↓
Expose through tunnel
             ↓
Test with real users
             ↓
Measure actual demand
             ↓
Choose final hosting strategy
```

---

## 36. Immediate Task List

### Task 1

Run:

```powershell
python --version
nvidia-smi
```

### Task 2

Create the Python virtual environment.

### Task 3

Install:

```powershell
pip install "laya[serve]"
```

### Task 4

Start Laya with model preloading.

### Task 5

Verify:

```text
GET /health
```

### Task 6

Send one simple typed decision.

### Task 7

Measure warm and cold latency.

### Task 8

Test different batch sizes.

### Task 9

Only after these succeed, build the chess API adapter.

---

## 37. Key Risks

### Risk 1 — Laya is not good enough at chess

This is the biggest product risk.

Mitigation:

- benchmark against a reference engine
- build a curated chess test set
- test tactical positions
- test openings/middlegames/endgames

### Risk 2 — Laptop is too slow

Mitigation:

- CUDA acceleration
- thread tuning
- smaller checkpoint
- batching
- candidate reduction
- move result caching

### Risk 3 — Too many candidate moves

Mitigation:

- deterministic candidate reduction
- top-K candidate strategies
- specialized chess encoding
- compare `choice` vs `score` approaches

### Risk 4 — Bad probability calibration

Mitigation:

- calibration dataset
- temperature fitting
- raw vs calibrated UI

### Risk 5 — Public tunnel is unreliable

Mitigation:

- use the tunnel only for early testing
- move to hosted GPU/API infrastructure once the product is validated

---

## 38. Design Philosophy

The project should follow five principles:

### 1. Local first

Prove the idea on the laptop before paying for infrastructure.

### 2. Deterministic logic stays deterministic

Chess rules, legal moves, FEN, material, state, and UI do not need AI.

### 3. Measure instead of guessing

Every major architectural decision should be backed by latency and quality measurements.

### 4. Keep the AI boundary small

The rest of the application should not care whether Laya is local, remote, GPU-backed, or replaced later.

### 5. Optimize UX before infrastructure purity

A technically elegant zero-backend design is not useful if the visitor must download a huge model and wait before playing.

---

## 39. Reference Links

### Laya

- Main repository: https://github.com/NandhaKishorM/laya
- Main README: https://github.com/NandhaKishorM/laya/blob/main/README.md
- HTTP server: https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py
- Benchmarks: https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md
- Documentation: https://github.com/NandhaKishorM/laya/tree/main/docs

### Browser inference reference

- ONNX Runtime Web / WebGPU: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html

### Local/public testing

- Cloudflare Tunnel quick start: https://developers.cloudflare.com/tunnel/get-started/

---

## 40. Final Project Direction

The project direction is intentionally simple:

```text
                START HERE
                    │
                    ▼
          Laya on developer laptop
                    │
                    ▼
             Local HTTP API
                    │
                    ▼
             Chess frontend
                    │
                    ▼
        Benchmark quality + latency
                    │
          ┌─────────┴─────────┐
          │                   │
        works               fails
          │                   │
          ▼                   ▼
  expose with tunnel     improve model /
          │              representation /
          ▼              performance
   real-device test             │
          │                     └──────► repeat
          ▼
  decide deployment
```

The **first deliverable is not the public website**.

The first deliverable is a **local working experiment that proves Laya can evaluate chess decisions at acceptable speed and with meaningful quality on the target laptop**.

Once that is proven, deployment becomes an engineering choice rather than a guess.
