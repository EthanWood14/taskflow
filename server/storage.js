// Storage abstraction for TaskFlow: shared multi-user workspaces.
// Two interchangeable backends with the SAME async interface:
//   - JsonStore  (default): single JSON file on a Railway Volume. Holds all users/workspaces.
//   - PgStore    (used when DATABASE_URL is set): Railway Postgres, for durability/scale.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const newId = (p) => p + '_' + crypto.randomBytes(8).toString('hex');
const inviteCode = () => crypto.randomBytes(5).toString('hex'); // 10 chars

// ---------------------------------------------------------------------------
// JSON store
// ---------------------------------------------------------------------------
export class JsonStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'db.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = { users: {}, workspaces: {}, invites: {} };
    try { if (fs.existsSync(this.file)) this.db = migrateDb(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
    catch (e) { console.error('[storage] db read failed', e); }
    this._queued = false;
  }
  async init() {}
  _save() {
    if (this._queued) return; this._queued = true;
    setTimeout(() => { this._queued = false;
      try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file); }
      catch (e) { console.error('[storage] write failed', e); }
    }, 50);
  }
  async getUserByEmail(email) { return this.db.users[email] || null; }
  async getUserById(id) { return Object.values(this.db.users).find(u => u.id === id) || null; }
  async createUser({ id, email, hash, name }) {
    const u = { id, email, hash, name: name || email.split('@')[0], createdAt: Date.now() };
    this.db.users[email] = u;
    // personal workspace
    const ws = { id: newId('ws'), name: 'My Workspace', ownerId: id, createdAt: Date.now(), members: { [id]: 'owner' }, state: null, rev: 0, updatedAt: Date.now() };
    this.db.workspaces[ws.id] = ws;
    this._save();
    return u;
  }
  async listWorkspaces(userId) {
    return Object.values(this.db.workspaces)
      .filter(w => w.members && w.members[userId])
      .map(w => ({ id: w.id, name: w.name, role: w.members[userId], members: Object.keys(w.members).length }));
  }
  async createWorkspace(userId, name) {
    const ws = { id: newId('ws'), name: String(name || 'Workspace').slice(0, 60), ownerId: userId, createdAt: Date.now(), members: { [userId]: 'owner' }, state: null, rev: 0, updatedAt: Date.now() };
    this.db.workspaces[ws.id] = ws; this._save();
    return { id: ws.id, name: ws.name, role: 'owner', members: 1 };
  }
  async role(userId, wsId) { const w = this.db.workspaces[wsId]; return w && w.members[userId] ? w.members[userId] : null; }
  async getState(wsId) { const w = this.db.workspaces[wsId]; return w ? { state: w.state, rev: w.rev } : null; }
  async putState(wsId, state) { const w = this.db.workspaces[wsId]; if (!w) return null; w.state = state; w.rev = (w.rev || 0) + 1; w.updatedAt = Date.now(); this._save(); return w.rev; }
  async createInvite(wsId) { const code = inviteCode(); this.db.invites[code] = { wsId, createdAt: Date.now() }; this._save(); return code; }
  async consumeInvite(userId, code) {
    const inv = this.db.invites[code]; if (!inv) return null;
    const w = this.db.workspaces[inv.wsId]; if (!w) return null;
    w.members[userId] = w.members[userId] || 'member'; this._save();
    return { id: w.id, name: w.name, role: w.members[userId], members: Object.keys(w.members).length };
  }
  async listMembers(wsId) {
    const w = this.db.workspaces[wsId]; if (!w) return [];
    return Object.entries(w.members).map(([uid, role]) => { const u = Object.values(this.db.users).find(x => x.id === uid); return { userId: uid, email: u ? u.email : '?', name: u ? u.name : '?', role }; });
  }
  async removeMember(wsId, userId) { const w = this.db.workspaces[wsId]; if (!w) return false; if (w.members[userId] === 'owner') return false; delete w.members[userId]; this._save(); return true; }
  async deleteWorkspace(wsId) { delete this.db.workspaces[wsId]; for (const c of Object.keys(this.db.invites)) if (this.db.invites[c].wsId === wsId) delete this.db.invites[c]; this._save(); return true; }
  async updateUser(id, fields) { const u = Object.values(this.db.users).find(x => x.id === id); if (!u) return null; if (fields.name != null) u.name = String(fields.name).slice(0, 60); if (fields.hash) u.hash = fields.hash; this._save(); return u; }
  async setBilling(id, { plan, stripeCustomerId }) { const u = Object.values(this.db.users).find(x => x.id === id); if (!u) return null; if (plan != null) u.plan = plan; if (stripeCustomerId != null) u.stripeCustomerId = stripeCustomerId; this._save(); return u; }
  async getUserByStripeCustomer(cid) { return Object.values(this.db.users).find(x => x.stripeCustomerId === cid) || null; }
  async getWorkspaceMeta(wsId) { const w = this.db.workspaces[wsId]; if (!w) return null; return { ownerId: w.ownerId, members: Object.keys(w.members || {}).length }; }
  async peekInvite(code) { const inv = this.db.invites[code]; return inv ? { wsId: inv.wsId } : null; }
  async deleteUser(id) {
    for (const w of Object.values(this.db.workspaces)) {
      if (w.ownerId === id) { for (const c of Object.keys(this.db.invites)) if (this.db.invites[c].wsId === w.id) delete this.db.invites[c]; delete this.db.workspaces[w.id]; }
      else if (w.members && w.members[id]) delete w.members[id];
    }
    const u = Object.values(this.db.users).find(x => x.id === id); if (u) delete this.db.users[u.email];
    this._save(); return true;
  }
}

// Convert the v1 (per-user state) db shape into the v2 (workspaces) shape.
function migrateDb(db) {
  if (db.workspaces) return db; // already v2
  const out = { users: db.users || {}, workspaces: {}, invites: {} };
  for (const u of Object.values(out.users)) {
    const rec = (db.states || {})[u.id];
    const ws = { id: 'ws_' + u.id.slice(2), name: 'My Workspace', ownerId: u.id, createdAt: u.createdAt || Date.now(), members: { [u.id]: 'owner' }, state: rec ? rec.state : null, rev: rec ? rec.rev : 0, updatedAt: Date.now() };
    out.workspaces[ws.id] = ws;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------
export class PgStore {
  constructor(connectionString) {
    this.connectionString = connectionString;
  }
  async init() {
    const pg = await import('pg');
    const needSsl = /sslmode=require/.test(this.connectionString) || process.env.PGSSL === '1';
    this.pool = new pg.default.Pool({ connectionString: this.connectionString, ssl: needSsl ? { rejectUnauthorized: false } : false });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY, email text UNIQUE NOT NULL, hash text NOT NULL, name text, created_at bigint);
      CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, name text NOT NULL, owner_id text, created_at bigint, state jsonb, rev int DEFAULT 0, updated_at bigint);
      CREATE TABLE IF NOT EXISTS memberships (workspace_id text, user_id text, role text, PRIMARY KEY (workspace_id, user_id));
      CREATE TABLE IF NOT EXISTS invites (code text PRIMARY KEY, workspace_id text, created_at bigint);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS plan text;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text;
    `);
  }
  async getUserByEmail(email) { const r = await this.pool.query('SELECT id,email,hash,name,plan,stripe_customer_id AS "stripeCustomerId" FROM users WHERE email=$1', [email]); return r.rows[0] || null; }
  async getUserById(id) { const r = await this.pool.query('SELECT id,email,hash,name,plan,stripe_customer_id AS "stripeCustomerId" FROM users WHERE id=$1', [id]); return r.rows[0] || null; }
  async createUser({ id, email, hash, name }) {
    await this.pool.query('INSERT INTO users(id,email,hash,name,created_at) VALUES($1,$2,$3,$4,$5)', [id, email, hash, name || email.split('@')[0], Date.now()]);
    const wsId = newId('ws');
    await this.pool.query('INSERT INTO workspaces(id,name,owner_id,created_at,state,rev,updated_at) VALUES($1,$2,$3,$4,NULL,0,$4)', [wsId, 'My Workspace', id, Date.now()]);
    await this.pool.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [wsId, id, 'owner']);
    return { id, email, hash };
  }
  async listWorkspaces(userId) {
    const r = await this.pool.query(
      `SELECT w.id, w.name, m.role, (SELECT count(*) FROM memberships mm WHERE mm.workspace_id=w.id) AS members
       FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 ORDER BY w.created_at`, [userId]);
    return r.rows.map(x => ({ id: x.id, name: x.name, role: x.role, members: Number(x.members) }));
  }
  async createWorkspace(userId, name) {
    const wsId = newId('ws');
    await this.pool.query('INSERT INTO workspaces(id,name,owner_id,created_at,state,rev,updated_at) VALUES($1,$2,$3,$4,NULL,0,$4)', [wsId, String(name || 'Workspace').slice(0, 60), userId, Date.now()]);
    await this.pool.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)', [wsId, userId, 'owner']);
    return { id: wsId, name, role: 'owner', members: 1 };
  }
  async role(userId, wsId) { const r = await this.pool.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wsId, userId]); return r.rows[0] ? r.rows[0].role : null; }
  async getState(wsId) { const r = await this.pool.query('SELECT state,rev FROM workspaces WHERE id=$1', [wsId]); return r.rows[0] ? { state: r.rows[0].state, rev: r.rows[0].rev } : null; }
  async putState(wsId, state) { const r = await this.pool.query('UPDATE workspaces SET state=$2, rev=rev+1, updated_at=$3 WHERE id=$1 RETURNING rev', [wsId, state, Date.now()]); return r.rows[0] ? r.rows[0].rev : null; }
  async createInvite(wsId) { const code = inviteCode(); await this.pool.query('INSERT INTO invites(code,workspace_id,created_at) VALUES($1,$2,$3)', [code, wsId, Date.now()]); return code; }
  async consumeInvite(userId, code) {
    const r = await this.pool.query('SELECT workspace_id FROM invites WHERE code=$1', [code]); if (!r.rows[0]) return null;
    const wsId = r.rows[0].workspace_id;
    await this.pool.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [wsId, userId, 'member']);
    const w = await this.pool.query('SELECT id,name FROM workspaces WHERE id=$1', [wsId]);
    const mc = await this.pool.query('SELECT count(*) FROM memberships WHERE workspace_id=$1', [wsId]);
    return w.rows[0] ? { id: wsId, name: w.rows[0].name, role: 'member', members: Number(mc.rows[0].count) } : null;
  }
  async listMembers(wsId) {
    const r = await this.pool.query('SELECT u.id AS "userId", u.email, u.name, m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1', [wsId]);
    return r.rows;
  }
  async updateUser(id, fields) {
    if (fields.name != null) await this.pool.query('UPDATE users SET name=$2 WHERE id=$1', [id, String(fields.name).slice(0, 60)]);
    if (fields.hash) await this.pool.query('UPDATE users SET hash=$2 WHERE id=$1', [id, fields.hash]);
    return this.getUserById(id);
  }
  async setBilling(id, { plan, stripeCustomerId }) {
    if (plan != null) await this.pool.query('UPDATE users SET plan=$2 WHERE id=$1', [id, plan]);
    if (stripeCustomerId != null) await this.pool.query('UPDATE users SET stripe_customer_id=$2 WHERE id=$1', [id, stripeCustomerId]);
    return this.getUserById(id);
  }
  async getUserByStripeCustomer(cid) { const r = await this.pool.query('SELECT id,email,hash,name,plan FROM users WHERE stripe_customer_id=$1', [cid]); return r.rows[0] || null; }
  async getWorkspaceMeta(wsId) {
    const w = await this.pool.query('SELECT owner_id AS "ownerId" FROM workspaces WHERE id=$1', [wsId]); if (!w.rows[0]) return null;
    const c = await this.pool.query('SELECT count(*) FROM memberships WHERE workspace_id=$1', [wsId]);
    return { ownerId: w.rows[0].ownerId, members: Number(c.rows[0].count) };
  }
  async peekInvite(code) { const r = await this.pool.query('SELECT workspace_id FROM invites WHERE code=$1', [code]); return r.rows[0] ? { wsId: r.rows[0].workspace_id } : null; }
  async deleteUser(id) {
    const owned = await this.pool.query('SELECT id FROM workspaces WHERE owner_id=$1', [id]);
    for (const w of owned.rows) { await this.pool.query('DELETE FROM memberships WHERE workspace_id=$1', [w.id]); await this.pool.query('DELETE FROM invites WHERE workspace_id=$1', [w.id]); await this.pool.query('DELETE FROM workspaces WHERE id=$1', [w.id]); }
    await this.pool.query('DELETE FROM memberships WHERE user_id=$1', [id]);
    await this.pool.query('DELETE FROM users WHERE id=$1', [id]);
    return true;
  }
  async removeMember(wsId, userId) {
    const r = await this.pool.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wsId, userId]);
    if (!r.rows[0] || r.rows[0].role === 'owner') return false;
    await this.pool.query('DELETE FROM memberships WHERE workspace_id=$1 AND user_id=$2', [wsId, userId]); return true;
  }
  async deleteWorkspace(wsId) {
    await this.pool.query('DELETE FROM memberships WHERE workspace_id=$1', [wsId]);
    await this.pool.query('DELETE FROM invites WHERE workspace_id=$1', [wsId]);
    await this.pool.query('DELETE FROM workspaces WHERE id=$1', [wsId]); return true;
  }
}

export function makeStore(dataDir) {
  if (process.env.DATABASE_URL) { console.log('[storage] using Postgres'); return new PgStore(process.env.DATABASE_URL); }
  console.log('[storage] using JSON file store at', dataDir);
  return new JsonStore(dataDir);
}
