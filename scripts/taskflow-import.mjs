#!/usr/bin/env node
// Import a TaskFlow JSON payload into a cloud workspace through the REST API.
//
//   node scripts/taskflow-import.mjs <payload.json> [--replace] [--workspace <id or name>] [--url <https://your-app>] [--dry-run]
//
// Auth: a personal API token minted in the app (Settings → ☁ Cloud sync → 🔌 API token).
// The token is read from the TASKFLOW_TOKEN env var or the first line of ~/.taskflow/token.
// It is never printed. Requires Node 18+ (built-in fetch).
import fs from 'fs';
import os from 'os';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const file = args.find(a => !a.startsWith('--') && a.endsWith('.json'));
const replace = args.includes('--replace');
const dryRun = args.includes('--dry-run');
const wsWanted = flag('--workspace');
const base = (flag('--url') || process.env.TASKFLOW_URL || 'https://taskflow-production-5305.up.railway.app').replace(/\/+$/, '');

function die(msg) { console.error('✗ ' + msg); process.exit(1); }
if (!file) die('Usage: node scripts/taskflow-import.mjs <payload.json> [--replace] [--workspace <id|name>] [--url <base>] [--dry-run]');
if (!fs.existsSync(file)) die('File not found: ' + file);

let token = process.env.TASKFLOW_TOKEN || '';
if (!token) { const p = path.join(os.homedir(), '.taskflow', 'token'); if (fs.existsSync(p)) token = fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim(); }
if (!token) die('No API token. Set TASKFLOW_TOKEN or put the token in ~/.taskflow/token (mint one in Settings → Cloud sync → API token).');
if (!token.startsWith('tfk_')) die('Token does not look like a TaskFlow API token (expected tfk_…).');

let data;
try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die('Payload is not valid JSON: ' + e.message); }
const tasks = Array.isArray(data.tasks) ? data.tasks : [];
const subtasks = tasks.reduce((a, t) => a + ((t.subtasks || []).length), 0);
console.log(`Payload: ${(data.projects || []).length} projects, ${tasks.length} tasks, ${subtasks} subtasks, ${(data.labels || []).length} labels (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);

const api = async (p, opts = {}) => {
  const r = await fetch(base + p, Object.assign({ headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } }, opts));
  let d = null; try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return d;
};

const me = await api('/api/me').catch(e => die('Could not authenticate against ' + base + ': ' + e.message));
const list = me.workspaces || [];
if (!list.length) die('This account has no workspaces.');
let ws = null;
if (wsWanted && wsWanted !== true) ws = list.find(w => w.id === wsWanted) || list.find(w => w.name.toLowerCase() === String(wsWanted).toLowerCase());
else ws = list.find(w => w.role === 'owner') || list[0];
if (!ws) die('Workspace not found. Available: ' + list.map(w => `${w.name} (${w.id})`).join(', '));
console.log(`Account: ${me.email} · workspace: ${ws.name} (${ws.id}) · mode: ${replace ? 'REPLACE ALL' : 'merge'}`);
if (dryRun) { console.log('Dry run — nothing sent.'); process.exit(0); }

const res = await api(`/api/workspaces/${ws.id}/import`, { method: 'POST', body: JSON.stringify({ data, replace }) }).catch(e => die('Import failed: ' + e.message));
console.log('✓ ' + res.msg + ` (rev ${res.rev})`);
if (res.counts) console.log(`  Workspace now: ${res.counts.projects} projects · ${res.counts.sections} sections · ${res.counts.tasks} tasks · ${res.counts.subtasks} subtasks · ${res.counts.open} open`);
