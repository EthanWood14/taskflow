// TaskFlow backend — accounts, cross-device state sync, real-time, REST API.
// Single Node service: also serves the static app. Storage = JSON file on a Railway Volume.
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[taskflow] JWT_SECRET not set — using a random secret (tokens reset on restart). Set JWT_SECRET in Railway.');

// ---------- tiny JSON store (in-memory + atomic file writes) ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, states: {} };          // users: {emailLower:{id,email,hash,createdAt}}, states:{userId:{state,rev,updatedAt}}
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { console.error('db read failed', e); }
let saveQueued = false;
function saveDb() {
  if (saveQueued) return; saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
    catch (e) { console.error('db write failed', e); }
  }, 50);
}

// ---------- helpers ----------
const norm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function sign(user) { return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '180d' }); }
function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try { const p = jwt.verify(m[1], JWT_SECRET); return p; } catch (e) { return null; }
}

// ---------- app ----------
const app = express();
app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });

app.get('/api/health', (_req, res) => res.json({ ok: true, users: Object.keys(db.users).length }));

app.post('/api/signup', async (req, res) => {
  const email = norm(req.body.email), password = String(req.body.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.users[email]) return res.status(409).json({ error: 'Account already exists — log in instead' });
  const user = { id: 'u_' + crypto.randomBytes(8).toString('hex'), email, hash: await bcrypt.hash(password, 10), createdAt: Date.now() };
  db.users[email] = user; saveDb();
  res.json({ token: sign(user), email });
});

app.post('/api/login', async (req, res) => {
  const email = norm(req.body.email), password = String(req.body.password || '');
  const user = db.users[email];
  if (!user || !(await bcrypt.compare(password, user.hash))) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(user), email });
});

app.get('/api/state', (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const rec = db.states[u.uid];
  res.json({ state: rec ? rec.state : null, rev: rec ? rec.rev : 0 });
});

app.put('/api/state', (req, res) => {
  const u = authUser(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const incoming = req.body.state;
  if (typeof incoming !== 'object' || incoming === null) return res.status(400).json({ error: 'state must be an object' });
  const prev = db.states[u.uid];
  const rev = (prev ? prev.rev : 0) + 1;
  db.states[u.uid] = { state: incoming, rev, updatedAt: Date.now() };
  saveDb();
  broadcast(u.uid, req.body.clientId, rev);
  res.json({ ok: true, rev });
});

// ---------- static app ----------
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- realtime (WebSocket) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map(); // uid -> Set of {ws, clientId}
function broadcast(uid, fromClientId, rev) {
  const set = sockets.get(uid); if (!set) return;
  for (const c of set) {
    if (c.clientId && c.clientId === fromClientId) continue; // don't echo to the writer
    try { c.ws.send(JSON.stringify({ type: 'update', rev })); } catch (e) {}
  }
}
wss.on('connection', (ws, req) => {
  let uid = null;
  try {
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('token');
    const clientId = u.searchParams.get('clientId') || '';
    const p = jwt.verify(token, JWT_SECRET);
    uid = p.uid;
    if (!sockets.has(uid)) sockets.set(uid, new Set());
    const entry = { ws, clientId };
    sockets.get(uid).add(entry);
    ws.on('close', () => { const s = sockets.get(uid); if (s) { s.delete(entry); if (!s.size) sockets.delete(uid); } });
    ws.send(JSON.stringify({ type: 'connected' }));
  } catch (e) { try { ws.close(); } catch (_) {} }
});

server.listen(PORT, () => console.log(`[taskflow] listening on :${PORT} · data=${DATA_DIR}`));
