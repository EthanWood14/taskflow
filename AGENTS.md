# Agent instructions

TaskFlow is a local-first browser application in `index.html` with an optional Node backend in `server/`. The backend provides accounts, shared workspaces, WebSockets, JSON/Postgres storage, optional Stripe billing, and optional Anthropic braindumps.

## Safe workflow

- Work only in the isolated Paperclip worktree and issue branch supplied for the task.
- The root client has no build step. The server has no lockfile; install only inside `server/` when dependencies are needed. Run `node --check server/server.js` and `node --check server/storage.js` after backend changes.
- Keep offline/local-first behavior working. Preserve workspace membership, authorization, password/session, WebSocket, and billing webhook boundaries.
- Do not use a live database, charge Stripe, send data to Anthropic, deploy, push, or merge without explicit human approval.
- Never read, print, copy, or commit secrets or runtime data. Production requires a durable volume and stable `JWT_SECRET`; see `BACKEND.md`.

## Handoff

Report the outcome, changed files, checks run, offline/backend impact, data or billing risks, and branch/commit. A reviewer must approve before merge or deployment.
