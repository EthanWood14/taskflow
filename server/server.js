// TaskFlow backend — accounts + shared multi-user workspaces + real-time + REST API.
// Serves the static app too. Storage: JSON file (default) or Postgres (if DATABASE_URL).
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { makeStore } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[taskflow] JWT_SECRET not set — using a random secret (sessions reset on restart). Set JWT_SECRET in Railway.');

const store = makeStore(DATA_DIR);
const MODE = process.env.DATABASE_URL ? 'pg' : 'json';

// ---------- Stripe (payment processor) ----------
// Fully active once STRIPE_SECRET_KEY + STRIPE_PRICE_ID (+ STRIPE_WEBHOOK_SECRET) are set.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_DISPLAY = process.env.STRIPE_PRICE_DISPLAY || '';
const BILLING_ON = !!(STRIPE_KEY && STRIPE_PRICE_ID);
if (!BILLING_ON) console.warn('[taskflow] billing disabled — set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to enable');
async function stripeReq(path, params) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch('https://api.stripe.com/v1' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Stripe error');
  return d;
}
function verifyStripeSig(payloadBuf, header, secret) {
  try {
    const items = String(header || '').split(',').map(s => s.split('='));
    const t = (items.find(i => i[0] === 't') || [])[1];
    const v1s = items.filter(i => i[0] === 'v1').map(i => i[1]);
    if (!t || !v1s.length) return false;
    const expected = crypto.createHmac('sha256', secret).update(t + '.' + payloadBuf.toString('utf8')).digest('hex');
    return v1s.some(v => { try { return crypto.timingSafeEqual(Buffer.from(v, 'hex'), Buffer.from(expected, 'hex')); } catch (e) { return false; } });
  } catch (e) { return false; }
}
const FREE_WS_LIMIT = 2, FREE_MEMBER_LIMIT = 5;
async function planOf(uid) { const u = await store.getUserById(uid); return (u && u.plan) === 'pro' ? 'pro' : 'free'; }

const norm = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const sign = (u) => jwt.sign({ uid: u.id, email: u.email }, JWT_SECRET, { expiresIn: '180d' });
function auth(req) { const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i); if (!m) return null; try { return jwt.verify(m[1], JWT_SECRET); } catch (e) { return null; } }
function asyncH(fn) { return (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); }); }

const app = express();

// Stripe webhook needs the RAW body for signature verification — mount before express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), asyncH(async (req, res) => {
  if (!BILLING_ON || !STRIPE_WEBHOOK_SECRET) return res.status(400).json({ error: 'Billing not configured' });
  if (!verifyStripeSig(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) return res.status(400).json({ error: 'Bad signature' });
  const event = JSON.parse(req.body.toString('utf8'));
  const obj = (event.data && event.data.object) || {};
  if (event.type === 'checkout.session.completed') {
    const uid = (obj.metadata && obj.metadata.userId) || obj.client_reference_id;
    if (uid) await store.setBilling(uid, { plan: 'pro', stripeCustomerId: obj.customer });
  } else if (event.type === 'customer.subscription.deleted') {
    const u = await store.getUserByStripeCustomer(obj.customer);
    if (u) await store.setBilling(u.id, { plan: 'free' });
  } else if (event.type === 'customer.subscription.updated') {
    const u = await store.getUserByStripeCustomer(obj.customer);
    if (u) await store.setBilling(u.id, { plan: (obj.status === 'active' || obj.status === 'trialing') ? 'pro' : 'free' });
  }
  res.json({ received: true });
}));

app.use(express.json({ limit: '8mb' }));
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: MODE }));

app.post('/api/signup', asyncH(async (req, res) => {
  const email = norm(req.body.email), password = String(req.body.password || ''), name = String(req.body.name || '').trim().slice(0, 60);
  if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: 'Account already exists — log in instead' });
  const user = await store.createUser({ id: 'u_' + crypto.randomBytes(8).toString('hex'), email, hash: await bcrypt.hash(password, 10), name });
  res.json({ token: sign(user), email, name: user.name, plan: 'free', workspaces: await store.listWorkspaces(user.id) });
}));

app.post('/api/login', asyncH(async (req, res) => {
  const email = norm(req.body.email), password = String(req.body.password || '');
  const user = await store.getUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.hash))) return res.status(401).json({ error: 'Wrong email or password' });
  res.json({ token: sign(user), email, name: user.name, plan: user.plan === 'pro' ? 'pro' : 'free', workspaces: await store.listWorkspaces(user.id) });
}));

app.get('/api/me', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const me = await store.getUserById(u.uid);
  res.json({ email: u.email, name: me ? me.name : null, plan: (me && me.plan) === 'pro' ? 'pro' : 'free', workspaces: await store.listWorkspaces(u.uid) });
}));

// ---------- Billing ----------
app.get('/api/billing/config', asyncH(async (req, res) => {
  const u = auth(req);
  let plan = 'free';
  if (u) plan = await planOf(u.uid);
  res.json({ enabled: BILLING_ON, plan, priceDisplay: PRICE_DISPLAY, freeLimits: { workspaces: FREE_WS_LIMIT, members: FREE_MEMBER_LIMIT } });
}));

app.post('/api/billing/checkout', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!BILLING_ON) return res.status(400).json({ error: 'Billing is not configured on this server yet — see BACKEND.md (set STRIPE_SECRET_KEY and STRIPE_PRICE_ID).' });
  const me = await store.getUserById(u.uid);
  const origin = req.headers.origin || ('https://' + req.headers.host);
  const params = {
    mode: 'subscription',
    'line_items[0][price]': STRIPE_PRICE_ID,
    'line_items[0][quantity]': '1',
    success_url: origin + '/?billing=success',
    cancel_url: origin + '/?billing=cancel',
    'metadata[userId]': u.uid,
    client_reference_id: u.uid,
  };
  if (me && me.stripeCustomerId) params.customer = me.stripeCustomerId; else params.customer_email = u.email;
  const session = await stripeReq('/checkout/sessions', params);
  res.json({ url: session.url });
}));

app.post('/api/billing/portal', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!BILLING_ON) return res.status(400).json({ error: 'Billing is not configured on this server yet.' });
  const me = await store.getUserById(u.uid);
  if (!me || !me.stripeCustomerId) return res.status(400).json({ error: 'No billing profile yet — upgrade first.' });
  const origin = req.headers.origin || ('https://' + req.headers.host);
  const session = await stripeReq('/billing_portal/sessions', { customer: me.stripeCustomerId, return_url: origin + '/' });
  res.json({ url: session.url });
}));

app.put('/api/account', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const name = String(req.body.name || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'Name required' });
  await store.updateUser(u.uid, { name });
  res.json({ ok: true, name });
}));

app.post('/api/account/password', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const me = await store.getUserById(u.uid);
  const cur = String(req.body.currentPassword || ''), next = String(req.body.newPassword || '');
  if (!me || !(await bcrypt.compare(cur, me.hash))) return res.status(401).json({ error: 'Current password is wrong' });
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  await store.updateUser(u.uid, { hash: await bcrypt.hash(next, 10) });
  res.json({ ok: true });
}));

app.post('/api/account/delete', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const me = await store.getUserById(u.uid);
  if (!me || !(await bcrypt.compare(String(req.body.password || ''), me.hash))) return res.status(401).json({ error: 'Password is wrong' });
  await store.deleteUser(u.uid);
  res.json({ ok: true });
}));

app.get('/api/workspaces', asyncH(async (req, res) => { const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' }); res.json({ workspaces: await store.listWorkspaces(u.uid) }); }));

app.post('/api/workspaces', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (BILLING_ON && (await planOf(u.uid)) !== 'pro') {
    const owned = (await store.listWorkspaces(u.uid)).filter(w => w.role === 'owner').length;
    if (owned >= FREE_WS_LIMIT) return res.status(402).json({ error: `Free plan includes ${FREE_WS_LIMIT} workspaces — upgrade to Pro for unlimited.`, upgrade: true });
  }
  const ws = await store.createWorkspace(u.uid, req.body.name); res.json({ workspace: ws });
}));

app.get('/api/workspaces/:id/state', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await store.role(u.uid, req.params.id))) return res.status(403).json({ error: 'Not a member' });
  const rec = await store.getState(req.params.id); res.json({ state: rec ? rec.state : null, rev: rec ? rec.rev : 0 });
}));

app.put('/api/workspaces/:id/state', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await store.role(u.uid, req.params.id))) return res.status(403).json({ error: 'Not a member' });
  if (typeof req.body.state !== 'object' || req.body.state === null) return res.status(400).json({ error: 'state must be an object' });
  const rev = await store.putState(req.params.id, req.body.state);
  broadcast(req.params.id, req.body.clientId, rev);
  res.json({ ok: true, rev });
}));

app.post('/api/workspaces/:id/invite', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await store.role(u.uid, req.params.id))) return res.status(403).json({ error: 'Not a member' });
  res.json({ code: await store.createInvite(req.params.id) });
}));

app.get('/api/workspaces/:id/members', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await store.role(u.uid, req.params.id))) return res.status(403).json({ error: 'Not a member' });
  res.json({ members: await store.listMembers(req.params.id), online: presenceList(req.params.id) });
}));

app.post('/api/workspaces/:id/members/remove', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if ((await store.role(u.uid, req.params.id)) !== 'owner') return res.status(403).json({ error: 'Only the owner can remove members' });
  const ok = await store.removeMember(req.params.id, String(req.body.userId || ''));
  if (!ok) return res.status(400).json({ error: "Can't remove that member" });
  broadcast(req.params.id, null, -1); kickUser(req.params.id, req.body.userId); res.json({ ok: true });
}));

app.post('/api/workspaces/:id/leave', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const role = await store.role(u.uid, req.params.id);
  if (!role) return res.status(400).json({ error: 'Not a member' });
  if (role === 'owner') return res.status(400).json({ error: "Owners can't leave — delete the workspace instead" });
  await store.removeMember(req.params.id, u.uid); kickUser(req.params.id, u.uid); res.json({ ok: true });
}));

app.post('/api/workspaces/:id/delete', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if ((await store.role(u.uid, req.params.id)) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete this workspace' });
  await store.deleteWorkspace(req.params.id); broadcast(req.params.id, null, -1); closeRoom(req.params.id); res.json({ ok: true });
}));

app.post('/api/join', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const code = String(req.body.code || '').trim();
  if (BILLING_ON) {
    const inv = await store.peekInvite(code);
    if (inv) {
      const meta = await store.getWorkspaceMeta(inv.wsId);
      if (meta && meta.members >= FREE_MEMBER_LIMIT && (await planOf(meta.ownerId)) !== 'pro')
        return res.status(402).json({ error: `This workspace is at the free plan's ${FREE_MEMBER_LIMIT}-member limit — its owner can upgrade to Pro for unlimited members.`, upgrade: true });
    }
  }
  const ws = await store.consumeInvite(u.uid, code);
  if (!ws) return res.status(404).json({ error: 'Invalid or expired invite code' });
  res.json({ workspace: ws });
}));

// static app
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => { if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' }); res.sendFile(path.join(PUBLIC_DIR, 'index.html')); });

// realtime
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const rooms = new Map(); // workspaceId -> Set<{ws,clientId,uid,email}>
function broadcast(wsId, fromClientId, rev) {
  const set = rooms.get(wsId); if (!set) return;
  for (const c of set) { if (c.clientId && c.clientId === fromClientId) continue; try { c.ws.send(JSON.stringify({ type: 'update', rev })); } catch (e) {} }
}
function presenceList(wsId) { const set = rooms.get(wsId); if (!set) return []; return [...new Set([...set].map(c => c.email).filter(Boolean))]; }
function broadcastPresence(wsId) { const set = rooms.get(wsId); if (!set) return; const online = presenceList(wsId); const msg = JSON.stringify({ type: 'presence', online }); for (const c of set) { try { c.ws.send(msg); } catch (e) {} } }
function kickUser(wsId, userId) { const set = rooms.get(wsId); if (!set) return; for (const c of [...set]) { if (c.uid === userId) { try { c.ws.send(JSON.stringify({ type: 'removed' })); c.ws.close(); } catch (e) {} } } }
function closeRoom(wsId) { const set = rooms.get(wsId); if (!set) return; for (const c of [...set]) { try { c.ws.send(JSON.stringify({ type: 'removed' })); c.ws.close(); } catch (e) {} } rooms.delete(wsId); }
wss.on('connection', async (ws, req) => {
  try {
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('token');
    const wsId = u.searchParams.get('workspace');
    const clientId = u.searchParams.get('clientId') || '';
    const p = jwt.verify(token, JWT_SECRET);
    if (!wsId || !(await store.role(p.uid, wsId))) { ws.close(); return; }
    if (!rooms.has(wsId)) rooms.set(wsId, new Set());
    const entry = { ws, clientId, uid: p.uid, email: p.email };
    rooms.get(wsId).add(entry);
    ws.on('close', () => { const s = rooms.get(wsId); if (s) { s.delete(entry); if (!s.size) rooms.delete(wsId); else broadcastPresence(wsId); } });
    ws.send(JSON.stringify({ type: 'connected', workspace: wsId }));
    broadcastPresence(wsId);
  } catch (e) { try { ws.close(); } catch (_) {} }
});

(async () => {
  try { await store.init(); } catch (e) { console.error('[taskflow] store init failed', e); }
  server.listen(PORT, () => console.log(`[taskflow] listening on :${PORT} · mode=${MODE} · data=${DATA_DIR}`));
})();
