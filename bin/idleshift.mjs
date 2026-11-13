#!/usr/bin/env node
// Entry point. Ordinary use needs none of these commands: the launcher opens
// the GUI, and AI apps start "mcp" themselves.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w?.message || w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));

const cmd = process.argv[2] || 'gui';
const { dataHome, ensureHome, VERSION, migrateDataHome, detectLegacyDataHomes, isDataHomeMoved } = await import('../src/paths.mjs');
const { t, resolveUiLanguage } = await import('../src/i18n/index.mjs');
const cliLang = resolveUiLanguage('auto');

const targetHome = dataHome();

// Check if current dataHome is already migrated (contains MOVED-TO-.idleshift.txt)
if (isDataHomeMoved(targetHome)) {
  console.error(t(cliLang, 'cli.legacy_home_warning'));
  process.exit(1);
}

// Auto-migration check: only 'gui' (launched by human / IdleShift.bat) performs automatic migration,
// and ONLY when IDLESHIFT_HOME is not explicitly specified in process.env.
// 'service' (e.g. autostarted by relays) refuses to start with an empty DB if legacy data exists.
if (!process.env.IDLESHIFT_HOME && (cmd === 'gui' || cmd === 'service')) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dbPath = path.join(targetHome, 'idleshift.db');
  if (!fs.existsSync(dbPath)) {
    const legacy = detectLegacyDataHomes();
    const hasLegacy = (legacy.l1 && !legacy.l1.isMigrated) || legacy.l2.some(x => !x.isMigrated);
    if (hasLegacy) {
      if (cmd === 'service') {
        console.error(t(cliLang, 'cli.need_migration_service'));
        process.exit(1);
      }
      console.log(t(cliLang, 'cli.migrating'));
      const res = migrateDataHome();
      if (res.status === 'migrated') {
        console.log(t(cliLang, 'cli.migrated_ok', res.from, res.to));
      } else if (res.status === 'choice_required') {
        console.error(t(cliLang, 'cli.choice_required_1'));
        console.error(t(cliLang, 'cli.choice_required_2'));
        process.exit(1);
      } else if (res.status === 'service_running') {
        console.error(t(cliLang, 'cli.interrupted', res.message));
        console.error(t(cliLang, 'cli.stop_and_restart'));
        process.exit(1);
      } else if (res.status === 'corrupted' || res.status === 'failed') {
        console.error(t(cliLang, 'cli.migrate_failed', res.error || res.message));
        console.error(t(cliLang, 'cli.no_empty_start'));
        process.exit(1);
      }
    }
  }
}

const home = ensureHome(targetHome);

async function ensureRunning() {
  const { connectService } = await import('../src/relay.mjs');
  const link = await connectService(home, { autostart: true });
  link.close();
  const { readService } = await import('../src/service.mjs');
  for (let i = 0; i < 50; i++) { const s = readService(home); if (s?.port) return s; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(t(cliLang, 'cli.cannot_read_service'));
}

if (cmd === 'mcp') {
  const { runRelay } = await import('../src/relay.mjs');
  await runRelay({ home });
  process.exit(0);
} else if (cmd === 'service') {
  const { runService } = await import('../src/service.mjs');
  try {
    const svc = await runService({ home, quiet: !process.argv.includes('--verbose') });
    svc.onStop = () => process.exit(0);
    process.on('SIGINT', () => svc.stop());
    process.on('SIGTERM', () => svc.stop());
  } catch (error) {
    if (error.code === 'ALREADY_RUNNING') process.exit(0);
    console.error(error.message); process.exit(1);
  }
} else if (cmd === 'gui') {
  // Restart only when the code changed after the running service started:
  // a restart drops every waiting AI, so it must not happen on every launch.
  {
    const fs = await import('node:fs'); const path = await import('node:path'); const { fileURLToPath } = await import('node:url');
    const { readService } = await import('../src/service.mjs');
    const { cleanupStaleServiceFile, isPidAlive } = await import('../src/relay.mjs');
    const running = readService(home);
    if (running && !isPidAlive(running.pid)) cleanupStaleServiceFile(home);
    else if (running?.started_at) {
      const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const newest = ['src', 'bin'].flatMap(d => fs.readdirSync(path.join(appRoot, d)).filter(f => f.endsWith('.mjs')).map(f => fs.statSync(path.join(appRoot, d, f)).mtimeMs)).reduce((a, b) => Math.max(a, b), 0);
      if (newest > Date.parse(running.started_at)) {
        console.log(t(cliLang, 'cli.restarting_updated'));
        await fetch(`http://127.0.0.1:${running.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': running.token }, body: JSON.stringify({ method: 'shutdown' }) }).catch(() => null);
        for (let i = 0; i < 50 && readService(home); i++) await new Promise(r => setTimeout(r, 100));
      }
    }
  }
  const s = await ensureRunning();
  const url = `http://127.0.0.1:${s.port}/#t=${s.token}`;
  if (process.argv.includes('--print')) console.log(url);
  else {
    const { spawn } = await import('node:child_process');
    const fs = await import('node:fs');
    const edge = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map(p => `${p}\\Microsoft\\Edge\\Application\\msedge.exe`).find(p => fs.existsSync(p));
    // An app-style window without address bar; any browser works as a fallback.
    if (edge) spawn(edge, [`--app=${url}`, '--window-size=1280,860'], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    else console.log(url);
  }
  process.exit(0);
} else if (cmd === 'stop') {
  const { readService } = await import('../src/service.mjs');
  const { cleanupStaleServiceFile, isPidAlive } = await import('../src/relay.mjs');
  const s = readService(home);
  if (s && !isPidAlive(s.pid)) { cleanupStaleServiceFile(home); console.log(t(cliLang, 'cli.cleaned_stale')); process.exit(0); }
  if (!s) { console.log(t(cliLang, 'cli.not_running')); process.exit(0); }
  const r = await fetch(`http://127.0.0.1:${s.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': s.token }, body: JSON.stringify({ method: 'shutdown' }) }).catch(() => null);
  // Return only once the service is really gone, so "stop" followed by a start never talks to the dying instance.
  for (let i = 0; i < 50 && readService(home); i++) await new Promise(res => setTimeout(res, 100));
  console.log(r?.ok && !readService(home) ? t(cliLang, 'cli.stopped') : t(cliLang, 'cli.stop_failed'));
  process.exit(0);
} else if (cmd === 'hosts') {
  const { hostStatus } = await import('../src/hosts.mjs');
  for (const h of hostStatus(process.env, cliLang)) console.log(t(cliLang, 'cli.host_line', h.key, h.detected ? t(cliLang, 'cli.yes') : t(cliLang, 'cli.no'), h.registered ? (h.up_to_date ? t(cliLang, 'cli.reg_ok') : t(cliLang, 'cli.reg_outdated')) : t(cliLang, 'cli.reg_none'), h.file));
  process.exit(0);
} else if (cmd === 'migrate') {
  const srcArg = process.argv.find(a => a.startsWith('--source='))?.split('=')[1];
  const res = migrateDataHome(process.env, { select: srcArg });
  if (res.status === 'migrated') {
    console.log(t(cliLang, 'cli.migrate_cmd_ok', res.from, res.to));
    process.exit(0);
  }
  if (res.status === 'target_exists') {
    console.log(t(cliLang, 'cli.migrate_cmd_already', res.target));
    process.exit(0);
  }
  if (res.status === 'fresh') {
    console.log(t(cliLang, 'cli.migrate_cmd_none'));
    process.exit(0);
  }
  if (res.status === 'choice_required') {
    console.error(t(cliLang, 'cli.migrate_cmd_choice'));
    process.exit(1);
  }
  console.error(t(cliLang, 'cli.migrate_cmd_fail', res.error || res.message || res.status));
  process.exit(1);
} else if (cmd === 'version' || cmd === '--version') {
  console.log(VERSION); process.exit(0);
} else {
  console.log('idleshift [gui|service|mcp|stop|hosts|version]');
  process.exit(cmd === 'help' || cmd === '--help' ? 0 : 1);
}
