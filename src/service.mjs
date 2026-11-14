// The single local service: owns the database, answers the relays over a
// named pipe, serves the GUI on 127.0.0.1 only, and runs the timers.
// It makes no outbound connection of any kind.
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { APP_ROOT, VERSION, dataHome, ensureHome, pipePath, serviceFile, dbFile, detectLegacyDataHomes, isDataHomeMoved } from './paths.mjs';
import { openDb, backupTo, inspectBackup, stamp, SCHEMA_VERSION } from './db.mjs';
import { Core, Refusal } from './core.mjs';
import { callTool } from './tools.mjs';
import { hostStatus, hostChange } from './hosts.mjs';
import { AdapterManager, ADAPTERS } from './adapters.mjs';
import { isPidAlive } from './relay.mjs';
import { t, resolveUiLanguage } from './i18n/index.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const safeEqual = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function buildInfo() {
  let built = null;
  try { built = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'build.json'), 'utf8')).built_at; } catch { /* dev checkout */ }
  if (!built) built = fs.statSync(path.join(APP_ROOT, 'package.json')).mtime.toISOString();
  return { version: VERSION, built_at: built, age_days: Math.floor((Date.now() - Date.parse(built)) / 86400_000) };
}

function toast({ title, body }) {
  if (process.platform !== 'win32' || process.env.IDLESHIFT_NOTIFY === '0') return;
  const esc = v => String(v).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
  // Text travels base64-encoded so nothing in it is parsed by PowerShell.
  const b64 = Buffer.from(`<toast><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual></toast>`, 'utf8').toString('base64');
  const script = ['$ErrorActionPreference="Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null',
    `$x=New-Object Windows.Data.Xml.Dom.XmlDocument;$x.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))`,
    '$app="{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))'].join(';');
  try { spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' }).on('error', () => {}); } catch { /* best effort */ }
}

let pickerBusy = false;
function pickFolder(lang = resolveUiLanguage('auto')) {
  if (process.platform !== 'win32') throw new Refusal('unsupported', t(lang, 'service.picker_win_only'));
  // The service runs detached and hidden, so the dialog needs a real, visible,
  // top-most owner window or Windows opens it behind everything (invisible).
  if (pickerBusy) throw new Refusal('busy', t(lang, 'service.picker_busy'));
  const desc = t(lang, 'service.picker_desc').replace(/"/g, '');
  const script = 'Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.Application]::EnableVisualStyles();'
    + '$w=New-Object System.Windows.Forms.Form;$w.TopMost=$true;$w.ShowInTaskbar=$true;$w.Text="IdleShift";$w.StartPosition="CenterScreen";$w.Size=New-Object System.Drawing.Size(1,1);$w.Opacity=0;$w.Show();$w.Activate();'
    + `$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description="${desc}";$d.ShowNewFolderButton=$true;`
    + '$r=$d.ShowDialog($w);$w.Close();if($r -eq "OK"){[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Out.Write($d.SelectedPath)}';
  pickerBusy = true;
  return new Promise(resolve => {
    const c = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: false });
    let out = '';
    const done = v => { clearTimeout(t); pickerBusy = false; resolve(v); };
    c.stdout.on('data', d => { out += d.toString('utf8'); });
    const t = setTimeout(() => c.kill(), 300_000);
    c.on('close', () => done({ path: out.trim() || null }));
    c.on('error', () => done({ path: null }));
  });
}

export async function runService({ home = null, guiPort = 0, quiet = false, adaptersEnabled = true } = {}) {
  const bootLang = resolveUiLanguage('auto');
  const resolvedHome = home || dataHome();
  if (isDataHomeMoved(resolvedHome)) {
    throw new Error(t(bootLang, 'service.already_migrated'));
  }
  ensureHome(resolvedHome);
  home = resolvedHome;
  const logFile = path.join(home, 'logs', 'service.log');
  const log = msg => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, logFile + '.1'); fs.appendFileSync(logFile, line); } catch { /* logging must never stop the service */ }
    if (!quiet) process.stderr.write(line);
  };
  const token = crypto.randomBytes(32).toString('hex');
  const ctx = { core: null, db: null };
  const openConns = new Set();
  const sockets = new Set(); // closed on restore so nobody keeps talking about state that no longer exists (review #6)

  const open = () => {
    ctx.db = openDb(dbFile(home), { backupDir: path.join(home, 'backups') });
    ctx.core = new Core(ctx.db, { home });
    ctx.core.on('notify', toast);
    ctx.core.on('error_log', e => log(`error ${e?.stack || e}`));
    ctx.core.recover();
    ctx.core.cleanupWorktrees();
    for (const c of openConns) ctx.core.connOpened(c);
  };
  open();
  const adapters = new AdapterManager(ctx, { home, log });

  // ---- pipe: one line of JSON per message ----
  let connSeq = 0;
  const pipe = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    const conn = `C${++connSeq}-${crypto.randomBytes(3).toString('hex')}`;
    let authed = false;
    let serverNonce = null;
    const PRE_AUTH_MAX_LINE = 4096;
    const AUTH_MAX_LINE = 2_000_000;
    let lineBytes = 0;
    sock.on('data', chunk => {
      const limit = authed ? AUTH_MAX_LINE : PRE_AUTH_MAX_LINE;
      let start = 0;
      for (;;) {
        const nl = chunk.indexOf(10, start);
        if (nl === -1) {
          lineBytes += chunk.length - start;
          if (lineBytes > limit) { sock.destroy(); return; }
          break;
        }
        if (lineBytes + (nl - start) > limit) { sock.destroy(); return; }
        lineBytes = 0;
        start = nl + 1;
      }
    });
    const waits = new Map(); // request id -> participant id
    const send = m => { if (!sock.destroyed) sock.write(JSON.stringify(m) + '\n'); };
    readline.createInterface({ input: sock }).on('line', async line => {
      if (line.length > (authed ? AUTH_MAX_LINE : PRE_AUTH_MAX_LINE)) return sock.destroy();
      let m; try { m = JSON.parse(line); } catch { return; }
      try {
        if (m.method === 'hello') {
          const clientNonce = typeof m.params?.nonce === 'string' && m.params.nonce.length >= 16 && m.params.nonce.length <= 128 ? m.params.nonce : null;
          if (!clientNonce) return send({ id: m.id, result: { ok: false, error: ctx.core.tUi('service.auth_need_nonce') } });
          serverNonce = crypto.randomBytes(16).toString('hex');
          const proof = crypto.createHmac('sha256', token).update(`server:${clientNonce}`).digest('hex');
          return send({ id: m.id, result: { ok: true, challenge: serverNonce, proof, version: VERSION } });
        }
        if (m.method === 'hello_verify') {
          if (!serverNonce) return send({ id: m.id, result: { ok: false, error: ctx.core.tUi('service.auth_need_hello') } });
          const expected = crypto.createHmac('sha256', token).update(`client:${serverNonce}`).digest('hex');
          serverNonce = null;
          authed = safeEqual(m.params?.proof, expected);
          if (authed) { openConns.add(conn); ctx.core.connOpened(conn); }
          return send({ id: m.id, result: authed ? { ok: true, conn, version: VERSION } : { ok: false, error: ctx.core.tUi('service.auth_failed') } });
        }
        if (!authed) return send({ id: m.id, error: 'not authenticated' });
        if (m.method === 'cancel') { const pid = waits.get(m.params?.id); if (pid) ctx.core.cancelWait(pid, conn); return; }
        if (m.method === 'tool') {
          const { name, args, client } = m.params || {};
          if (name === 'next' && args?.participant) waits.set(m.id, args.participant);
          try { send({ id: m.id, result: await callTool(ctx.core, name, args, { conn, client }) }); }
          finally { waits.delete(m.id); }
          return;
        }
        send({ id: m.id, error: `unknown method ${m.method}` });
      } catch (error) { log(`pipe error ${error?.stack || error}`); send({ id: m.id, error: ctx.core.tUi('service.internal_error') }); }
    });
    const closed = () => { if (authed) { openConns.delete(conn); ctx.core.connClosed(conn); } };
    sock.on('close', closed);
    sock.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    pipe.once('error', e => {
      try { ctx.db?.close(); } catch { /* closing on startup error */ }
      if (e.code !== 'EADDRINUSE') return reject(e);
      let pid = null;
      try { pid = JSON.parse(fs.readFileSync(serviceFile(home), 'utf8')).pid; } catch { /* none */ }
      if (Number.isInteger(pid) && pid > 0 && isPidAlive(pid)) {
        return reject(Object.assign(new Error(t(bootLang, 'service.already_running')), { code: 'ALREADY_RUNNING' }));
      }
      return reject(Object.assign(new Error(t(bootLang, 'service.pipe_in_use', pipePath(home), pid ?? 'none')), { code: 'PIPE_IN_USE' }));
    });
    if (process.platform !== 'win32') try { fs.unlinkSync(pipePath(home)); } catch { /* none */ }
    pipe.listen(pipePath(home), resolve);
  });

  // ---- GUI API ----
  const hostsCache = { at: 0, lang: null, value: [] };
  const hosts = fresh => {
    const lang = ctx.core.uiLang();
    if (fresh || hostsCache.lang !== lang || Date.now() - hostsCache.at > 15_000) {
      hostsCache.value = hostStatus(process.env, lang);
      hostsCache.at = Date.now();
      hostsCache.lang = lang;
    }
    return hostsCache.value;
  };
  const legacyWarnings = () => {
    if (process.env.IDLESHIFT_HOME) return [];
    const lang = ctx.core.uiLang();
    const normCurrent = path.resolve(home).toLowerCase();
    const legacy = detectLegacyDataHomes();
    const list = [];
    const add = (item, label) => {
      if (!item) return;
      if (path.resolve(item.dir).toLowerCase() === normCurrent) return;
      const timeStr = item.mtime ? new Date(item.mtime).toLocaleString(lang === 'ja' ? 'ja-JP' : 'en-US') : t(lang, 'service.unknown_time');
      list.push({
        dir: item.dir,
        label,
        mtime: timeStr,
        isMigrated: !!item.isMigrated,
        message: item.isMigrated
          ? t(lang, 'service.legacy_migrated_msg', item.dir, timeStr)
          : t(lang, 'service.legacy_unmigrated_msg', item.dir, timeStr)
      });
    };
    add(legacy.l1, 'L1');
    for (const l2 of legacy.l2) add(l2, 'L2');
    for (const l3 of legacy.l3) add(l3, 'L3');
    return list;
  };
  const phrases = root => ({
    once: ctx.core.tAi('service.start_phrase_once', root),
    unattended: ctx.core.tAi('service.start_phrase_unattended', root)
  });

  const api = {
    state: () => ({ ...ctx.core.snapshot(), service: { ...buildInfo(), schema: SCHEMA_VERSION, home, pid: process.pid }, hosts: hosts(false), legacy_warnings: legacyWarnings(), adapters: { ...adapters.status(), available: Object.fromEntries(Object.entries(ADAPTERS).map(([k, a]) => [k, typeof a.name === 'function' ? a.name(ctx.core.uiLang()) : a.name])) } }),
    goalDetail: p => ctx.core.goalDetail(p.goal),
    taskDetail: p => ctx.core.taskDetail(p.task),
    createProject: p => ctx.core.createProject(p),
    renameProject: p => ctx.core.renameProject(p.project, p.name),
    addRoot: p => ctx.core.addRoot(p.project, p.path),
    removeRoot: p => ctx.core.removeRoot(p.path_norm),
    dismissRootRequest: p => ctx.core.dismissRootRequest(p.path_norm),
    pickFolder: () => pickFolder(ctx.core.uiLang()),
    createGoal: p => ctx.core.createGoal(p.project, p.goal),
    updateGoal: p => ctx.core.updateGoal(p.goal, p.patch),
    setGoalStatus: p => ctx.core.setGoalStatus(p.goal, p.status),
    approveProposedGoal: p => ctx.core.approveProposedGoal(p.goal),
    rejectProposedGoal: p => ctx.core.rejectProposedGoal(p.goal),
    setProjectStop: p => ctx.core.setProjectStop(p.project, !!p.stopped),
    addHumanTask: p => ctx.core.addHumanTask(p.goal, p.task),
    addHumanNote: p => ctx.core.addHumanNote(p.goal, p.text),
    answerDecision: p => ctx.core.answerDecision(p.decision, p.answer, p.note),
    resolveNeedsCheck: p => ctx.core.resolveNeedsCheck(p.task, p.action),
    removeParticipant: p => ctx.core.removeParticipant(p.participant),
    setClientJoinBlocked: p => ctx.core.setClientJoinBlocked(p.project, p.client, p.blocked !== false),
    revokeParticipant: p => ctx.core.revokeParticipant(p.participant, p.revoked !== false),
    setProfile: p => ctx.core.setProfile(p.project, p.label, p.profile),
    syncUsage: () => ctx.core.syncUsage(),
    usageWindows: p => ctx.core.usageWindows(p?.service || null),
    setUsageManual: p => ctx.core.setUsageManual(p),
    removeUsage: p => ctx.core.removeUsage(p.service, p.window || null),
    setTierPolicy: p => ctx.core.setTierPolicy(p.project, p.policy),
    setLanguages: p => ctx.core.setLanguages(p),
    setQuota: p => ctx.core.setQuota(p.client, p.quota, 'human'),
    setAdapters: p => ctx.core.setAdapters(p.project, p.adapters),
    startPhrase: p => phrases(p.root),
    hosts: () => hosts(true),
    hostRegister: p => { const r = hostChange(p.key, true, { home, lang: ctx.core.uiLang() }); hostsCache.at = 0; return r; },
    hostUnregister: p => { const r = hostChange(p.key, false, { home, lang: ctx.core.uiLang() }); hostsCache.at = 0; return r; },
    backupNow: () => ({ file: backupTo(ctx.db, path.join(home, 'backups', `manual-${stamp()}.db`)) }),
    listBackups: () => ({ dir: path.join(home, 'backups'), files: fs.readdirSync(path.join(home, 'backups')).filter(f => f.endsWith('.db')).map(f => ({ name: f, size: fs.statSync(path.join(home, 'backups', f)).size, at: fs.statSync(path.join(home, 'backups', f)).mtimeMs })).sort((a, b) => b.at - a.at) }),
    restoreBackup: p => {
      const file = path.join(home, 'backups', path.basename(String(p.name || '')));
      if (!fs.existsSync(file)) throw new Refusal('not_found', ctx.core.tUi('service.backup_not_found'));
      const info = inspectBackup(file);
      // Verify the backup can actually be opened and migrated in a temporary copy before touching live state.
      const tmpDb = dbFile(home) + `.restore-tmp-${process.pid}-${Date.now()}`;
      try {
        fs.copyFileSync(file, tmpDb);
        const testDb = openDb(tmpDb);
        testDb.close();
      } finally {
        for (const ext of ['', '-wal', '-shm']) try { fs.rmSync(tmpDb + ext); } catch { /* not present */ }
      }
      // High-watermark of everything handed out so far, kept next to (never inside) the database.
      // Written atomically before anything is replaced; a damaged file stops the restore.
      const wmFile = path.join(home, 'restore-watermark.json');
      let saved = null;
      if (fs.existsSync(wmFile)) {
        try { saved = JSON.parse(fs.readFileSync(wmFile, 'utf8')); if (!Number.isFinite(saved?.gen) || typeof saved?.seq !== 'object') throw new Error('shape'); }
        catch { throw new Refusal('watermark_damaged', ctx.core.tUi('service.watermark_damaged', wmFile)); }
      }
      const W = Core.mergeWatermarks(saved, ctx.core.watermark());
      fs.writeFileSync(wmFile + '.tmp', JSON.stringify(W));
      fs.renameSync(wmFile + '.tmp', wmFile);
      const before = backupTo(ctx.db, path.join(home, 'backups', `before-restore-${stamp()}.db`));
      for (const pid of [...ctx.core.waiters.keys()]) ctx.core.resolveWaiter(pid, { kind: 'none', again: true }, 'restore');
      ctx.db.close();
      for (const ext of ['', '-wal', '-shm']) try { fs.rmSync(dbFile(home) + ext); } catch { /* not present */ }
      fs.copyFileSync(file, dbFile(home));
      open();
      ctx.core.invalidateAfterRestore(W);
      for (const s of [...sockets]) s.destroy();
      openConns.clear();
      return { ok: true, restored: info, previous_saved_as: before };
    },
    exportGoal: p => { const text = ctx.core.exportMarkdown(p.goal); const file = path.join(home, 'exports', `${p.goal}-${stamp()}.md`); fs.writeFileSync(file, text, 'utf8'); return { file, text }; },
    deleteProject: p => ctx.core.deleteProject(p.project, p.confirm),
    setProjectArchived: p => ctx.core.setProjectArchived(p.project, p.archived),
    mergeTaskWorktree: p => ctx.core.mergeTaskWorktree(p.task),
    discardTaskWorktree: p => ctx.core.discardTaskWorktree(p.task),
    diagnostics: () => {
      const snap = ctx.core.snapshot();
      const userHome = process.env.USERPROFILE || process.env.HOME || '';
      const mask = t => { let s = String(t); if (userHome) s = s.split(userHome).join('%USERPROFILE%'); return s.replace(/[A-Za-z0-9_\-]{32,}/g, '***'); };
      const report = {
        note: ctx.core.tUi('service.diagnostics_note'),
        service: { ...buildInfo(), schema: SCHEMA_VERSION, node: process.version, platform: `${process.platform} ${process.arch}` },
        counts: Object.fromEntries(['projects', 'goals', 'tasks', 'participants', 'reports', 'evidence', 'decisions', 'events'].map(t => [t, ctx.core.one(`SELECT COUNT(*) c FROM ${t}`).c])),
        clients: snap.clients.map(c => ({ client: c.client, version: c.client_version, level: c.text, joins: c.joins, cycles: c.cycles, unattended: c.unattended_cycles, hold_ok_s: Math.round(c.hold_ok_ms / 1000), hold_fail_s: c.hold_fail_ms ? Math.round(c.hold_fail_ms / 1000) : null, wait_resumes: c.wait_resumes, quota: c.quota.state })),
        hosts: hosts(true).map(h => ({ key: h.key, detected: h.detected, registered: h.registered, up_to_date: h.up_to_date, error: h.error })),
        recent_events: ctx.core.all('SELECT ts, type, goal_id, task_id, participant FROM events ORDER BY id DESC LIMIT 200').map(e => `${new Date(e.ts).toISOString()} ${e.type} ${e.goal_id || ''} ${e.task_id || ''} ${e.participant || ''}`.trim()),
        service_log_tail: (() => { try { return fs.readFileSync(logFile, 'utf8').split('\n').slice(-80); } catch { return []; } })()
      };
      const text = mask(JSON.stringify(report, null, 2));
      const file = path.join(home, 'exports', `diagnostics-${stamp()}.json`);
      fs.writeFileSync(file, text, 'utf8');
      return { file, text };
    },
    shutdown: () => { setTimeout(() => stop(), 100); return { ok: true }; }
  };

  // ---- GUI HTTP: loopback only, token, Host/Origin checks, size and rate limits ----
  let windowStart = Date.now(), windowCount = 0;
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    const okHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const head = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin' };
    const end = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { ...head, 'Content-Type': type }); res.end(body); };
    if (!okHosts.includes(req.headers.host)) return end(403, '{"error":"forbidden host"}');
    if (req.headers.origin && !okHosts.map(h => `http://${h}`).includes(req.headers.origin)) return end(403, '{"error":"forbidden origin"}');
    if (Date.now() - windowStart > 10_000) { windowStart = Date.now(); windowCount = 0; }
    if (++windowCount > 400) return end(429, '{"error":"too many requests"}');
    let url; try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return end(400, '{"error":"bad url"}'); }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
      if (!rel || rel.includes('..') || rel.includes('\\') || rel.includes('%')) return end(404, 'not found', 'text/plain; charset=utf-8');
      const allowedTop = !rel.includes('/') || rel.startsWith('i18n/');
      const guiRoot = path.resolve(APP_ROOT, 'gui');
      const file = path.resolve(guiRoot, rel);
      if (!allowedTop || !file.startsWith(guiRoot + path.sep) || !MIME[path.extname(file)] || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return end(404, 'not found', 'text/plain; charset=utf-8');
      }
      return end(200, fs.readFileSync(file), MIME[path.extname(file)]);
    }
    if (req.method !== 'POST' || url.pathname !== '/api/call') return end(404, '{"error":"not found"}');
    if (!safeEqual(req.headers['x-idleshift-token'], token)) return end(401, '{"error":"unauthorized"}');
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return end(415, '{"error":"json only"}');
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 1_000_000) { end(413, '{"error":"too large"}'); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (res.writableEnded) return;
      try {
        const { method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!Object.hasOwn(api, method)) return end(404, '{"error":"unknown method"}');
        end(200, JSON.stringify({ ok: true, result: await api[method](params || {}) }));
      } catch (error) {
        if (error instanceof Refusal) return end(200, JSON.stringify({ ok: false, code: error.code, message: error.message }));
        log(`api error ${error?.stack || error}`);
        end(200, JSON.stringify({ ok: false, code: 'internal', message: String(error.message || error).slice(0, 300) }));
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(guiPort, '127.0.0.1', resolve); });
  const port = server.address().port;

  fs.writeFileSync(serviceFile(home), JSON.stringify({ pid: process.pid, port, token, version: VERSION, started_at: new Date().toISOString() }), { mode: 0o600 });
  log(`service started pid=${process.pid} gui=127.0.0.1:${port} v${VERSION}`);

  const timer = setInterval(() => {
    try { ctx.core.tick(); if (adaptersEnabled) adapters.tick(); } catch (error) { log(`tick error ${error?.stack || error}`); }
  }, 2000);
  // Collect AI usage windows now and every 5 minutes; a failing source is only logged.
  const syncUsage = () => ctx.core.syncUsage().then(r => { for (const e of r.errors) log(`usage ${e.collector}: ${e.error}`); }).catch(error => log(`usage sync error ${error?.stack || error}`));
  if (process.env.IDLESHIFT_USAGE_SYNC !== '0') syncUsage();
  const usageTimer = setInterval(() => { if (process.env.IDLESHIFT_USAGE_SYNC !== '0') syncUsage(); }, 5 * 60_000);
  let lastAutoBackup = 0;
  const backupTimer = setInterval(() => {
    // One rolling daily copy; manual and pre-update copies are kept separately.
    try { if (Date.now() - lastAutoBackup > 24 * 3600_000) { backupTo(ctx.db, path.join(home, 'backups', `auto-${new Date().toISOString().slice(0, 10)}.db`)); lastAutoBackup = Date.now(); } } catch (error) { log(`backup error ${error}`); }
  }, 60_000);

  let stopping = false;
  async function stop() {
    if (stopping) return; stopping = true;
    clearInterval(timer); clearInterval(backupTimer); clearInterval(usageTimer);
    adapters.stopAll();
    for (const pid of [...ctx.core.waiters.keys()]) ctx.core.resolveWaiter(pid, { kind: 'none', again: false, reason: ctx.core.tUi('service.shutdown_reason') }, 'shutdown');
    try { ctx.core.meta('last_tick', Date.now()); } catch { /* closing anyway */ }
    await new Promise(r => setTimeout(r, 50));
    server.close(); pipe.close();
    server.closeAllConnections?.();
    try { ctx.db.close(); } catch { /* already closed */ }
    try { fs.rmSync(serviceFile(home)); } catch { /* none */ }
    log('service stopped');
    handle.onStop?.();
  }
  const handle = { home, port, token, ctx, stop, adapters, onStop: null };
  return handle;
}

export function readService(home = dataHome()) {
  try { return JSON.parse(fs.readFileSync(serviceFile(home), 'utf8')); } catch { return null; }
}
