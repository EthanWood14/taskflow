// Server-side port of the client's runImport() (index.html) so the same
// import JSON can be applied straight to a cloud workspace via the API.
// Keep the merge rules identical to the client: idempotent by externalId,
// name-matching fallback, subtasks/comments/labels created as needed.

const PROJECT_COLORS = ['#dc4c3e','#eb8909','#f9d71c','#7ecc49','#299438','#6accbc','#158fad','#14aaf5','#96c3eb','#4073ff','#884dff','#af38eb','#eb96eb','#e05194','#ff8d85','#808080','#b8b8b8','#ccac93'];
const LABEL_COLORS = PROJECT_COLORS;
const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const inboxProject = () => ({ id: 'inbox', name: 'Inbox', color: '#808080', view: 'list', order: 0, archived: false, system: true });

export function emptyState() {
  return { projects: [inboxProject()], sections: [], labels: [], tasks: [], comments: [], filters: [], settings: {} };
}

/**
 * Apply an import payload to a workspace state.
 * @param {object|null} input   current workspace state (not mutated)
 * @param {object} data         import JSON: {projects,labels,tasks} or a full export {version,projects,sections,tasks,...}
 * @param {{replace?:boolean}} opts  replace=true wipes projects/sections/labels/tasks/comments first (settings & filters kept)
 * @returns {{ok:boolean,msg:string,state?:object,stats?:object}}
 */
export function applyImport(input, data, { replace = false } = {}) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { ok: false, msg: 'Import must be a JSON object' };
  let state = input ? JSON.parse(JSON.stringify(input)) : emptyState();

  // Full export format restore
  if (data.tasks && data.projects && data.sections && data.version && replace) {
    state = Object.assign({}, state, { projects: data.projects, sections: data.sections || [], labels: data.labels || [], tasks: data.tasks, comments: data.comments || [], filters: data.filters || state.filters || [] });
    return { ok: true, state, stats: { restored: data.tasks.length }, msg: `Restored ${data.tasks.length} tasks, ${data.projects.length} projects.` };
  }
  if (replace) state = Object.assign({}, state, { projects: [inboxProject()], sections: [], labels: [], tasks: [], comments: [] });
  for (const k of ['projects', 'sections', 'labels', 'tasks', 'comments', 'filters']) if (!Array.isArray(state[k])) state[k] = [];
  state.settings = state.settings || {};
  if (!state.projects.some(p => p.id === 'inbox')) state.projects.unshift(inboxProject());
  state.stats = Object.assign({ xp: 0, level: 1, streak: 0, longestStreak: 0, lastActiveDate: null, totalCompleted: 0 }, state.stats || {});
  state.activity = state.activity || {};

  const stats = { tasks: 0, updated: 0, projects: 0, labels: 0, sections: 0, subtasks: 0, comments: 0 };
  const asTime = (value, fallback = null) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) { const n = Date.parse(value); if (Number.isFinite(n)) return n; }
    return fallback;
  };
  const getProject = (id) => state.projects.find(p => p.id === id);
  const projectSections = (pid) => state.sections.filter(s => s.projectId === pid);

  const labelByName = {};
  state.labels.forEach(l => labelByName[String(l.name).toLowerCase()] = l);
  const ensureLabel = (name, color) => {
    const k = String(name).toLowerCase();
    if (labelByName[k]) return labelByName[k];
    const l = { id: uid('lbl'), name: String(name), color: color || LABEL_COLORS[state.labels.length % LABEL_COLORS.length] };
    state.labels.push(l); labelByName[k] = l; stats.labels++; return l;
  };
  (data.labels || []).forEach(l => ensureLabel(l.name, l.color));

  const projByName = {};
  const projByExternalId = {};
  state.projects.forEach(p => projByName[String(p.name).toLowerCase()] = p);
  state.projects.forEach(p => { if (p.externalId) projByExternalId[String(p.externalId)] = p; });
  const ensureProject = (name, color, view, externalId = null, archived = null) => {
    if (!name) return getProject('inbox');
    const k = String(name).toLowerCase();
    if (externalId && projByExternalId[String(externalId)]) {
      const p = projByExternalId[String(externalId)];
      p.name = String(name); if (color) p.color = color; if (view) p.view = view === 'board' ? 'board' : 'list'; if (archived !== null) p.archived = !!archived;
      return p;
    }
    if (!externalId && projByName[k]) return projByName[k];
    const p = { id: uid('proj'), externalId: externalId ? String(externalId) : null, name: String(name), color: color || PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length], view: view === 'board' ? 'board' : 'list', order: state.projects.length, archived: !!archived, folderId: null, startDate: null, dueDate: null, custom: {} };
    state.projects.push(p); if (!projByName[k]) projByName[k] = p; if (p.externalId) projByExternalId[p.externalId] = p; stats.projects++; return p;
  };
  const sectionByKey = {};
  const sectionByExternalId = {};
  state.sections.forEach(s => sectionByKey[s.projectId + '::' + String(s.name).toLowerCase()] = s);
  state.sections.forEach(s => { if (s.externalId) sectionByExternalId[String(s.externalId)] = s; });
  const ensureSection = (proj, name, externalId = null) => {
    if (!name) return null;
    if (externalId && sectionByExternalId[String(externalId)]) return sectionByExternalId[String(externalId)];
    const k = proj.id + '::' + String(name).toLowerCase();
    if (!externalId && sectionByKey[k]) return sectionByKey[k];
    const s = { id: uid('sec'), externalId: externalId ? String(externalId) : null, projectId: proj.id, name: String(name), order: projectSections(proj.id).length };
    state.sections.push(s); if (!sectionByKey[k]) sectionByKey[k] = s; if (s.externalId) sectionByExternalId[s.externalId] = s; stats.sections++; return s;
  };

  (data.projects || []).forEach(p => {
    const proj = ensureProject(p.name, p.color, p.view, p.externalId, p.archived === undefined ? null : p.archived);
    proj.startDate = p.startDate || proj.startDate || null; proj.dueDate = p.dueDate || proj.dueDate || null; proj.custom = Object.assign({}, proj.custom || {}, p.custom || {});
    (p.sections || []).forEach(rawSec => { const sec = typeof rawSec === 'string' ? { name: rawSec } : rawSec; ensureSection(proj, sec && sec.name, sec && sec.externalId); });
  });

  const taskByExternalId = {};
  state.tasks.forEach(t => { if (t.externalId) taskByExternalId[String(t.externalId)] = t; });
  const userName = (state.settings && state.settings.userName) || 'Me';
  const addTask = (raw, parentId = null) => {
    if (typeof raw !== 'object' || raw === null) return null;
    const proj = parentId ? null : ensureProject(raw.project, null, null, raw.projectExternalId || null);
    const sec = (proj && raw.section) ? ensureSection(proj, raw.section, raw.sectionExternalId || null) : null;
    const labelIds = (raw.labels || []).map(n => ensureLabel(n).id);
    const externalId = raw.externalId ? String(raw.externalId) : null;
    let t = externalId ? taskByExternalId[externalId] : null;
    const wasExisting = !!t;
    const wasCompleted = !!(t && t.completed);
    const parent = parentId ? state.tasks.find(x => x.id === parentId) : null;
    const next = {
      externalId,
      projectId: parentId ? (parent || {}).projectId || 'inbox' : (proj ? proj.id : 'inbox'),
      sectionId: parentId ? (parent && parent.sectionId) || null : (sec ? sec.id : null),
      parentId,
      title: String(raw.title || 'Untitled'),
      description: raw.description || '',
      priority: [1, 2, 3, 4].includes(raw.priority) ? raw.priority : 4,
      startDate: raw.startDate || null,
      dueDate: raw.dueDate || null,
      dueTime: raw.dueTime || null,
      recurrence: raw.recurrence || null,
      labels: labelIds,
      assignee: raw.assignee || null,
      completed: !!raw.completed,
      completedAt: raw.completed ? asTime(raw.completedAt, Date.now()) : null,
      createdAt: asTime(raw.createdAt, wasExisting ? t.createdAt : Date.now()),
      dependsOn: [], timeSpent: 0, estimate: (typeof raw.estimate === 'number' ? raw.estimate : null),
      status: raw.completed ? 'done' : (raw.status || 'todo'), deadline: raw.deadline || null, milestone: !!raw.milestone, type: raw.type || 'task', attachments: [], custom: raw.custom || {},
      order: parentId ? state.tasks.filter(x => x.parentId === parentId).length : state.tasks.filter(x => x.projectId === (proj ? proj.id : 'inbox') && !x.parentId).length,
    };
    if (wasExisting) { Object.assign(t, next); stats.updated++; }
    else { t = Object.assign({ id: uid('task') }, next); state.tasks.push(t); if (externalId) taskByExternalId[externalId] = t; if (parentId) stats.subtasks++; else stats.tasks++; }
    if (next.completed && !wasCompleted) { const ds = ymd(new Date(next.completedAt)); state.activity[ds] = (state.activity[ds] || 0) + 1; state.stats.totalCompleted = (state.stats.totalCompleted || 0) + 1; }
    (raw.subtasks || []).forEach(st => addTask(st, t.id));
    (raw.comments || []).forEach(c => { state.comments.push({ id: uid('cm'), taskId: t.id, text: String((c && c.text) || c), author: (c && c.author) || userName, createdAt: Date.now() }); stats.comments++; });
    return t;
  };
  (data.tasks || []).forEach(t => addTask(t));

  const parts = [];
  if (stats.tasks) parts.push(stats.tasks + ' tasks');
  if (stats.subtasks) parts.push(stats.subtasks + ' subtasks');
  if (stats.updated) parts.push(stats.updated + ' updated');
  if (stats.projects) parts.push(stats.projects + ' projects');
  if (stats.sections) parts.push(stats.sections + ' sections');
  if (stats.labels) parts.push(stats.labels + ' labels');
  if (stats.comments) parts.push(stats.comments + ' comments');
  return { ok: true, state, stats, msg: parts.length ? 'Imported ' + parts.join(', ') + '.' : 'Nothing to import — check your JSON has a "tasks" array.' };
}
