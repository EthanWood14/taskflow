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

## 💳 Payments (Stripe) — optional, fully built in

The server ships with a complete **Stripe** subscription integration: secure Checkout, webhook-driven plan updates, a customer billing portal, and plan gating (Free = 2 workspaces / 5 members each · **Pro** = unlimited, billed **per seat at $1.50/user/month**). It activates automatically once you add your Stripe keys — until then the upgrade UI hides itself and everything stays free/unlimited-by-default.

**Per-seat billing:** a Pro subscriber pays $1.50/month for every person in workspaces they own (themselves included — 1 seat minimum). Checkout starts with the current seat count, and the server **auto-syncs the subscription quantity** whenever members join, are removed, leave, or a workspace is deleted — Stripe prorates the difference on the next invoice.

**Free trial:** first-time subscribers get a **14-day free trial** ($0 today, card collected by Stripe, cancel anytime). Configure with `STRIPE_TRIAL_DAYS` (default `14`, set `0` to disable). Returning subscribers (who already had a subscription) skip the trial.

**Public pricing page:** share `https://YOUR-APP.up.railway.app/pricing` — it opens the plans view for anyone, logged in or not. There's also a 💎 **Go Pro** entry in the sidebar.

**To turn it on (you do this part — it's your Stripe account and keys):**
1. Create a Stripe account at **stripe.com** (or use an existing one). Start in **Test mode**.
2. **Create a product**: Dashboard → Product catalog → *Add product* → name "TaskFlow Pro", **recurring monthly** price of **$1.50** (Stripe multiplies it by the seat quantity automatically). Copy the **price ID** (`price_…`).
3. **Get your secret key**: Dashboard → Developers → API keys → **Secret key** (`sk_test_…`).
4. **Create a webhook**: Developers → Webhooks → *Add endpoint* → URL `https://YOUR-APP.up.railway.app/api/billing/webhook` → select events `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the **signing secret** (`whsec_…`).
5. In **Railway → your service → Variables**, add:
   - `STRIPE_SECRET_KEY` = `sk_test_…`
   - `STRIPE_PRICE_ID` = `price_…`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_…`
   - `STRIPE_PRICE_DISPLAY` = `$1.50 / user / mo` *(optional — this is already the default shown in the pricing modal)*
6. Redeploy. The **💎 Upgrade to Pro** button appears in ⚙ Settings → account, and the pricing modal goes live.
7. **Test it** with Stripe's test card `4242 4242 4242 4242` (any future expiry/CVC). The webhook flips your account to Pro; "Manage billing" opens Stripe's customer portal (cancel/update card there). When ready, switch the keys to live mode.

Billing endpoints: `GET /api/billing/config` · `POST /api/billing/checkout` · `POST /api/billing/portal` · `POST /api/billing/webhook` (raw-body, signature-verified). Card data never touches your server — it all happens on Stripe-hosted pages.

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
| POST   | `/api/signup`                     | no   | `{email,password,name}`| `{token,email,name,workspaces}` |
| POST   | `/api/login`                      | no   | `{email,password}`     | `{token,email,name,workspaces}` |
| GET    | `/api/me`                         | yes  | —                      | `{email,name,workspaces}`       |
| PUT    | `/api/account`                    | yes  | `{name}`               | `{ok,name}`                     |
| POST   | `/api/account/password`           | yes  | `{currentPassword,newPassword}` | `{ok}`                 |
| POST   | `/api/account/delete`             | yes  | `{password}`           | `{ok}`                          |
| GET    | `/api/workspaces`                 | yes  | —                      | `{workspaces}`                  |
| POST   | `/api/workspaces`                 | yes  | `{name}`               | `{workspace}`                   |
| GET    | `/api/workspaces/:id/state`       | yes  | —                      | `{state,rev}`                   |
| PUT    | `/api/workspaces/:id/state`       | yes  | `{state,clientId}`     | `{ok,rev}`                      |
| POST   | `/api/workspaces/:id/invite`      | yes  | —                      | `{code}`                        |
| GET    | `/api/workspaces/:id/members`     | yes  | —                      | `{members:[{userId,email,role}],online}` |
| POST   | `/api/workspaces/:id/members/remove` | owner | `{userId}`          | `{ok}`                          |
| POST   | `/api/workspaces/:id/leave`       | member | —                     | `{ok}`                          |
| POST   | `/api/workspaces/:id/delete`      | owner | —                      | `{ok}`                          |
| POST   | `/api/join`                       | yes  | `{code}`               | `{workspace}`                   |
| WS     | `/ws?token=&workspace=&clientId=` | yes  | —                      | `{type:'update'\|'presence'\|'removed', …}` |

**Member management & presence:** owners can remove members or delete the workspace; members can leave. The roster (Settings → ☁ Cloud sync → Members) shows roles and a live green dot for who's online; the topbar shows a presence pill of online avatars. Presence is pushed over the workspace WebSocket as people connect/disconnect.
