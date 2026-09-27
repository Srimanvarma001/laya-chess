# Security notes — local prototype (PROJECT.md §21–22)

## The rule

The React app must never contain a real secret. Anything baked into a Vite
`VITE_*` variable ships to the browser in plain text inside the built JS.

## Phase 1 (local-only, current)

- `VITE_LAYA_API_KEY` in `frontend/.env.local` is acceptable **only** because
  both the frontend (`localhost:5173`) and Laya (`localhost:8000`) run on the
  same machine. The key never leaves your laptop.
- `frontend/.env.local` is git-ignored (see `.gitignore`). Never commit it.
- If you set `LAYA_API_KEY` on the server, set the same value in
  `frontend/.env.local` and restart `npm run dev`.

## Before any tunnel / public URL (Phase 6)

- Do not point a public frontend build at Laya directly with a baked-in key.
- Preferred shape (PROJECT.md §21):
  `Browser → small authenticated proxy → local Laya API`.
- The proxy holds `LAYA_API_KEY` server-side; the browser holds at most a
  short-lived, audience-restricted token for the proxy — never the raw Laya key.

## Before any hosted deployment (Phase 7)

- Same rule: browser → your API gateway → GPU inference. Secrets live in the
  gateway's environment, never in `frontend/dist`.
- Rotate any key that was ever baked into a build or pasted into a chat/log.
