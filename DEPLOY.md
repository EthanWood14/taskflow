# Put TaskFlow on the web

TaskFlow is a single static file (`index.html`) with no build step and no backend, so it hosts anywhere. Pick whichever route fits you. Each gives you a public URL you can open on your phone.

> Your data is stored per-browser in `localStorage`. Each device/browser keeps its own list. Use **Import / Export** to move data between them.

A ready-to-upload copy is in **`deploy/`** and zipped as **`taskflow-site.zip`**.

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
