# Local Laya install notes

Laya itself is not vendored into this repo — it's installed into its own
Python virtual environment per the root `README.md`, section "Run it".

This folder is just for notes as you go: which checkpoint you're using, which
`LAYA_*` environment variables you settled on, and anything you had to change
to get a clean start. Treat it as a lab notebook, not code.

Reference:
- https://github.com/NandhaKishorM/laya
- https://github.com/NandhaKishorM/laya/blob/main/laya/serve.py
- https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md

## Lab notebook (fill in as you go)

- Date:
- `pip show laya` version:
- Checkpoint(s) in use (`/health` → `loaded`):
- Env: `LAYA_DEVICE=`, `LAYA_PRELOAD=`, `LAYA_THREADS=`, `LAYA_MODELS=`, `LAYA_API_KEY` set? (y/n, never paste the value)
- Anything needed for a clean start:

## Verified response shape (laya 0.3.20)

`POST /v1/systemone` returns `router.predict(...)` directly:

```json
{
  "model": "laya-rl-agent",
  "answers": {
    "best_move": {
      "type": "choice",
      "choice": "<winning candidate id>",
      "probabilities": { "<id>": 0.1234 },
      "confidence": 0.12,
      "answer_confidence": 0.34,
      "action": { "act_probability": 0.99 }
    }
  },
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "routing": { "model": "english", "reason": "..." }
}
```

Inference time is **not** in the body. `frontend/src/api/layaClient.ts` also
checks the `X-Inference-Time-Ms` / `Server-Timing` response headers, but this
server sends neither (checked 2026-10-01: only `date`, `server`,
`content-length`, `content-type`), so model time shows as "n/a". Limits enforced before inference: max 100 choice options per
question, 512 total options, 64 questions, 50000 state chars.
