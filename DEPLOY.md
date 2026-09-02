# Put TaskFlow on the web

TaskFlow's client is a single static file (`index.html`, plus `manifest.webmanifest` and `sw.js` for
the installable PWA). It hosts anywhere. The optional Node backend in `server/` adds accounts and
cross-device sync; see [BACKEND.md](BACKEND.md).

> Without the backend, your data is stored per-browser in `localStorage`. Each device/browser keeps
> its own list. Use **Import / Export** to move data between them, or deploy the backend and turn on
> ☁ Cloud sync.

---

## ⭐ Option R — Railway (recommended — includes the backend)

The `Dockerfile` builds the Node server, which also serves the app. This is how the production
deployment at `taskflow-production-5305.up.railway.app` runs.

### Deploy from GitHub (browser only, no CLI)
1. Push this repo to GitHub (already set up: `git push origin main`).
2. **https://railway.app** → **New Project** → **Deploy from GitHub repo** → pick `taskflow`.
3. Railway detects the `Dockerfile` and builds automatically. Every push to `main` redeploys.
4. **Add a Volume** mounted at `/data` so accounts and tasks survive redeploys.
5. **Set `JWT_SECRET`** to a long random string so sign-in sessions survive restarts.
   Without it the server picks a new secret on every boot and everyone is signed out.
6. **Settings → Networking → Generate Domain** → open the URL on your phone.

Full backend setup, Postgres, Stripe, and the AI braindump are covered in [BACKEND.md](BACKEND.md).

### Alternative: Railway CLI
```bash
npm i -g @railway/cli      # or: winget install Railway.Railway
railway login
railway init
railway up                 # builds the Dockerfile and deploys this folder
railway domain             # prints your public URL
```

---

## Static-only hosts (no accounts, no sync)

Upload these three files to any static host: `index.html`, `manifest.webmanifest`, `sw.js`.

- **Netlify Drop** — https://app.netlify.com/drop, drag the files onto the page.
- **Cloudflare Pages** — https://pages.cloudflare.com → *Create a project* → *Direct Upload*.
- **GitHub Pages** — push to GitHub, then **Settings → Pages → Source: `main` / root**.
  Live at `https://<you>.github.io/taskflow/`.
- **Vercel** — https://vercel.com/new → import the repo. Auto-detects a static site.

---

## Make it installable as a phone app
Once it's on any `https://` URL, open it in mobile Chrome/Safari → **Share / menu → Add to Home
Screen**. It launches full-screen like a native app.

## Run it locally
Double-click `index.html` to open it directly, or run the backend locally if you have Node:
```bash
cd server && npm install && PUBLIC_DIR=.. DATA_DIR=./data node server.js
# open http://localhost:8080
```
