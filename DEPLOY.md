# Put TaskFlow on the web

TaskFlow is a single static file (`index.html`) with no build step and no backend, so it hosts anywhere. Pick whichever route fits you. Each gives you a public URL you can open on your phone.

> Your data is stored per-browser in `localStorage`. Each device/browser keeps its own list. Use **Import / Export** to move data between them.

A ready-to-upload copy is in **`deploy/`** and zipped as **`taskflow-site.zip`**.
This folder is also a **git repo** already committed and ready to push, with a
**`Dockerfile`** + **`Caddyfile`** so container hosts (Railway, Render, Fly) build it with zero guesswork.

---

## ⭐ Option R — Railway (recommended — now with a backend)

TaskFlow ships with a `Dockerfile` (Node server in `server/`) that adds **accounts,
cross-device sync, real-time updates, and a REST API** — and also serves the app.
**See [BACKEND.md](BACKEND.md) for the full backend setup** (add a Volume at `/data`
and set `JWT_SECRET`). Quick version below; sync is optional and the app still works offline.

### Easiest: deploy from GitHub (browser only, no CLI)
1. Push this folder to a GitHub repo (one-time):
   ```bash
   git remote add origin https://github.com/<you>/taskflow.git
   git push -u origin main
   ```
2. Go to **https://railway.app** → **New Project** → **Deploy from GitHub repo** → pick `taskflow`.
3. Railway detects the `Dockerfile` and builds automatically.
4. Open the service → **Settings → Networking → Generate Domain**.
5. You get a public URL like `https://taskflow-production.up.railway.app` — open it on your phone.

### Alternative: Railway CLI (deploy straight from this folder, no GitHub)
```bash
npm i -g @railway/cli      # or: winget install Railway.Railway
railway login              # opens your browser
railway init               # create a new project
railway up                 # builds the Dockerfile and deploys this folder
railway domain             # prints your public URL
```

> No env vars or database needed — it's a static client app. Railway's `$PORT` is handled by the `Caddyfile` (`:{$PORT}`).

---

## Option A — Netlify Drop (no account needed to try, ~30 sec)
1. Go to **https://app.netlify.com/drop**
2. Drag the **`deploy`** folder (or `taskflow-site.zip`) onto the page.
3. You instantly get a public URL like `https://random-name.netlify.app`.
4. (Optional) Sign in to keep it permanently and rename it.

## Option B — Cloudflare Pages (drag-and-drop, free)
1. **https://pages.cloudflare.com** → *Create a project* → *Direct Upload*.
2. Upload the `deploy` folder.
3. Get `https://your-project.pages.dev`.

## Option C — GitHub Pages (free, permanent, version-controlled)
From this folder:
```bash
git init && git add index.html && git commit -m "TaskFlow"
git branch -M main
git remote add origin https://github.com/<you>/taskflow.git
git push -u origin main
```
Then on GitHub: **Settings → Pages → Source: `main` / root**. Live at
`https://<you>.github.io/taskflow/` in ~1 minute.

## Option D — Vercel
`https://vercel.com/new` → import the repo (or drag the folder with the Vercel CLI). Auto-detects a static site.

---

## Make it installable as a phone app (optional)
Once it's on any `https://` URL, open it in mobile Chrome/Safari → **Share / menu → Add to Home Screen**. It launches full-screen like a native app (the `theme-color` and viewport are already set).

## Run it locally over http (no internet)
Already supported. A tiny PowerShell static server is included:
```powershell
powershell -NoProfile -File serve.ps1   # serves http://localhost:8777
```
Or just double-click `index.html` to open it directly (`file://`).
