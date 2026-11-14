// IdleShift GUI. No external resources; every piece of AI- or file-derived
// text is inserted with textContent (never as HTML), and links are never clickable.
'use strict';

const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(9)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

// ---- minimal Markdown viewer: builds DOM nodes only (no innerHTML), links stay plain text ----
function mdInline(text) {
  const out = []; const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g; let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t[0] === '`') out.push(h('code', {}, t.slice(1, -1)));
    else if (t.startsWith('**')) out.push(h('strong', {}, mdInline(t.slice(2, -2))));
    else out.push(h('em', {}, t.slice(1, -1)));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function md(text) {
  const root = h('div', { class: 'md' }); const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0, para = [];
  const flush = () => { if (para.length) { root.append(h('p', {}, para.flatMap((l, k) => k ? [h('br'), mdInline(l)] : [mdInline(l)]))); para = []; } };
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { flush(); const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; root.append(h('pre', {}, buf.join('\n'))); continue; }
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); root.append(h('h' + Math.min(6, m[1].length + 2), {}, mdInline(m[2]))); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); root.append(h('hr')); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      flush(); const head = cells(l); i += 2; const body = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      root.append(h('table', {}, h('tr', {}, head.map(c => h('th', {}, mdInline(c)))), body.map(r => h('tr', {}, r.map(c => h('td', {}, mdInline(c)))))));
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      flush(); const ordered = /^\s*\d/.test(l); const list = h(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) && (/^\s{2,}/.test(lines[i]) || /^\s*\d/.test(lines[i]) === ordered)) {
        const raw = lines[i++]; const depth = raw.match(/^\s*/)[0].length >= 2;
        const li = h('li', {}, mdInline(raw.replace(/^\s*([-*+]|\d+[.)])\s+/, '').replace(/^\[( |x)\]\s*/i, (s, x) => x === ' ' ? '☐ ' : '☑ ')));
        if (depth) li.style.marginLeft = '1.2em';
        list.append(li);
      }
      root.append(list); continue;
    }
    if (/^\s*>\s?/.test(l)) { flush(); const buf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); root.append(h('blockquote', {}, md(buf.join('\n')))); continue; }
    if (!l.trim()) { flush(); i++; continue; }
    para.push(l); i++;
  }
  flush();
  return root;
}

// ---- token: arrives once in the URL fragment, then lives only in this tab ----
let token = sessionStorage.getItem('t') || '';
if (location.hash.startsWith('#t=')) { token = location.hash.slice(3); sessionStorage.setItem('t', token); history.replaceState(null, '', location.pathname); }

function uiLang() {
  const pref = S && S.settings && S.settings.ui_language;
  if (pref === 'en' || pref === 'ja') return pref;
  const nav = (typeof navigator !== 'undefined' && (navigator.language || (navigator.languages && navigator.languages[0]))) || 'en';
  return String(nav).toLowerCase().startsWith('ja') ? 'ja' : 'en';
}
function gt(key, ...args) {
  const dicts = (typeof window !== 'undefined' && window.GUI_I18N) || {};
  const dict = dicts[uiLang()] || dicts.en || {};
  const val = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : (dicts.en && dicts.en[key]);
  if (typeof val === 'function') return val(...args);
  return val != null ? val : key;
}

async function api(method, params) {
  const res = await fetch('/api/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': token }, body: JSON.stringify({ method, params: params || {} }) });
  if (res.status === 401) throw new Error(gt('auth.expired'));
  const j = await res.json();
  if (!j.ok) throw new Error(j.message || j.error || gt('common.failed'));
  return j.result;
}

function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3500); }
async function act(fn, okMsg) { try { const r = await fn(); if (okMsg) toast(okMsg); await refresh(true); return r; } catch (e) { toast(e.message); return null; } }
async function copy(text) { try { await navigator.clipboard.writeText(text); toast(gt('common.copied')); } catch { toast(gt('common.copy_failed')); } }

const fmt = ts => (ts ? new Date(ts).toLocaleString(uiLang() === 'ja' ? 'ja-JP' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const ago = ts => { if (!ts) return ''; const s = Math.max(0, Math.round((Date.now() - ts) / 1000)); return s < 90 ? gt('time.sec_ago', s) : s < 5400 ? gt('time.min_ago', Math.round(s / 60)) : s < 172800 ? gt('time.hr_ago', Math.round(s / 3600)) : gt('time.day_ago', Math.round(s / 86400)); };

const GOAL_STATUS_CLS = { active: 'ok', paused: 'warn', waiting_decision: 'warn', done_candidate: 'warn', done: 'ok', stopped: 'bad', proposed: 'warn' };
const P_STATE_CLS = { waiting: 'ok', working: 'ok', active: 'ok', needs_resume: 'warn', no_response: 'bad', idle: '', revoked: 'bad' };
const DELEG_KEYS = ['research', 'write_files', 'run_code', 'install_deps', 'prototype'];
const KNOWN_ANSWERS = new Set(['extend', 'stop', 'continue', 'confirm', 'reject', 'retry', 'cancel', 'cancel_task', 'resume', 'allow_more']);
const answerLabel = o => o.startsWith('grant:') ? gt('answer.grant', o.slice(6).split(',').map(k => gt('deleg.' + k)).join(uiLang() === 'ja' ? '・' : ', ')) : o === 'deny' ? gt('answer.deny') : o === '再開' ? gt('answer.resume') : KNOWN_ANSWERS.has(o) ? gt('answer.' + o) : o;
const badge = (text, cls) => h('span', { class: `badge ${cls || ''}` }, text);

let showArchived = false;
const visibleProjects = () => S.projects.filter(p => showArchived || !p.archived);
const activeProjects = () => S.projects.filter(p => !p.archived);
let S = null, tab = 'home', openGoal = null, goalData = null, lastJson = '';

const TAB_KEYS = ['home', 'connect', 'decisions', 'maintain'];
function renderTabs() {
  const n = S ? S.decisions.length + S.projects.reduce((a, p) => a + p.needs_check.length, 0) : 0;
  $('tabs').replaceChildren(...TAB_KEYS.map(k => {
    const label = gt('tab.' + k);
    return h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; openGoal = null; render(); } }, k === 'decisions' && n ? `${label} (${n})` : label);
  }));
}

// ---- dialogs ----
function dialog(title, body, buttons) {
  const d = $('dlg');
  d.replaceChildren(h('h2', {}, title), body, h('div', { class: 'actions' }, ...(buttons || []), h('button', { onclick: () => d.close() }, gt('common.close'))));
  if (!d.open) d.showModal();
  return d;
}
const closeDialog = () => $('dlg').close();
const field = (label, input, hint) => [h('label', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null];

function goalForm(project, existing) {
  const g = existing || { delegation: { research: 'allow', write_files: 'deny', run_code: 'deny', install_deps: 'deny', prototype: 'deny' }, budgets: { max_assignments: 30, max_branches: 2, max_parallel: 2, max_redelegate: 3, max_no_progress: 3, lease_minutes: 30 } };
  const f = {
    title: h('input', { type: 'text', value: g.title || '' }), outcome: h('textarea', { value: g.outcome || '' }), done_evidence: h('textarea', { value: g.done_evidence || '' }),
    priorities: h('input', { type: 'text', value: g.priorities || '' }), notes: h('textarea', { value: g.notes || '' }),
    deadline: h('input', { type: 'datetime-local', value: g.budgets.deadline ? new Date(g.budgets.deadline - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '' })
  };
  const deleg = Object.fromEntries(DELEG_KEYS.map(k => [k, h('input', { type: 'checkbox', checked: g.delegation[k] === 'allow' })]));
  const num = k => h('input', { type: 'number', value: g.budgets[k], min: 1 });
  const b = { max_assignments: num('max_assignments'), max_parallel: num('max_parallel'), max_branches: num('max_branches'), max_no_progress: num('max_no_progress'), max_redelegate: num('max_redelegate'), lease_minutes: num('lease_minutes') };
  const body = h('div', {},
    field(gt('goal_form.title_label'), f.title, gt('goal_form.title_hint')),
    field(gt('goal_form.outcome_label'), f.outcome),
    field(gt('goal_form.done_label'), f.done_evidence, gt('goal_form.done_hint')),
    field(gt('goal_form.priorities_label'), f.priorities, gt('goal_form.priorities_hint')),
    field(gt('goal_form.notes_label'), f.notes),
    h('h3', {}, gt('goal_form.deleg_heading')),
    h('div', { class: 'hint small' }, gt('goal_form.deleg_hint')),
    DELEG_KEYS.map(k => h('label', { class: 'check' }, deleg[k], gt('deleg.' + k))),
    h('h3', {}, gt('goal_form.budget_heading')),
    h('div', { class: 'grid2' },
      h('div', {}, field(gt('goal_form.max_assignments'), b.max_assignments, gt('goal_form.max_assignments_hint'))), h('div', {}, field(gt('goal_form.max_parallel'), b.max_parallel)),
      h('div', {}, field(gt('goal_form.max_branches'), b.max_branches)), h('div', {}, field(gt('goal_form.max_no_progress'), b.max_no_progress)),
      h('div', {}, field(gt('goal_form.max_redelegate'), b.max_redelegate)), h('div', {}, field(gt('goal_form.lease_minutes'), b.lease_minutes, gt('goal_form.lease_hint')))),
    field(gt('goal_form.deadline'), f.deadline));
  const collect = () => ({
    title: f.title.value, outcome: f.outcome.value, done_evidence: f.done_evidence.value, priorities: f.priorities.value, notes: f.notes.value,
    delegation: Object.fromEntries(DELEG_KEYS.map(k => [k, deleg[k].checked ? 'allow' : 'deny'])),
    budgets: { ...Object.fromEntries(Object.entries(b).map(([k, el]) => [k, Number(el.value)])), deadline: f.deadline.value ? new Date(f.deadline.value).getTime() : null }
  });
  dialog(existing ? gt('goal_form.edit_title') : gt('goal_form.new_title'), body, [h('button', { class: 'primary', onclick: async () => {
    const ok = existing ? await act(() => api('updateGoal', { goal: existing.id, patch: collect() }), gt('goal_form.updated')) : await act(() => api('createGoal', { project, goal: collect() }), gt('goal_form.started'));
    if (ok) closeDialog();
  } }, existing ? gt('common.save') : gt('goal_form.start_btn'))]);
}

function textPrompt(title, label, onOk, { area = true, okLabel = gt('common.add'), hint, value = '' } = {}) {
  const input = area ? h('textarea', {}) : h('input', { type: 'text' });
  input.value = value;
  dialog(title, h('div', {}, field(label, input, hint)), [h('button', { class: 'primary', onclick: async () => { if (await onOk(input.value)) closeDialog(); } }, okLabel)]);
  input.focus();
}

async function addFolder(project) {
  toast(gt('folder.picking'));
  const picked = await act(() => api('pickFolder'));
  if (picked && picked.path) return act(() => api('addRoot', { project, path: picked.path }), gt('folder.registered'));
  textPrompt(gt('folder.register_title'), gt('folder.path_label'), v => act(() => api('addRoot', { project, path: v }), gt('folder.registered')), { area: false, okLabel: gt('common.register') });
}

// ---- project archive / delete ----
// The server re-checks every condition; can_delete / can_archive only drive the buttons.
function deleteProjectDialog(p) {
  textPrompt(gt('project.delete_title', p.name), gt('project.delete_label'), v => act(() => api('deleteProject', { project: p.id, confirm: v }), gt('project.deleted')),
    { area: false, okLabel: gt('project.delete_btn'), hint: gt('project.delete_hint') });
}
function humanWaitsText(p) {
  const waits = p.human_waits || [];
  if (!waits.length) return '';
  const items = waits.map(w => {
    if (w.kind === 'merge') return gt('home.wait_merge', w.task);
    if (w.kind === 'decision') return gt('home.wait_decision', w.decision);
    if (w.kind === 'done_candidate') return gt('home.wait_done_candidate', w.goal);
    return w.kind;
  });
  return gt('home.human_waits', items.join(S.settings?.effective_ui_language === 'ja' ? '、' : ', '));
}

function archiveBlockers(p) {
  const b = p.archive_blockers || {}; const why = [];
  if (b.held_tasks) why.push(gt('project.blocker_held', b.held_tasks));
  if (b.pending_decisions) why.push(gt('project.blocker_decisions', b.pending_decisions));
  return why.join(' / ') || gt('project.cannot_archive');
}
function projectMenuButtons(p) {
  return [
    h('button', { disabled: p.can_archive === false, title: p.can_archive === false ? archiveBlockers(p) : gt('project.archive_tip'),
      onclick: () => dialog(gt('project.archive_title', p.name), h('div', {}, h('p', {}, gt('project.archive_desc'))),
        [h('button', { class: 'primary', onclick: async () => { if (await act(() => api('setProjectArchived', { project: p.id, archived: true }), gt('project.archived_toast'))) closeDialog(); } }, gt('project.archive_confirm'))]) }, gt('project.archive_btn')),
    h('button', { disabled: p.can_delete === false, title: p.can_delete === false ? gt('project.delete_disabled') : gt('project.delete_enabled'), onclick: () => deleteProjectDialog(p) }, gt('project.delete_menu')),
    h('button', { title: gt('project.rename_tip'), onclick: () => textPrompt(gt('project.rename_title', p.name), gt('project.rename_label'), v => act(() => api('renameProject', { project: p.id, name: v }), gt('project.renamed')), { area: false, okLabel: gt('common.change'), value: p.name }) }, gt('project.rename_menu'))
  ];
}
function archivedCard(p) {
  return h('div', { class: 'card archived' },
    h('div', { class: 'row spread' },
      h('h2', {}, p.name, ' ', badge(gt('project.archived_badge'), 'warn')),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => act(() => api('setProjectArchived', { project: p.id, archived: false }), gt('project.unarchived')) }, gt('project.unarchive_btn')),
        h('button', { disabled: p.can_delete === false, title: p.can_delete === false ? gt('project.delete_disabled') : '', onclick: () => deleteProjectDialog(p) }, gt('project.delete_menu')))),
    h('div', { class: 'small muted' }, gt('project.archived_meta', p.archived_at ? fmt(p.archived_at) : '-', p.roots.length ? p.roots.map(r => r.path_display).join(' / ') : gt('project.none_word'))),
    h('div', { class: 'list' }, p.goals.length ? p.goals.map(g => h('div', {}, h('button', { class: 'link', onclick: () => { openGoal = g.id; goalData = null; render(); loadGoal(); } }, `${g.id}  ${g.title}`), ' ', badge(gt('goal_status.' + g.status), GOAL_STATUS_CLS[g.status]))) : h('div', { class: 'muted' }, gt('project.no_goals'))));
}

// ---- home ----
function viewHome() {
  const out = [];
  const nArch = S.projects.filter(p => p.archived).length;
  if (nArch) out.push(h('label', { class: 'check small muted' }, h('input', { type: 'checkbox', checked: showArchived, onchange: e => { showArchived = e.target.checked; render(); } }), gt('home.show_archived', nArch)));
  if (!S.projects.length) out.push(h('div', { class: 'card' }, h('h2', {}, gt('home.welcome_title')), h('p', {}, gt('home.welcome_body'))));
  for (const p of visibleProjects()) {
    if (p.archived) { out.push(archivedCard(p)); continue; }
    out.push(h('div', { class: 'card' },
      h('div', { class: 'row spread' },
        h('h2', {}, p.name, ' ', p.stopped ? badge(gt('home.stopped_badge'), 'bad') : null),
        h('div', { class: 'row' },
          p.stopped ? h('button', { class: 'primary', onclick: () => act(() => api('setProjectStop', { project: p.id, stopped: false }), gt('home.resumed')) }, gt('home.resume_btn'))
            : h('button', { class: 'stop', onclick: () => act(() => api('setProjectStop', { project: p.id, stopped: true }), gt('home.stopped_toast')) }, gt('home.stop_btn')),
          h('button', { onclick: () => goalForm(p.id) }, gt('home.new_goal_btn')),
          projectMenuButtons(p))),
      p.stopped ? h('div', { class: 'hint small' }, gt('home.stopped_hint')) : null,
      h('div', { class: 'small muted' }, gt('home.folders_label'), p.roots.length ? p.roots.map(r => r.path_display).join(' / ') : gt('home.unregistered'), ' ', h('button', { class: 'link', onclick: () => addFolder(p.id) }, gt('home.pick_folder')), '  ', h('button', { class: 'link', onclick: () => textPrompt(gt('folder.register_title'), gt('folder.path_example'), v => act(() => api('addRoot', { project: p.id, path: v }), gt('folder.registered')), { area: false, okLabel: gt('common.register') }) }, gt('home.type_folder'))),
      h('div', { class: 'row small' }, gt('home.participants_label'), p.participants.filter(x => !x.revoked).length ? p.participants.filter(x => !x.revoked).map(x => badge(`${x.label}: ${gt('p_state.' + x.state)}`, P_STATE_CLS[x.state])) : h('span', { class: 'muted' }, gt('home.no_participants'))),
      p.participants.some(x => x.state === 'needs_resume') ? h('div', { class: 'hint small' }, gt('home.needs_resume_hint')) : null,
      p.human_waits?.length ? h('div', { class: 'hint small' }, humanWaitsText(p)) : null,
      h('div', { class: 'list' }, p.goals.length ? p.goals.map(g => h('div', {},
        h('div', { class: 'row spread' },
          h('button', { class: 'link', onclick: () => { openGoal = g.id; goalData = null; render(); loadGoal(); } }, h('strong', {}, `${g.id}  ${g.title}`)),
          badge(gt('goal_status.' + g.status), GOAL_STATUS_CLS[g.status]), g.author_kind === 'ai' ? badge(gt('task.author_ai', g.author), 'warn') : null),
        h('div', { class: 'small muted' }, gt('home.goal_stats', g.assignments_used, g.budgets.max_assignments, g.counts.accepted || 0, g.counts.claimed || 0, g.counts.open || 0, g.counts.needs_check || 0, g.summary ? g.summary.slice(0, 90) : '')))) : h('div', { class: 'muted' }, gt('home.no_goals_yet')))));
  }
  out.push(h('button', { onclick: () => textPrompt(gt('home.create_project_title'), gt('home.create_project_label'), v => act(() => api('createProject', { name: v }), gt('home.created')), { area: false, okLabel: gt('common.create') }) }, gt('home.create_project_btn')));
  return out;
}

// ---- goal detail with branch timeline ----
async function loadGoal() { if (!openGoal) return; try { goalData = await api('goalDetail', { goal: openGoal }); if (openGoal) render(); } catch (e) { toast(e.message); } }

async function showTask(id) {
  let d; try { d = await api('taskDetail', { task: id }); } catch (e) { return toast(e.message); }
  const t = d.task;
  const ai = t.author_kind === 'ai';
  dialog(`${t.id}  ${gt('task_state.' + t.state)}`, h('div', {},
    h('div', { class: 'kv' },
      h('div', {}, gt('task.kind_role')), h('div', {}, `${t.kind} / ${t.role} / ${t.mode === 'writes' ? gt('task.writes') : gt('task.readonly')}`),
      h('div', {}, gt('task.assignee')), h('div', {}, t.assignee || '—', gt('task.gen_attempts', t.gen, t.attempts)),
      h('div', {}, gt('task.author')), h('div', {}, ai ? gt('task.author_ai', t.author) : t.author_kind === 'human' ? gt('task.author_human') : gt('task.author_system')),
      t.flag ? [h('div', {}, gt('task.flag')), h('div', {}, t.flag === 'recheck' ? gt('task.flag_recheck') : gt('task.flag_excluded'))] : null),
    h('h3', {}, gt('task.title')), h('pre', {}, t.title), h('h3', {}, gt('task.body')), md(t.body || gt('common.none')),
    t.handoff ? [h('h3', {}, gt('task.handoff')), md(t.handoff)] : null,
    h('h3', {}, gt('task.reports')),
    d.reports.length ? d.reports.map(r => h('div', {}, h('div', { class: 'small muted' }, `${fmt(r.created_at)}  ${r.participant}  ${r.kind}`, r.stale ? gt('task.report_stale') : ''), md(r.body || gt('task.no_body')))) : h('div', { class: 'muted' }, gt('common.not_yet')),
    d.evidence.length ? [h('h3', {}, gt('task.evidence')), d.evidence.map(e => h('div', { class: 'small' }, badge(gt('ev.' + e.kind) || e.kind), ' ', e.text, e.source ? gt('task.ev_source', e.source) : ''))] : null,
    d.worktree ? [
      h('h3', {}, gt('task.worktree')),
      h('div', { class: 'kv small' },
        h('div', {}, gt('task.branch')), h('div', {}, d.worktree.branch, gt('task.wt_state', d.worktree.state)),
        h('div', {}, gt('task.base_commit')), h('div', {}, d.worktree.base_commit?.slice(0, 10) || '—'),
        h('div', {}, gt('task.commits')), h('div', {}, gt('task.commits_count', d.worktree.commit_count)),
        d.worktree.uncommitted_count ? [h('div', {}, gt('task.uncommitted')), h('div', { class: 'bad' }, gt('task.uncommitted_count', d.worktree.uncommitted_count))] : null,
        d.worktree.diff_stat ? [h('div', {}, gt('task.diff_stat')), h('pre', {}, d.worktree.diff_stat)] : null,
        d.worktree.last_error ? [h('div', {}, gt('task.wt_error')), h('div', { class: 'bad' }, d.worktree.last_error)] : null),
      d.worktree.state === 'active' ? h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => {
          dialog(gt('task.merge_title'),
            h('div', {},
              h('p', {}, gt('task.merge_confirm', d.worktree.branch)),
              d.worktree.diff_stat ? h('pre', {}, d.worktree.diff_stat) : null),
            [h('button', { class: 'primary', onclick: async () => {
              const r = await act(() => api('mergeTaskWorktree', { task: t.id }), gt('task.merged_toast'));
              if (r?.warning) toast(r.warning);
              if (r) {
                closeDialog();
                if (openGoal) loadGoal();
              }
            } }, gt('task.merge_do'))]);
        } }, gt('task.merge_btn')),
        h('button', { class: 'stop', onclick: () => {
          dialog(gt('task.discard_title'),
            h('div', {},
              h('p', {}, gt('task.discard_confirm', d.worktree.branch))),
            [h('button', { class: 'stop', onclick: async () => {
              const r = await act(() => api('discardTaskWorktree', { task: t.id }), gt('task.discarded_toast'));
              if (r?.warning) toast(r.warning);
              if (r) {
                closeDialog();
                if (openGoal) loadGoal();
              }
            } }, gt('task.discard_do'))]);
        } }, gt('task.discard_btn'))) : null
    ] : null,
    h('h3', {}, gt('task.events')), h('pre', {}, d.events.map(e => `${fmt(e.ts)}  ${e.type}${e.participant ? '  ' + e.participant : ''}`).join('\n') || gt('common.none'))),
  t.state === 'needs_check' ? needsCheckButtons(t.id) : []);
}

const needsCheckButtons = id => [
  h('button', { onclick: async () => { if (await act(() => api('resolveNeedsCheck', { task: id, action: 'wait' }), gt('nc.wait_toast'))) closeDialog(); } }, gt('nc.wait_btn')),
  h('button', { onclick: async () => { if (await act(() => api('resolveNeedsCheck', { task: id, action: 'reopen' }), gt('nc.reopen_toast'))) closeDialog(); } }, gt('nc.reopen_btn')),
  h('button', { onclick: async () => { if (await act(() => api('resolveNeedsCheck', { task: id, action: 'cancel' }), gt('nc.cancel_toast'))) closeDialog(); } }, gt('nc.cancel_btn'))];

function viewGoal() {
  if (!goalData || goalData.goal.id !== openGoal) return [h('p', { class: 'muted' }, gt('common.loading'))];
  const d = goalData, g = d.goal;
  const full = S.projects.flatMap(p => p.goals).find(x => x.id === g.id);
  const lanes = [{ id: null, label: gt('goal_view.main_lane'), state: 'active' }, ...d.branches.map(b => ({ id: b.id, label: `${b.id}: ${b.hypothesis}`, state: b.state, b }))];
  const grid = h('div', { class: 'timeline' });
  grid.style.gridTemplateColumns = `repeat(${lanes.length}, minmax(200px, 1fr))`;
  lanes.forEach((l, i) => { const head = h('div', { class: `lane-head ${l.state !== 'active' ? 'closed' : ''}`, title: l.label }, l.label.slice(0, 40), l.b ? h('div', { class: 'small muted' }, gt('branch.' + l.state), l.b.reason ? `: ${l.b.reason.slice(0, 60)}` : '') : null); head.style.gridColumn = i + 1; head.style.gridRow = 1; grid.append(head); });
  d.tasks.forEach((t, row) => {
    const col = Math.max(0, lanes.findIndex(l => l.id === t.branch_id));
    const n = h('button', { class: `node ${t.state} ${t.kind}`, onclick: () => showTask(t.id) },
      h('div', { class: 'small muted' }, `${t.id}  ${t.kind === 'facilitator' ? gt('goal_view.kind_fac') : t.kind === 'review' ? gt('goal_view.kind_rev') : t.role}  `, badge(gt('task_state.' + t.state), t.state === 'accepted' ? 'ok' : ['needs_check', 'parked'].includes(t.state) ? 'warn' : '')),
      h('div', {}, t.title.slice(0, 70)), t.assignee ? h('div', { class: 'small muted' }, gt('goal_view.assignee', t.assignee)) : null);
    n.style.gridColumn = col + 1; n.style.gridRow = row + 2;
    grid.append(n);
  });
  return [
    h('div', { class: 'row' }, h('button', { onclick: () => { openGoal = null; render(); } }, gt('goal_view.back'))),
    h('div', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', {}, `${g.id}  ${g.title}  `, badge(gt('goal_status.' + g.status), GOAL_STATUS_CLS[g.status]), g.author_kind === 'ai' ? badge(gt('task.author_ai', g.author), 'warn') : null),
        h('div', { class: 'row' },
          g.status === 'proposed' ? [h('button', { class: 'primary', onclick: () => act(() => api('approveProposedGoal', { goal: g.id }), gt('goal_view.approved_toast')) }, gt('goal_view.approve_btn')), h('button', { onclick: async () => { if (await act(() => api('rejectProposedGoal', { goal: g.id }), gt('goal_view.rejected_toast'))) { openGoal = null; goalData = null; render(); } } }, gt('goal_view.reject_btn'))] : null,
          g.status === 'active' ? h('button', { onclick: () => act(() => api('setGoalStatus', { goal: g.id, status: 'paused' }), gt('goal_view.paused_toast')) }, gt('goal_view.pause_btn')) : null,
          ['paused', 'stopped'].includes(g.status) ? h('button', { class: 'primary', onclick: () => act(() => api('setGoalStatus', { goal: g.id, status: 'active' }), gt('goal_view.resumed_toast')) }, gt('goal_view.resume_btn')) : null,
          !['stopped', 'done'].includes(g.status) ? h('button', { onclick: () => act(() => api('setGoalStatus', { goal: g.id, status: 'stopped' }), gt('goal_view.stopped_toast')) }, gt('goal_view.stop_btn')) : null,
          full && g.status !== 'done' ? h('button', { onclick: () => goalForm(g.project_id, full) }, gt('goal_view.edit_btn')) : null,
          h('button', { onclick: () => textPrompt(gt('goal_view.note_title'), gt('goal_view.note_label'), v => act(() => api('addHumanNote', { goal: g.id, text: v }), gt('goal_view.note_added')), { hint: gt('goal_view.note_hint') }) }, gt('goal_view.note_title')),
          h('button', { onclick: () => addTaskDialog(g.id) }, gt('goal_view.add_task_btn')),
          h('button', { onclick: async () => { const r = await act(() => api('exportGoal', { goal: g.id })); if (r) dialog(gt('goal_view.export_title'), h('div', {}, h('div', { class: 'small muted' }, gt('goal_view.saved_at', r.file)), h('pre', {}, r.text)), [h('button', { onclick: () => copy(r.text) }, gt('common.copy'))]); } }, gt('goal_view.export_btn')))),
      h('div', { class: 'kv' }, h('div', {}, gt('goal_view.done_evidence')), h('div', {}, g.done_evidence || gt('goal_view.not_filled')), h('div', {}, gt('goal_view.summary')), h('div', {}, g.summary || gt('goal_view.no_summary')), h('div', {}, gt('goal_view.next_step')), h('div', {}, g.next_step || '—'))),
    h('div', { class: 'card' }, h('h2', {}, gt('goal_view.timeline')), h('div', { class: 'small muted' }, gt('goal_view.timeline_hint')), d.tasks.length ? grid : h('div', { class: 'muted' }, gt('goal_view.no_tasks'))),
    h('div', { class: 'card' }, h('h2', {}, gt('goal_view.evidence')), h('div', { class: 'list' }, d.evidence.length ? d.evidence.map(e => h('div', {}, badge(gt('ev.' + e.kind) || e.kind, e.kind === 'fact' ? 'ok' : e.kind === 'rejection' ? 'bad' : ''), e.excluded ? badge(gt('goal_view.excluded_badge'), 'warn') : null, ' ', e.text, h('div', { class: 'small muted' }, `${e.id}  ${e.by_participant || ''}  ${e.branch_id || ''}  ${e.task_id || ''}`, e.source ? gt('goal_view.ev_source', e.source) : ''))) : h('div', { class: 'muted' }, gt('common.not_yet')))),
    h('div', { class: 'card' }, h('h2', {}, gt('goal_view.decisions')), h('div', { class: 'list' }, d.decisions.length ? d.decisions.map(x => h('div', {}, badge(gt('decision.' + x.kind) || x.kind), ' ', x.state === 'pending' ? badge(gt('goal_view.pending_badge'), 'warn') : badge(gt('goal_view.answered_badge'), 'ok'), md(x.question), x.answer ? h('div', { class: 'small' }, gt('goal_view.answer_line', answerLabel(x.answer), x.note)) : null)) : h('div', { class: 'muted' }, gt('common.not_yet')))),
    h('div', { class: 'card' }, h('h2', {}, gt('goal_view.events')), h('pre', {}, d.events.map(e => `${fmt(e.ts)}  ${e.type}${e.task_id ? '  ' + e.task_id : ''}${e.branch_id ? '  ' + e.branch_id : ''}${e.participant ? '  ' + e.participant : ''}`).join('\n') || gt('common.none')))
  ];
}

function addTaskDialog(goal) {
  const title = h('input', { type: 'text' }), body = h('textarea', {});
  const role = h('select', {}, ['research', 'design', 'implement', 'review'].map(r => h('option', { value: r }, r)));
  const mode = h('select', {}, h('option', { value: 'read_only' }, gt('task.readonly')), h('option', { value: 'writes' }, gt('task.writes')));
  const prefer = h('input', { type: 'text' });
  dialog(gt('add_task.title'), h('div', {}, field(gt('add_task.title_label'), title), field(gt('add_task.body_label'), body), h('div', { class: 'grid2' }, h('div', {}, field(gt('add_task.role_label'), role)), h('div', {}, field(gt('add_task.mode_label'), mode))), field(gt('add_task.prefer_label'), prefer, gt('add_task.prefer_hint'))),
    [h('button', { class: 'primary', onclick: async () => { if (await act(() => api('addHumanTask', { goal, task: { title: title.value, body: body.value, role: role.value, mode: mode.value, prefer: prefer.value || null } }), gt('add_task.added'))) { closeDialog(); loadGoal(); } } }, gt('common.add'))]);
}

// ---- connect ----
function hostDialog(hst) {
  dialog(gt('host.title', hst.name), h('div', {},
    h('div', { class: 'hint small' }, hst.note),
    h('div', { class: 'kv' }, h('div', {}, gt('host.config_file')), h('div', {}, hst.file)),
    h('h3', {}, gt('host.current')), h('pre', {}, hst.current),
    h('h3', {}, gt('host.desired')), h('pre', {}, hst.desired),
    h('div', { class: 'small muted' }, gt('host.backup_hint'))),
  [hst.registered ? h('button', { onclick: async () => { if (await act(() => api('hostUnregister', { key: hst.key }), gt('host.unregistered'))) closeDialog(); } }, gt('host.unregister_btn')) : null,
    h('button', { class: 'primary', onclick: async () => { if (await act(() => api('hostRegister', { key: hst.key }), gt('host.registered_toast'))) closeDialog(); } }, hst.registered ? gt('host.update_btn') : gt('host.register_btn'))]);
}

function quotaDialog(client, q) {
  const state = h('select', {}, [['unknown', gt('quota.opt_unknown')], ['ok', gt('quota.opt_ok')], ['low', gt('quota.opt_low')], ['limit', gt('quota.opt_limit')]].map(([v, l]) => h('option', { value: v }, l)));
  const pct = h('input', { type: 'number', min: 0, max: 100 }), reset = h('input', { type: 'datetime-local' }), detail = h('input', { type: 'text', value: '' });
  dialog(gt('quota.title', client), h('div', {},
    h('div', { class: 'hint small' }, gt('quota.hint')),
    h('div', { class: 'small muted' }, gt('quota.current', gt('quota.' + q.state), q.detail, q.reported_at ? ago(q.reported_at) : '', q.source === 'human' ? gt('quota.src_human') : q.source === 'adapter' ? gt('quota.src_adapter') : gt('quota.src_ai'))),
    field(gt('quota.state_label'), state), field(gt('quota.pct_label'), pct), field(gt('quota.reset_label'), reset, gt('quota.reset_hint')), field(gt('quota.detail_label'), detail)),
  [h('button', { class: 'primary', onclick: async () => { if (await act(() => api('setQuota', { client, quota: { state: state.value, used_percent: pct.value === '' ? null : Number(pct.value), reset_at: reset.value ? new Date(reset.value).getTime() : null, detail: detail.value } }), gt('goal_form.updated'))) closeDialog(); } }, gt('common.save'))]);
}

function viewConnect() {
  const out = [];
  const langs = S.settings || { ui_language: 'auto', ai_language: 'en' };
  const uiSel = h('select', { 'aria-label': gt('lang.ui_label') },
    h('option', { value: 'auto' }, gt('lang.auto')),
    h('option', { value: 'en' }, 'English'),
    h('option', { value: 'ja' }, '日本語'));
  uiSel.value = langs.ui_language || 'auto';
  const aiSel = h('select', { 'aria-label': gt('lang.ai_label') },
    h('option', { value: 'en' }, gt('lang.en_default')),
    h('option', { value: 'ja' }, '日本語'),
    h('option', { value: 'ui' }, gt('lang.same_as_ui')));
  aiSel.value = langs.ai_language || 'en';
  out.push(h('div', { class: 'card' }, h('h2', {}, gt('lang.title')),
    h('div', { class: 'grid2' }, field(gt('lang.ui_label'), uiSel), field(gt('lang.ai_label'), aiSel)),
    h('button', { class: 'primary', onclick: () => act(() => api('setLanguages', { ui_language: uiSel.value, ai_language: aiSel.value }), gt('lang.saved')) }, gt('lang.save_btn'))));

  out.push(h('div', { class: 'card' }, h('h2', {}, gt('connect.step1_title')),
    h('div', { class: 'hint small' }, gt('connect.step1_hint')),
    h('table', {}, h('tr', {}, h('th', {}, gt('connect.col_app')), h('th', {}, gt('connect.col_detected')), h('th', {}, gt('connect.col_status')), h('th', {}, '')),
      S.hosts.map(x => h('tr', {}, h('td', {}, x.name, x.error ? h('div', { class: 'small', }, badge(x.error, 'bad')) : null), h('td', {}, x.detected ? badge(gt('connect.detected_yes'), 'ok') : badge(gt('connect.detected_no'))),
        h('td', {}, x.registered ? (x.up_to_date ? badge(gt('connect.reg_ok'), 'ok') : badge(gt('connect.reg_outdated'), 'warn')) : badge(gt('connect.reg_none'))),
        h('td', {}, h('button', { disabled: !x.detected || !!x.error, onclick: () => hostDialog(x) }, gt('connect.inspect_btn')))))),
    h('div', { class: 'small muted' }, gt('connect.other_apps'))));

  const roots = S.projects.flatMap(p => p.roots.map(r => ({ p, r })));
  const sel = h('select', {}, roots.length ? roots.map(({ p, r }) => h('option', { value: r.path_display }, `${p.name}: ${r.path_display}`)) : h('option', { value: '' }, gt('connect.no_roots')));
  const once = h('pre', {}), un = h('pre', {});
  const fill = async () => { try { const ph = await api('startPhrase', { root: sel.value }); once.textContent = ph.once; un.textContent = ph.unattended; } catch { /* shown on next refresh */ } };
  sel.addEventListener('change', fill); fill();
  out.push(h('div', { class: 'card' }, h('h2', {}, gt('connect.step2_title')),
    h('div', { class: 'small muted' }, gt('connect.step2_hint')),
    field(gt('connect.folder_label'), sel),
    h('h3', {}, gt('connect.once_title')), once, h('button', { onclick: () => copy(once.textContent) }, gt('common.copy')),
    h('h3', {}, gt('connect.unattended_title')), un, h('button', { onclick: () => copy(un.textContent) }, gt('common.copy')),
    h('div', { class: 'hint small' }, gt('connect.resume_hint'))));

  if (S.root_requests.length) {
    out.push(h('div', { class: 'card' }, h('h2', {}, gt('connect.pending_roots_title')), h('div', { class: 'small muted' }, gt('connect.pending_roots_hint')),
      h('div', { class: 'list' }, S.root_requests.map(r => {
        const pick = h('select', {}, activeProjects().map(p => h('option', { value: p.id }, p.name)));
        return h('div', { class: 'row' }, h('span', {}, r.path_display), badge(r.client || ''), h('span', { class: 'muted small' }, ago(r.last_at)), activeProjects().length ? pick : null,
          activeProjects().length ? h('button', { class: 'primary', onclick: () => act(() => api('addRoot', { project: pick.value, path: r.path_display }), gt('connect.root_registered')) }, gt('common.register')) : h('span', { class: 'muted small' }, gt('connect.need_project_first')),
          h('button', { onclick: () => act(() => api('dismissRootRequest', { path_norm: r.path_norm })) }, gt('connect.ignore_btn')));
      }))));
  }

  out.push(h('div', { class: 'card' }, h('h2', {}, gt('clients.title')),
    h('div', { class: 'small muted' }, gt('clients.legend')),
    S.clients.length ? h('table', {}, h('tr', {}, h('th', {}, gt('clients.col_app')), h('th', {}, gt('clients.col_level')), h('th', {}, gt('clients.col_hold')), h('th', {}, gt('clients.col_quota')), h('th', {}, '')),
      S.clients.map(c => h('tr', {}, h('td', {}, `${c.client} ${c.client_version}`), h('td', {}, badge(gt('client.level_' + (c.level || 'none')), c.level === 'L2' || c.level === 'L3' ? 'ok' : '')),
        h('td', { class: 'small' }, gt('clients.hold_stats', Math.round(c.hold_ok_ms / 1000), c.hold_fail_ms ? Math.round(c.hold_fail_ms / 1000) : 0, c.unattended_cycles, c.cycles, c.wait_resumes), h('div', { class: 'muted' }, gt('clients.hold_sub', c.unattended_cycles, c.cycles, c.wait_resumes))),
        h('td', {}, badge(gt('quota.' + c.quota.state), c.quota.state === 'limit_reported' ? 'bad' : ''), c.quota.blocked_until ? h('div', { class: 'small muted' }, gt('clients.blocked_until', fmt(c.quota.blocked_until))) : null),
        h('td', {}, h('button', { onclick: () => quotaDialog(c.client, c.quota) }, gt('clients.set_quota_btn')))))) : h('div', { class: 'muted' }, gt('clients.none'))));

  out.push(usageWindowsPanel());
  for (const p of activeProjects()) {
    const a = p.adapters || {};
    const boxes = Object.entries(S.adapters.available).map(([k, name]) => {
      const en = h('input', { type: 'checkbox', checked: a[k] && a[k].enabled });
      const acc = h('select', {}, h('option', { value: 'read' }, gt('proj.access_read')), h('option', { value: 'write' }, gt('proj.access_write')));
      acc.value = a[k] && a[k].access === 'write' ? 'write' : 'read';
      const model = h('input', { type: 'text', placeholder: gt('proj.model_ph'), value: (a[k] && a[k].model) || '' });
      return { k, en, acc, model, row: h('div', { class: 'row' }, h('label', { class: 'check' }, en, name), acc, h('div', {}, model)) };
    });
    const perHour = h('input', { type: 'number', min: 1, max: 12, value: a.max_per_hour || 3 });
    out.push(h('div', { class: 'card' }, h('h2', {}, gt('proj.participants_title', p.name)),
      h('div', { class: 'small muted' }, gt('proj.participants_hint')),
      h('div', { class: 'list' }, p.participants.length ? p.participants.map(x => h('div', { class: 'row spread' },
        h('div', {}, h('strong', {}, `${x.id}  ${x.label}`), ' ', badge(gt('p_state.' + x.state), P_STATE_CLS[x.state]), h('span', { class: 'small muted' }, gt('proj.p_meta', x.client, x.client_version, ago(x.last_seen), x.waiting_since ? ago(x.waiting_since) : '', Math.round(x.hold_ms / 1000), x.tasks.length ? x.tasks.map(t => t.id).join(', ') : ''))),
        usageSummary(x),
        h('div', { class: 'row' }, h('button', { onclick: () => profileDialog(p, x) }, gt('proj.tier_limits_btn')), x.revoked ? h('button', { onclick: () => act(() => api('revokeParticipant', { participant: x.id, revoked: false }), gt('proj.allowed_toast')) }, gt('proj.allow_btn')) : h('button', { onclick: () => act(() => api('revokeParticipant', { participant: x.id }), gt('proj.revoked_toast')) }, gt('proj.revoke_btn')), !x.tasks.length ? h('button', { onclick: () => act(() => api('removeParticipant', { participant: x.id }), gt('proj.removed_toast')) }, gt('proj.remove_btn')) : null, !p.blocked_clients.includes(x.client) ? h('button', { onclick: () => act(() => api('setClientJoinBlocked', { project: p.id, client: x.client }), gt('proj.blocked_client_toast')) }, gt('proj.block_client_btn')) : null))) : h('div', { class: 'muted' }, gt('proj.no_participants'))),
      h('div', { class: 'small muted' }, gt('proj.usage_hint')),
      tierPolicyControls(p),
      p.blocked_clients.map(client => h('div', { class: 'row small' }, gt('proj.client_blocked_row', client), h('button', { onclick: () => act(() => api('setClientJoinBlocked', { project: p.id, client, blocked: false }), gt('proj.unblock_toast')) }, gt('proj.unblock_btn')))),
      h('h3', {}, gt('proj.adapters_title')),
      h('div', { class: 'hint small' }, gt('proj.adapters_hint')),
      boxes.map(b => b.row), h('div', { class: 'row' }, h('span', {}, gt('proj.max_per_hour')), h('div', {}, perHour)),
      S.adapters.running.filter(r => r.project === p.id).map(r => h('div', { class: 'small' }, badge(r.adapter, 'ok'), ' ', gt('proj.adapter_running', r.adapter, ago(r.started)))),
      h('button', { onclick: () => act(() => api('setAdapters', { project: p.id, adapters: { ...Object.fromEntries(boxes.map(b => [b.k, { enabled: b.en.checked, access: b.acc.value, model: b.model.value }])), max_per_hour: Number(perHour.value) } }), gt('proj.adapters_saved')) }, gt('proj.adapters_save_btn'))));
  }
  return out;
}

const TIER_KEYS = ['planner', 'senior', 'worker'];
const USAGE_LIMIT_KEYS = ['limit_5h_claims', 'limit_5h_minutes', 'limit_7d_claims', 'limit_7d_minutes'];

function profileDialog(project, participant) {
  const tier = h('select', { 'aria-label': gt('tier.dialog_aria') }, h('option', { value: '' }, gt('tier.unset')), TIER_KEYS.map(key => h('option', { value: key }, gt('tier.' + key))));
  tier.value = participant.tier || '';
  const service = h('input', { type: 'text', value: participant.usage_service_override || '', placeholder: participant.usage_service || gt('usage.auto') });
  const limits = Object.fromEntries(USAGE_LIMIT_KEYS.map(key => [key, h('input', { type: 'number', min: 1, max: 10000, step: 1, placeholder: gt('tier.no_limit'), 'aria-label': gt('tier.' + key), value: participant.usage?.limits[key] ?? '' })]));
  dialog(gt('tier.dialog_title', participant.label), h('div', {},
    h('p', { class: 'small muted' }, gt('tier.dialog_hint1')),
    field(gt('tier.field'), tier), field(gt('usage.service_mapping'), service), h('div', { class: 'grid2' }, USAGE_LIMIT_KEYS.map(key => h('div', {}, field(gt('tier.' + key), limits[key])))),
    h('p', { class: 'small muted' }, gt('tier.dialog_hint2'))),
    [h('button', { class: 'primary', onclick: async () => {
      const values = Object.fromEntries(Object.entries(limits).map(([key, input]) => [key, input.value === '' ? null : Number(input.value)]));
      if (await act(() => api('setProfile', { project: project.id, label: participant.label, profile: { tier: tier.value || null, usage_service: service.value.trim() || null, ...values } }), gt('tier.saved'))) closeDialog();
    } }, gt('tier.save_btn'))]);
}

function usageWindowsPanel() {
  const service = h('input', { type: 'text', placeholder: 'codex', 'aria-label': gt('usage.service') });
  const windowName = h('input', { type: 'text', placeholder: '5h', 'aria-label': gt('usage.window') });
  const reset = h('input', { type: 'datetime-local', 'aria-label': gt('usage.reset') });
  const percent = h('input', { type: 'number', min: 0, max: 100, step: 'any', 'aria-label': gt('usage.percent') });
  const period = h('input', { type: 'number', min: 1, step: 1, 'aria-label': gt('usage.period') });
  const deferPercent = h('input', { type: 'number', min: 1, max: 100, step: 'any', value: S.usage_policy?.defer_writes_percent ?? '', placeholder: gt('usage.defer_hint'), 'aria-label': gt('usage.defer_writes') });
  const rows = [...(S.usage_windows || [])].sort((a, b) => a.remaining_minutes - b.remaining_minutes);
  const labels = serviceName => S.projects.flatMap(p => p.participants.filter(x => x.usage_service === serviceName).map(x => `${p.name}: ${x.label}`)).join(', ');
  return h('div', { class: 'card' }, h('h2', {}, gt('usage.title')),
    h('button', { onclick: async () => { const result = await act(() => api('syncUsage')); if (result) toast(gt('usage.synced', result.saved, result.errors.length)); } }, gt('usage.sync')),
    rows.length ? h('div', { class: 'list' }, rows.map(r => h('div', { class: r.stale ? 'small muted' : 'small' },
      `${r.service} / ${r.window} — ${r.used_percent == null ? '—' : Math.round(r.used_percent) + '%'} — ${gt('usage.remaining', r.remaining_minutes)} — ${fmt(r.resets_at)} — ${r.source} — ${r.fetched_at ? fmt(r.fetched_at) : '—'}${r.stale ? ' (' + gt('usage.stale') + ')' : ''}`,
      labels(r.service) ? h('div', {}, labels(r.service)) : null))) : h('p', { class: 'muted' }, gt('usage.empty')),
    h('div', { class: 'grid2' }, field(gt('usage.defer_writes'), deferPercent)),
    h('button', { onclick: () => act(() => api('setUsagePolicy', { defer_writes_percent: deferPercent.value === '' ? null : Number(deferPercent.value) }), gt('usage.policy_saved')) }, gt('usage.save')),
    h('h3', {}, gt('usage.manual')), h('div', { class: 'grid2' }, field(gt('usage.service'), service), field(gt('usage.window'), windowName), field(gt('usage.reset'), reset), field(gt('usage.percent'), percent), field(gt('usage.period'), period)),
    h('button', { onclick: () => act(() => api('setUsageManual', { service: service.value, window: windowName.value, resets_at: reset.value ? new Date(reset.value).toISOString() : '', used_percent: percent.value === '' ? null : Number(percent.value), period_minutes: period.value === '' ? null : Number(period.value) }), gt('usage.saved')) }, gt('usage.save')));
}

function usageSummary(participant) {
  const u = participant.usage;
  if (!u) return null;
  const amount = (metric, unit) => {
    const left = u.remaining[metric];
    return `${u.used[metric]}${unit}${left == null ? gt('tier.unlimited') : gt('tier.remaining', left, unit)}`;
  };
  return h('div', { class: 'small usage-summary' }, badge(participant.tier ? gt('tier.' + participant.tier) : gt('tier.unset_badge')),
    h('div', {}, gt('tier.usage_5h', amount('claims_5h', gt('tier.unit_claims')), amount('minutes_5h', gt('tier.unit_min')))),
    h('div', {}, gt('tier.usage_7d', amount('claims_7d', gt('tier.unit_claims')), amount('minutes_7d', gt('tier.unit_min')))),
    u.blocked ? h('div', { class: 'usage-paused' }, gt('tier.paused_until', u.blocked.reason, fmt(u.blocked.until))) : null);
}

function tierPolicyControls(project) {
  const current = project.tier_policy?.downgrade_after_minutes;
  const mode = h('select', { 'aria-label': gt('tier.policy_cond') }, h('option', { value: 'none' }, gt('tier.policy_none')), h('option', { value: 'after' }, gt('tier.policy_after')));
  mode.value = current == null ? 'none' : 'after';
  const minutes = h('input', { type: 'number', min: 1, max: 1440, step: 1, value: current ?? 10, disabled: current == null, 'aria-label': gt('tier.policy_mins') });
  mode.addEventListener('change', () => { minutes.disabled = mode.value === 'none'; });
  return h('div', { class: 'tier-policy' }, h('h3', {}, gt('tier.policy_title')),
    h('div', { class: 'small muted' }, gt('tier.policy_hint')),
    h('div', { class: 'grid2' }, h('div', {}, field(gt('tier.policy_cond'), mode)), h('div', {}, field(gt('tier.policy_mins'), minutes))),
    h('button', { onclick: () => act(() => api('setTierPolicy', { project: project.id, policy: { downgrade_after_minutes: mode.value === 'none' ? null : Number(minutes.value) } }), gt('tier.policy_saved')) }, gt('tier.policy_save_btn')));
}

// ---- decisions ----
function viewDecisions() {
  const out = [];
  const tasks = S.projects.flatMap(p => p.needs_check.map(t => ({ p, t })));
  for (const { p, t } of tasks) out.push(h('div', { class: 'card' }, h('h2', {}, gt('decisions.nc_title', t.id, t.title)),
    h('div', {}, gt('decisions.nc_body', p.name, t.assignee, ago(t.updated_at))),
    h('div', { class: 'hint small' }, gt('decisions.nc_hint')),
    h('div', { class: 'row' }, needsCheckButtons(t.id))));
  for (const d of S.decisions) {
    const note = h('textarea', { placeholder: gt('decisions.note_ph') });
    const opts = d.options.length ? d.options : [];
    const free = d.kind === 'question';
    out.push(h('div', { class: 'card' }, h('h2', {}, `${gt('decision.' + d.kind) || d.kind}  ${d.id}`, d.goal_id ? `  (${d.goal_id}${d.task_id ? ' · ' + d.task_id : ''})` : ''),
      free ? h('div', { class: 'small muted' }, gt('decisions.ai_asked', d.asked_by)) : null,
      md(d.question), note,
      h('div', { class: 'row' }, opts.map(o => h('button', { class: 'primary', onclick: () => act(() => api('answerDecision', { decision: d.id, answer: o, note: note.value }), gt('decisions.answered_toast')) }, answerLabel(o))),
        free ? h('button', { onclick: () => { if (!note.value.trim()) return toast(gt('decisions.need_note_toast')); act(() => api('answerDecision', { decision: d.id, answer: note.value.trim(), note: '' }), gt('decisions.answered_toast')); } }, gt('decisions.answer_note_btn')) : null,
        free && d.task_id ? h('button', { onclick: () => act(() => api('answerDecision', { decision: d.id, answer: 'cancel_task', note: note.value }), gt('decisions.cancelled_toast')) }, gt('answer.cancel_task')) : null)));
  }
  if (!out.length) out.push(h('div', { class: 'card muted' }, gt('decisions.empty')));
  return out;
}

// ---- maintenance ----
let backups = null;
async function loadBackups() { try { backups = await api('listBackups'); if (tab === 'maintain') render(); } catch (e) { toast(e.message); } }
function viewMaintain() {
  const s = S.service;
  if (!backups) loadBackups();
  return [
    h('div', { class: 'card' }, h('h2', {}, gt('maintain.about_title')),
      h('div', { class: 'kv' }, h('div', {}, gt('maintain.version')), h('div', {}, gt('maintain.version_val', s.version, s.age_days)), h('div', {}, gt('maintain.home')), h('div', {}, s.home), h('div', {}, gt('maintain.network')), h('div', {}, gt('maintain.network_val'))),
      s.age_days > 180 ? h('div', { class: 'hint' }, gt('maintain.old_build')) : null,
      h('div', { class: 'small muted' }, gt('maintain.update_hint'))),
    h('div', { class: 'card' }, h('h2', {}, gt('maintain.backup_title')),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { const r = await act(() => api('backupNow'), gt('maintain.backup_toast')); if (r) loadBackups(); } }, gt('maintain.backup_btn')), h('span', { class: 'small muted' }, backups ? gt('maintain.backup_dir', backups.dir) : '')),
      h('div', { class: 'list' }, backups && backups.files.length ? backups.files.slice(0, 15).map(f => h('div', { class: 'row spread' }, h('span', {}, f.name, h('span', { class: 'small muted' }, `  ${fmt(f.at)}  ${Math.round(f.size / 1024)}KB`)),
        h('button', { onclick: () => dialog(gt('maintain.restore_title'), h('div', {}, h('p', {}, gt('maintain.restore_confirm', f.name))), [h('button', { class: 'primary', onclick: async () => { if (await act(() => api('restoreBackup', { name: f.name }), gt('maintain.restored_toast'))) { closeDialog(); loadBackups(); } } }, gt('maintain.restore_do'))]) }, gt('maintain.restore_btn')))) : h('div', { class: 'muted' }, gt('common.not_yet')))),
    h('div', { class: 'card' }, h('h2', {}, gt('maintain.diag_title')),
      h('div', { class: 'small muted' }, gt('maintain.diag_hint')),
      h('button', { onclick: async () => { const r = await act(() => api('diagnostics')); if (r) dialog(gt('maintain.diag_modal_title'), h('div', {}, h('div', { class: 'small muted' }, gt('goal_view.saved_at', r.file)), h('pre', {}, r.text)), [h('button', { onclick: () => copy(r.text) }, gt('common.copy'))]); } }, gt('maintain.diag_btn'))),
    h('div', { class: 'card' }, h('h2', {}, gt('maintain.arch_title')),
      h('div', { class: 'small muted' }, gt('maintain.arch_hint')),
      S.projects.map(p => h('div', { class: 'row' }, h('span', {}, p.name), p.archived ? badge(gt('project.archived_badge'), 'warn') : null,
        p.archived ? h('button', { onclick: () => act(() => api('setProjectArchived', { project: p.id, archived: false }), gt('project.unarchived')) }, gt('project.unarchive_btn')) : projectMenuButtons(p)[0],
        h('button', { disabled: p.can_delete === false, title: p.can_delete === false ? gt('project.delete_disabled') : '', onclick: () => deleteProjectDialog(p) }, gt('project.delete_menu'))))),
    h('div', { class: 'card' }, h('h2', {}, gt('maintain.stop_title')),
      h('div', { class: 'small muted' }, gt('maintain.stop_hint')),
      h('button', { onclick: () => act(() => api('shutdown'), gt('maintain.stopped_toast')) }, gt('maintain.stop_btn')))
  ];
}

// ---- render loop ----
function render() {
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = uiLang();
  renderTabs();
  if (!S) return;
  const banner = [];
  if (S.legacy_warnings?.length) {
    for (const w of S.legacy_warnings) {
      banner.push(h('div', { class: 'alert' }, badge(gt('banner.legacy_badge'), w.isMigrated ? '' : 'warn'), ' ', w.message));
    }
  }
  const resume = activeProjects().flatMap(p => p.participants.filter(x => x.state === 'needs_resume').map(x => x.label));
  if (activeProjects().some(p => p.stopped)) banner.push(h('div', { class: 'alert' }, gt('banner.stopped')));
  if (resume.length) banner.push(h('div', {}, gt('banner.resume', [...new Set(resume)].join(', '))));
  $('banner').replaceChildren(...banner);
  const view = openGoal ? viewGoal() : tab === 'home' ? viewHome() : tab === 'connect' ? viewConnect() : tab === 'decisions' ? viewDecisions() : viewMaintain();
  $('main').replaceChildren(...view.flat(9).filter(Boolean));
}

async function refresh(force) {
  try {
    const next = await api('state');
    const json = JSON.stringify({ ...next, now: 0 });
    $('conn').textContent = '';
    // Do not redraw under the user's cursor while they type in the page.
    const typing = $('main').contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (!force && (json === lastJson || typing)) { S = next; renderTabs(); return; }
    S = next; lastJson = json;
    render();
    if (openGoal) loadGoal();
  } catch (e) { $('conn').textContent = gt('common.conn_error', e.message); }
}

if (!token) {
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = uiLang();
  $('main').replaceChildren(h('div', { class: 'card' }, gt('common.no_token')));
} else { refresh(true); setInterval(() => refresh(false), 2500); }
