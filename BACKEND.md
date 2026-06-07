# TaskFlow backend on Railway

The app now ships with an optional **Node backend** (`server/server.js`) that adds:

- 🔐 **Accounts** (email + password, hashed with bcrypt, JWT sessions)
- ☁ **Cross-device sync** — your whole workspace is stored server-side and pulled on any device
- ⚡ **Real-time updates** over WebSockets — change something on your laptop, watch it update on your phone
- 🔌 **REST API** — `/api/signup`, `/api/login`, `/api/state` (GET/PUT), `/api/health`

It also serves the static app, so it's **one Railway service**. The app still works fully **offline/local-first** — sync is opt-in (Settings → ☁ Cloud sync).

## Deploy (Railway)

1. Push this repo to GitHub (already set up): `git push`.
2. **railway.app → New Project → Deploy from GitHub repo → `taskflow`**. Railway builds the `Dockerfile` (Node).
3. **Add a Volume** for durable storage:
   - Service → **Variables/Settings → Volumes → New Volume**
   - **Mount path:** `/data`  (the server reads `DATA_DIR=/data`, already set in the Dockerfile)
4. **Set an environment variable** so sessions survive restarts:
   - `JWT_SECRET` = any long random string (e.g. run `openssl rand -hex 32`)
5. Deploy → **Settings → Networking → Generate Domain** → open `https://…railway.app`.
6. In the app: **⚙ Settings → ☁ Cloud sync → Create account**. Do the same on your phone with the same email/password — they'll sync live.

> Without a Volume the app still runs, but stored accounts/tasks reset on each redeploy. Add the Volume for persistence.

## Data model / storage

- Storage is a single JSON file at `/data/db.json` (in-memory cache + atomic writes). Great for personal / small-team use.
- Each user's entire TaskFlow `state` is stored as one document, versioned with a `rev`. Sync is last-write-wins with live WebSocket nudges (the writer is not echoed to itself via `clientId`).
- To scale to many users or add granular per-record APIs later, swap the JSON store for Railway **Postgres** (add the Postgres plugin → use `DATABASE_URL`); the route handlers are the only thing that changes.

## Local run (if you have Node)

```bash
cd server && npm install && PUBLIC_DIR=.. DATA_DIR=./data node server.js
# open http://localhost:8080
```

## Endpoints

| Method | Path           | Auth | Body                          | Returns            |
|--------|----------------|------|-------------------------------|--------------------|
| GET    | `/api/health`  | no   | —                             | `{ok,users}`       |
| POST   | `/api/signup`  | no   | `{email,password}`            | `{token,email}`    |
| POST   | `/api/login`   | no   | `{email,password}`            | `{token,email}`    |
| GET    | `/api/state`   | yes  | —                             | `{state,rev}`      |
| PUT    | `/api/state`   | yes  | `{state,clientId}`            | `{ok,rev}`         |
| WS     | `/ws?token=&clientId=` | yes | —                     | `{type:'update',rev}` |
