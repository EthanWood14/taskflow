# TaskFlow backend on Railway

The app ships with an optional **Node backend** (`server/`) that adds:

- 🔐 **Accounts** (email + password, bcrypt-hashed, JWT sessions)
- 👥 **Shared multi-user workspaces** — create workspaces, invite people with a link, everyone shares the same task lists
- ☁ **Cross-device sync** — your workspaces are stored server-side and pulled on any device
- ⚡ **Real-time updates** over WebSockets — a teammate's change appears live for everyone in that workspace
- 🔌 **REST API** (see table below)

It also serves the static app, so it's **one Railway service**. The app still works fully **offline/local-first** — sync is opt-in (Settings → ☁ Cloud sync).

## Storage: JSON (default) or Postgres
- **No setup:** uses a JSON file on a Volume at `/data` — fine for personal use and small teams, supports full shared workspaces.
- **Scale/durability:** add a Railway **Postgres** plugin. The server auto-detects `DATABASE_URL`, creates its tables on boot, and uses Postgres instead. No code changes.

## Shared workspaces — how it works
- On signup you get a personal **“My Workspace.”** Create more in **⚙ Settings → ☁ Cloud sync → ＋**.
- **Invite people:** *Invite people* button → copies a link like `https://your-app.up.railway.app/?join=CODE`. Anyone who opens it and logs in joins that workspace.
- Switch the active workspace from the dropdown; all members see live updates.

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

## Switching to Postgres (optional)
1. In your Railway project: **New → Database → Add PostgreSQL**.
2. Railway injects `DATABASE_URL` into your service automatically (same project). Redeploy.
3. The server logs `[storage] using Postgres` and creates its tables. Done.
   - If you use the *public* proxy URL instead of the internal one, also set `PGSSL=1`.

## Data model
- **JSON store:** one file `/data/db.json` (in-memory cache + atomic writes) holding users, workspaces, memberships, and invites.
- **Postgres:** tables `users`, `workspaces`, `memberships`, `invites` (created automatically).
- Each **workspace** stores the entire TaskFlow `state` as one JSON document, versioned with a `rev`. Sync is last-write-wins with live WebSocket nudges to the workspace's members (the writer isn't echoed to itself, via `clientId`).

## Local run (if you have Node)

```bash
cd server && npm install && PUBLIC_DIR=.. DATA_DIR=./data node server.js
# open http://localhost:8080
```

## Endpoints

| Method | Path                              | Auth | Body                   | Returns                         |
|--------|-----------------------------------|------|------------------------|---------------------------------|
| GET    | `/api/health`                     | no   | —                      | `{ok,mode}`                     |
| POST   | `/api/signup`                     | no   | `{email,password}`     | `{token,email,workspaces}`      |
| POST   | `/api/login`                      | no   | `{email,password}`     | `{token,email,workspaces}`      |
| GET    | `/api/me`                         | yes  | —                      | `{email,workspaces}`            |
| GET    | `/api/workspaces`                 | yes  | —                      | `{workspaces}`                  |
| POST   | `/api/workspaces`                 | yes  | `{name}`               | `{workspace}`                   |
| GET    | `/api/workspaces/:id/state`       | yes  | —                      | `{state,rev}`                   |
| PUT    | `/api/workspaces/:id/state`       | yes  | `{state,clientId}`     | `{ok,rev}`                      |
| POST   | `/api/workspaces/:id/invite`      | yes  | —                      | `{code}`                        |
| GET    | `/api/workspaces/:id/members`     | yes  | —                      | `{members:[{email,role}]}`      |
| POST   | `/api/join`                       | yes  | `{code}`               | `{workspace}`                   |
| WS     | `/ws?token=&workspace=&clientId=` | yes  | —                      | `{type:'update',rev}`           |
