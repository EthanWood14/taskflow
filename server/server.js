// TaskFlow backend — accounts + shared multi-user workspaces + real-time + REST API.
// Serves the static app too. Storage: JSON file (default) or Postgres (if DATABASE_URL).
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { makeStore } from './storage.js';
import { applyImport } from './importer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');
// Session signing key. Prefer the env var; otherwise keep a generated one next to the data so
// restarts don't sign everyone out (only works if DATA_DIR is a real mount — see /api/health).
function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const f = path.join(DATA_DIR, '.jwt-secret');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(f)) { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) { console.warn('[taskflow] JWT_SECRET not set — reusing the key stored in DATA_DIR.'); return s; } }
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    console.warn('[taskflow] JWT_SECRET not set — generated one and stored it in DATA_DIR. Set JWT_SECRET in Railway to be safe.');
    return s;
  } catch (e) {
    console.warn('[taskflow] JWT_SECRET not set and DATA_DIR is not writable — using a throwaway secret; everyone is signed out on each restart.');
    return crypto.randomBytes(32).toString('hex');
  }
}
const JWT_SECRET = resolveJwtSecret();

const store = makeStore(DATA_DIR);
const MODE = process.env.DATABASE_URL ? 'pg' : 'json';

// ---------- Stripe (payment processor) ----------
// Fully active once STRIPE_SECRET_KEY + STRIPE_PRICE_ID (+ STRIPE_WEBHOOK_SECRET) are set.
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PRICE_DISPLAY = process.env.STRIPE_PRICE_DISPLAY || '$1.50 / user / mo';
const UNIT_CENTS = parseInt(process.env.STRIPE_UNIT_AMOUNT_CENTS || '150', 10); // $1.50 per user per month
const TRIAL_DAYS = parseInt(process.env.STRIPE_TRIAL_DAYS || '14', 10);          // 14-day free trial (0 disables)
const BILLING_ON = !!(STRIPE_KEY && STRIPE_PRICE_ID);
if (!BILLING_ON) console.warn('[taskflow] billing disabled — set STRIPE_SECRET_KEY and STRIPE_PRICE_ID to enable');
async function stripeReq(path, params, method = 'POST') {
  const opts = { method, headers: { Authorization: 'Bearer ' + STRIPE_KEY } };
  if (method !== 'GET') { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(params || {}).toString(); }
  const r = await fetch('https://api.stripe.com/v1' + path, opts);
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Stripe error');
  return d;
}
// Per-seat billing: keep the owner's subscription quantity in step with how many
// people are in workspaces they own. Stripe prorates the difference automatically.
async function syncSeats(ownerId) {
  try {
    if (!BILLING_ON || !ownerId) return;
    const u = await store.getUserById(ownerId);
    if (!u || u.plan !== 'pro' || !u.stripeSubscriptionId) return;
    const seats = await store.countSeats(ownerId);
    const sub = await stripeReq('/subscriptions/' + u.stripeSubscriptionId, null, 'GET');
    const item = sub.items && sub.items.data && sub.items.data[0];
    if (!item || item.quantity === seats) return;
    await stripeReq('/subscriptions/' + u.stripeSubscriptionId, { 'items[0][id]': item.id, 'items[0][quantity]': String(seats), proration_behavior: 'create_prorations' });
    console.log('[billing] seats for', ownerId, '->', seats);
  } catch (e) { console.error('[billing] seat sync failed:', e.message); }
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
// Two credential kinds on the Authorization header:
//   Bearer <jwt>        — browser sessions (login/signup)
//   Bearer tfk_<hex>    — personal API token minted in Settings → ☁ Cloud sync → 🔌 API token (only its SHA-256 is stored)
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
async function resolveAuth(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i); if (!m) return null;
  const cred = m[1].trim();
  if (cred.startsWith('tfk_')) { const u = await store.getUserByApiTokenHash(hashToken(cred)); return u ? { uid: u.id, email: u.email, viaToken: true } : null; }
  try { return jwt.verify(cred, JWT_SECRET); } catch (e) { return null; }
}
function auth(req) { return req.user || null; }
function asyncH(fn) { return (req, res) => Promise.resolve(fn(req, res)).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); }); }

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy; needed so req.ip is the real client address

// Brute-force guard for credential endpoints: N attempts per client IP per window.
// In-memory and per-process, which is fine for a single Railway instance.
const RL = new Map(); // key -> [timestamps]
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now(), key = req.ip + ' ' + req.path;
    const hits = (RL.get(key) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) return res.status(429).json({ error: 'Too many attempts — please wait a few minutes and try again' });
    hits.push(now); RL.set(key, hits); next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RL) if (!v.some(t => now - t < 15 * 60 * 1000)) RL.delete(k); }, 5 * 60 * 1000).unref();
const authLimit = rateLimit(30, 15 * 60 * 1000);

// Stripe webhook needs the RAW body for signature verification — mount before express.json().
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), asyncH(async (req, res) => {
  if (!BILLING_ON || !STRIPE_WEBHOOK_SECRET) return res.status(400).json({ error: 'Billing not configured' });
  if (!verifyStripeSig(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)) return res.status(400).json({ error: 'Bad signature' });
  const event = JSON.parse(req.body.toString('utf8'));
  const obj = (event.data && event.data.object) || {};
  if (event.type === 'checkout.session.completed') {
    const uid = (obj.metadata && obj.metadata.userId) || obj.client_reference_id;
    if (uid) { await store.setBilling(uid, { plan: 'pro', stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription }); syncSeats(uid); }
  } else if (event.type === 'customer.subscription.deleted') {
    const u = await store.getUserByStripeCustomer(obj.customer);
    if (u) await store.setBilling(u.id, { plan: 'free', stripeSubscriptionId: null });
  } else if (event.type === 'customer.subscription.updated') {
    const u = await store.getUserByStripeCustomer(obj.customer);
    if (u) await store.setBilling(u.id, { plan: (obj.status === 'active' || obj.status === 'trialing') ? 'pro' : 'free' });
  }
  res.json({ received: true });
}));

// Each workspace syncs as ONE JSON document, so this caps total workspace size. Keep it generous.
const BODY_LIMIT = process.env.BODY_LIMIT || '32mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: `Workspace is too large to sync (over ${BODY_LIMIT}). Export a backup, then delete or archive old completed tasks.` });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  next(err);
});
app.use((req, res, next) => { res.set('Access-Control-Allow-Origin', '*'); res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });

app.use((req, _res, next) => { resolveAuth(req).then(u => { req.user = u; next(); }).catch(() => { req.user = null; next(); }); });

// `persistent` tells you whether DATA_DIR is a real mount (Railway Volume). If false and mode=json,
// every redeploy wipes accounts, tasks and staged imports.
function dataDirIsMount() {
  try { if (MODE === 'pg') return true; const mounts = fs.readFileSync('/proc/mounts', 'utf8'); return mounts.split('\n').some(l => l.split(' ')[1] === DATA_DIR); } catch (e) { return null; }
}
// How many tasks the bundled first-run seed holds (null when the image has no seed file).
function seedTaskCount() {
  try { const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-import.json'), 'utf8')); return Array.isArray(d.tasks) ? d.tasks.length : null; } catch (e) { return null; }
}
app.get('/api/health', asyncH(async (_req, res) => {
  let staged = 0; try { staged = (await store.listStagedImports()).length; } catch (e) {}
  res.json({ ok: true, mode: MODE, ai: !!process.env.ANTHROPIC_API_KEY, site: SITE_MODE, persistent: dataDirIsMount(), dataDir: DATA_DIR, stagedImports: staged, seedTasks: seedTaskCount(), features: ['api-tokens', 'import', 'staged-imports', 'password-mode'] });
}));

// ---------- Single-password mode (default) ----------
// One password protects the whole app; no emails or usernames. Under the hood it is a single synthetic
// account ("site") with one workspace, so every workspace/import/token endpoint works unchanged.
// Set SITE_MODE=accounts to run the classic multi-user signup/login flow instead.
const SITE_MODE = process.env.SITE_MODE === 'accounts' ? 'accounts' : 'password';
const SITE_UID = 'u_site', SITE_EMAIL = 'site@local';
const siteUser = () => store.getUserById(SITE_UID);
const siteSession = async (u) => ({ token: sign(u), email: SITE_EMAIL, name: u.name || 'Me', plan: 'free', site: true, workspaces: await store.listWorkspaces(SITE_UID) });
// Fill an empty site workspace: first from any other workspace on this server, otherwise from the
// bundled seed-import.json. The bundle matters because without a mounted Volume the JSON store is
// wiped on every redeploy — the seed makes the app come back with real data instead of samples.
async function seedSiteWorkspace() {
  const mine = (await store.listWorkspaces(SITE_UID))[0]; if (!mine) return;
  const cur = await store.getState(mine.id);
  if (cur && cur.state && Array.isArray(cur.state.tasks) && cur.state.tasks.length) return;

  const all = (await store.listAllWorkspaces()).filter(w => w.ownerId !== SITE_UID && w.state && Array.isArray(w.state.tasks) && w.state.tasks.length);
  if (all.length) {
    all.sort((a, b) => (b.state.tasks.length - a.state.tasks.length) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    await store.putState(mine.id, all[0].state);
    console.log('[site] seeded workspace from', all[0].id, `(${all[0].state.tasks.length} tasks)`);
    return;
  }
  try {
    const p = path.join(__dirname, 'seed-import.json');
    if (!fs.existsSync(p)) return;
    const seed = JSON.parse(fs.readFileSync(p, 'utf8'));
    const r = applyImport(cur ? cur.state : null, seed, { replace: true });
    if (!r.ok) return console.warn('[site] seed import failed:', r.msg);
    await store.putState(mine.id, r.state);
    console.log('[site] seeded workspace from bundled seed-import.json —', r.msg);
  } catch (e) { console.warn('[site] seed import error:', e.message); }
}
app.get('/api/site', asyncH(async (_req, res) => { res.json({ mode: SITE_MODE, configured: SITE_MODE === 'password' ? !!(await siteUser()) : null }); }));
app.post('/api/site/setup', authLimit, asyncH(async (req, res) => {
  if (SITE_MODE !== 'password') return res.status(404).json({ error: 'Not in password mode' });
  if (await siteUser()) return res.status(409).json({ error: 'Already set up — enter the password instead' });
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const u = await store.createUser({ id: SITE_UID, email: SITE_EMAIL, hash: await bcrypt.hash(password, 10), name: 'Me', recoveryHash: null });
  await seedSiteWorkspace();
  console.log('[site] password set');
  res.json(await siteSession(u));
}));
app.post('/api/unlock', authLimit, asyncH(async (req, res) => {
  if (SITE_MODE !== 'password') return res.status(404).json({ error: 'Not in password mode' });
  const u = await siteUser(); if (!u) return res.status(409).json({ error: 'Not set up yet', setup: true });
  if (!(await bcrypt.compare(String(req.body.password || ''), u.hash))) return res.status(401).json({ error: 'Wrong password' });
  await seedSiteWorkspace();   // no-op unless the workspace is empty (e.g. after a data reset)
  res.json(await siteSession(u));
}));
// Password mode: what's parked and waiting (so the app can offer it right after unlock)
app.get('/api/imports/pending', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (u.uid !== SITE_UID) return res.json({ imports: [] });
  const now = Date.now();
  const list = (await store.listStagedImports()).filter(r => now - (r.createdAt || 0) <= 48 * 60 * 60 * 1000).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ imports: list });
}));

// ---------- Personal API token (for scripts / agents importing on your behalf) ----------
app.post('/api/account/api-token', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (u.viaToken) return res.status(403).json({ error: 'Sign in with your password to mint a new API token' });
  const token = 'tfk_' + crypto.randomBytes(24).toString('hex');
  await store.updateUser(u.uid, { apiTokenHash: hashToken(token) });
  res.json({ token }); // shown once; only the hash is stored
}));
app.post('/api/account/api-token/revoke', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  await store.updateUser(u.uid, { apiTokenHash: null });
  res.json({ ok: true });
}));

app.post('/api/signup', authLimit, asyncH(async (req, res) => {
  if (SITE_MODE === 'password') return res.status(404).json({ error: 'This TaskFlow is password-protected — sign-ups are off' });
  const email = norm(req.body.email), password = String(req.body.password || ''), name = String(req.body.name || '').trim().slice(0, 60);
  if (!validEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (await store.getUserByEmail(email)) return res.status(409).json({ error: 'Account already exists — log in instead' });
  // Recovery code: shown to the user exactly once; only its hash is stored.
  const recoveryCode = 'rk-' + crypto.randomBytes(3).toString('hex') + '-' + crypto.randomBytes(3).toString('hex') + '-' + crypto.randomBytes(3).toString('hex');
  const user = await store.createUser({ id: 'u_' + crypto.randomBytes(8).toString('hex'), email, hash: await bcrypt.hash(password, 10), name, recoveryHash: await bcrypt.hash(recoveryCode, 10) });
  res.json({ token: sign(user), email, name: user.name, plan: 'free', recoveryCode, workspaces: await store.listWorkspaces(user.id) });
}));

// Self-service password reset using the recovery code (no email provider needed).
app.post('/api/reset-password', authLimit, asyncH(async (req, res) => {
  const email = norm(req.body.email), code = String(req.body.recoveryCode || '').trim(), next = String(req.body.newPassword || '');
  const user = await store.getUserByEmail(email);
  if (!user || !user.recoveryHash || !(await bcrypt.compare(code, user.recoveryHash))) return res.status(401).json({ error: 'Email or recovery code is wrong' });
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  await store.updateUser(user.id, { hash: await bcrypt.hash(next, 10) });
  res.json({ token: sign(user), email, name: user.name, plan: user.plan === 'pro' ? 'pro' : 'free', workspaces: await store.listWorkspaces(user.id) });
}));

// Regenerate the recovery code (e.g. after using it, or if it was never saved).
app.post('/api/account/recovery', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const recoveryCode = 'rk-' + crypto.randomBytes(3).toString('hex') + '-' + crypto.randomBytes(3).toString('hex') + '-' + crypto.randomBytes(3).toString('hex');
  await store.updateUser(u.uid, { recoveryHash: await bcrypt.hash(recoveryCode, 10) });
  res.json({ recoveryCode });
}));

app.post('/api/login', authLimit, asyncH(async (req, res) => {
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
  let plan = 'free', seats = 1;
  if (u) { plan = await planOf(u.uid); seats = await store.countSeats(u.uid); }
  res.json({ enabled: BILLING_ON, plan, priceDisplay: PRICE_DISPLAY, unitCents: UNIT_CENTS, trialDays: TRIAL_DAYS, seats, freeLimits: { workspaces: FREE_WS_LIMIT, members: FREE_MEMBER_LIMIT } });
}));

app.post('/api/billing/checkout', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!BILLING_ON) return res.status(400).json({ error: 'Billing is not configured on this server yet — see BACKEND.md (set STRIPE_SECRET_KEY and STRIPE_PRICE_ID).' });
  const me = await store.getUserById(u.uid);
  const seats = await store.countSeats(u.uid);   // $1.50 × every member in workspaces you own
  const origin = req.headers.origin || ('https://' + req.headers.host);
  const params = {
    mode: 'subscription',
    'line_items[0][price]': STRIPE_PRICE_ID,
    'line_items[0][quantity]': String(seats),
    success_url: origin + '/?billing=success',
    cancel_url: origin + '/?billing=cancel',
    'metadata[userId]': u.uid,
    client_reference_id: u.uid,
  };
  if (TRIAL_DAYS > 0 && !(me && me.stripeSubscriptionId)) params['subscription_data[trial_period_days]'] = String(TRIAL_DAYS); // trial for first-time subscribers only
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

// Server-side import: same JSON the in-app Import / Export panel accepts (see README "Import JSON shape").
// Body: { data: {projects,labels,tasks}, replace?: boolean }  — or the import JSON itself with an optional top-level "replace".
// Merges into the workspace state, bumps rev, and nudges every connected client to pull.
app.post('/api/workspaces/:id/import', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await store.role(u.uid, req.params.id))) return res.status(403).json({ error: 'Not a member' });
  const body = req.body || {};
  const data = (body.data && typeof body.data === 'object') ? body.data : body;
  const replace = !!body.replace;
  const rec = await store.getState(req.params.id);
  const r = applyImport(rec ? rec.state : null, data, { replace });
  if (!r.ok) return res.status(400).json({ error: r.msg });
  const rev = await store.putState(req.params.id, r.state);
  broadcast(req.params.id, null, rev);
  console.log('[import]', u.email, '->', req.params.id, replace ? '(replace)' : '(merge)', r.msg);
  res.json({ ok: true, rev, msg: r.msg, stats: r.stats, counts: { projects: r.state.projects.length, sections: r.state.sections.length, tasks: r.state.tasks.filter(t => !t.parentId).length, subtasks: r.state.tasks.filter(t => t.parentId).length, open: r.state.tasks.filter(t => !t.completed).length } });
}));

// ---------- Staged imports (one-click links) ----------
// Anyone can *park* a payload here (rate-limited, expires in 48h); it only lands in a workspace once a
// signed-in member opens https://<app>/?import=CODE and confirms. Nothing is applied without that click.
const STAGE_TTL = 48 * 60 * 60 * 1000;
const importCounts = (data) => { const tasks = Array.isArray(data.tasks) ? data.tasks : []; return { projects: (data.projects || []).length, tasks: tasks.length, subtasks: tasks.reduce((a, t) => a + ((t && t.subtasks) || []).length, 0), labels: (data.labels || []).length }; };
app.post('/api/imports/stage', rateLimit(10, 15 * 60 * 1000), asyncH(async (req, res) => {
  const body = req.body || {};
  const data = (body.data && typeof body.data === 'object') ? body.data : null;
  if (!data || !Array.isArray(data.tasks)) return res.status(400).json({ error: 'Body must be { data: { tasks: [...] }, replace?, label? }' });
  const code = crypto.randomBytes(8).toString('hex');
  const rec = { data, replace: !!body.replace, label: String(body.label || 'Import').slice(0, 80), createdAt: Date.now(), counts: importCounts(data) };
  await store.stageImport(code, rec);
  const origin = req.headers.origin || ('https://' + req.headers.host);
  console.log('[import] staged', code, rec.label, JSON.stringify(rec.counts), rec.replace ? '(replace)' : '(merge)');
  res.json({ code, url: origin + '/?import=' + code, expiresAt: rec.createdAt + STAGE_TTL, counts: rec.counts });
}));
app.get('/api/imports/:code', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const rec = await store.getStagedImport(String(req.params.code || ''));
  if (!rec || Date.now() - (rec.createdAt || 0) > STAGE_TTL) return res.status(404).json({ error: 'That import link has expired or was already used' });
  res.json({ label: rec.label, replace: !!rec.replace, counts: rec.counts, createdAt: rec.createdAt, workspaces: await store.listWorkspaces(u.uid) });
}));
app.post('/api/imports/:code/apply', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const code = String(req.params.code || '');
  const rec = await store.getStagedImport(code);
  if (!rec || Date.now() - (rec.createdAt || 0) > STAGE_TTL) return res.status(404).json({ error: 'That import link has expired or was already used' });
  const wsId = String(req.body.workspaceId || '');
  if (!(await store.role(u.uid, wsId))) return res.status(403).json({ error: 'Not a member of that workspace' });
  const replace = req.body.replace === undefined ? !!rec.replace : !!req.body.replace;
  const cur = await store.getState(wsId);
  const r = applyImport(cur ? cur.state : null, rec.data, { replace });
  if (!r.ok) return res.status(400).json({ error: r.msg });
  const rev = await store.putState(wsId, r.state);
  await store.deleteStagedImport(code);
  broadcast(wsId, null, rev);
  console.log('[import] applied', code, 'by', u.email, '->', wsId, replace ? '(replace)' : '(merge)', r.msg);
  res.json({ ok: true, rev, msg: r.msg, stats: r.stats });
}));
setInterval(() => { store.cleanupStaged(STAGE_TTL).catch(() => {}); }, 60 * 60 * 1000).unref();

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
  broadcast(req.params.id, null, -1); kickUser(req.params.id, req.body.userId); syncSeats(u.uid); res.json({ ok: true });
}));

app.post('/api/workspaces/:id/leave', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const role = await store.role(u.uid, req.params.id);
  if (!role) return res.status(400).json({ error: 'Not a member' });
  if (role === 'owner') return res.status(400).json({ error: "Owners can't leave — delete the workspace instead" });
  const meta = await store.getWorkspaceMeta(req.params.id);
  await store.removeMember(req.params.id, u.uid); kickUser(req.params.id, u.uid);
  if (meta) syncSeats(meta.ownerId);   // seat freed -> owner's bill shrinks
  res.json({ ok: true });
}));

app.post('/api/workspaces/:id/delete', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  if ((await store.role(u.uid, req.params.id)) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete this workspace' });
  await store.deleteWorkspace(req.params.id); broadcast(req.params.id, null, -1); closeRoom(req.params.id); syncSeats(u.uid); res.json({ ok: true });
}));

app.post('/api/join', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Not authenticated' });
  const code = String(req.body.code || '').trim();
  const inv = await store.peekInvite(code);
  const meta = inv ? await store.getWorkspaceMeta(inv.wsId) : null;
  if (BILLING_ON && meta && meta.members >= FREE_MEMBER_LIMIT && (await planOf(meta.ownerId)) !== 'pro')
    return res.status(402).json({ error: `This workspace is at the free plan's ${FREE_MEMBER_LIMIT}-member limit — its owner can upgrade to Pro for unlimited members.`, upgrade: true });
  const ws = await store.consumeInvite(u.uid, code);
  if (!ws) return res.status(404).json({ error: 'Invalid or expired invite code' });
  if (meta) syncSeats(meta.ownerId);   // new member -> bill one more seat ($1.50)
  res.json({ workspace: ws });
}));

// ---------- AI Braindump (Claude) ----------
// Turns a rambling brain-dump into structured tasks. Active once ANTHROPIC_API_KEY is set.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const BRAINDUMP_MODEL = process.env.BRAINDUMP_MODEL || 'claude-sonnet-4-6';
if (!ANTHROPIC_KEY) console.warn('[taskflow] AI braindump disabled — set ANTHROPIC_API_KEY to enable');
app.post('/api/braindump', asyncH(async (req, res) => {
  const u = auth(req); if (!u) return res.status(401).json({ error: 'Sign in to use AI organize' });
  if (!ANTHROPIC_KEY) return res.status(501).json({ error: 'AI not configured on this server — set ANTHROPIC_API_KEY (see BACKEND.md)' });
  const text = String(req.body.text || '').slice(0, 8000);
  if (!text.trim()) return res.status(400).json({ error: 'Empty brain-dump' });
  const projects = Array.isArray(req.body.projects) ? req.body.projects.slice(0, 60) : [];
  const today = String(req.body.today || '').slice(0, 10);
  const system = 'You are a task-extraction assistant. Read a person\'s messy, conversational, stream-of-consciousness brain-dump and extract concrete, actionable tasks. Be faithful — do not invent tasks. Each task gets a short imperative title. Assign every task to the single most appropriate EXISTING project by name (fall back to "Inbox"). Only use a section if it matches one listed under that project. Convert relative dates to absolute YYYY-MM-DD using the given today. Respond with ONLY a JSON object, no prose, no code fences.';
  const userMsg = `Today is ${today}.\nExisting projects and their sections (assign tasks to these):\n${JSON.stringify(projects)}\n\nBrain-dump:\n"""\n${text}\n"""\n\nReturn ONLY: {"tasks":[{"title":"...","project":"<existing project name or Inbox>","section":"<section name or null>","priority":1-4,"dueDate":"YYYY-MM-DD","dueTime":"HH:MM","recurrence":"every week|every 3 days|...","estimate":<minutes>,"labels":["..."]}]}. Omit any field you cannot infer (priority defaults to 4).`;
  let d;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: BRAINDUMP_MODEL, max_tokens: 2000, system, messages: [{ role: 'user', content: userMsg }] }),
    });
    d = await r.json();
    if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'AI request failed' });
  } catch (e) { return res.status(502).json({ error: 'Could not reach the AI service' }); }
  const txt = (d.content && d.content[0] && d.content[0].text) || '';
  const m = txt.match(/\{[\s\S]*\}/);
  let parsed; try { parsed = JSON.parse(m ? m[0] : txt); } catch (e) { return res.status(502).json({ error: 'AI returned unparseable output' }); }
  res.json({ tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 80) : [] });
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
