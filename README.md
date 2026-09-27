# Laya Chess — local prototype

A local-first chess app where every move the player makes is a tap on a
highlighted legal destination square (illegal moves aren't representable in
the UI), and every AI-suggested move from **Laya** is shown next to a
zero-AI one-ply material check in a live calibration panel.

This is Phase 0–3 of the plan in [`docs/PROJECT.md`](docs/PROJECT.md):
laptop-only, no deployment, no GPU server, no payments. The goal right now is
just to find out whether Laya can make useful, fast-enough chess decisions —
see [`GETTING_STARTED.md`](GETTING_STARTED.md) for the step-by-step path.

```
laya-chess/
├── frontend/     React + Vite + TypeScript app (board, calibration panel, API client)
├── scripts/      Python scripts to install/run Laya and benchmark it, independent of the frontend
├── docs/
│   ├── PROJECT.md          the full project plan/spec
│   └── experiments/        benchmark output and generated test positions land here
├── laya/         notes on the local Laya install (kept out of frontend/)
└── GETTING_STARTED.md      start here
```

Start with [`GETTING_STARTED.md`](GETTING_STARTED.md).
