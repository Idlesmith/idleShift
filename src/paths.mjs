// Locations. Everything the user owns lives under one local data folder
// (never a synced folder by default); tests override it with IDLESHIFT_HOME.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

export function dataHome(env = process.env) {
  if (env.IDLESHIFT_HOME) return path.resolve(env.IDLESHIFT_HOME);
  const home = env.USERPROFILE || env.HOME || os.homedir();
  return path.join(home, '.idleshift');
}

export function ensureHome(home = dataHome()) {
  for (const d of ['', 'backups', 'logs', 'host-backups', 'exports', 'worktrees']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return home;
}

// One pipe per data folder, so a test instance never talks to the real one.
export function pipePath(home = dataHome()) {
  const tag = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
  return process.platform === 'win32' ? `\\\\.\\pipe\\idleshift-${tag}` : path.join(home, 'service.sock');
}

export const serviceFile = (home = dataHome()) => path.join(home, 'service.json');
export const dbFile = (home = dataHome()) => path.join(home, 'idleshift.db');
export const worktreesDir = (home = dataHome()) => path.join(home, 'worktrees');
export const worktreePath = (home, projectId, taskId) => path.join(worktreesDir(home), projectId, taskId);

export function isDataHomeMoved(home = dataHome()) {
  try {
    return fs.existsSync(path.join(home, 'MOVED-TO-.idleshift.txt'));
  } catch {
    return false;
  }
}

// Root lookup key: real path, one separator style, lower case on Windows.
// Used only to find the project a caller belongs to - never as a permission.
export function normalizeRoot(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let full = path.resolve(p.trim());
  try { full = fs.realpathSync.native(full); } catch { /* not on disk: keep the resolved text */ }
  full = full.replace(/[\\/]+$/, '');
  if (process.platform === 'win32') full = full.replace(/\//g, '\\').toLowerCase();
  return full || path.sep;
}

export function isInside(rootNorm, candidateNorm) {
  return candidateNorm === rootNorm || candidateNorm.startsWith(rootNorm + path.sep);
}

export function detectLegacyDataHomes(env = process.env) {
  const localAppData = env.LOCALAPPDATA;
  if (!localAppData || !fs.existsSync(localAppData)) {
    return { l1: null, l2: [], l3: [] };
  }

  const checkDir = (dir, dbName) => {
    const dbPath = path.join(dir, dbName);
    if (!fs.existsSync(dbPath)) return null;
    let mtime = 0;
    let size = 0;
    try {
      const st = fs.statSync(dbPath);
      mtime = st.mtimeMs;
      size = st.size;
    } catch { /* ignore */ }
    const isMigrated = fs.existsSync(path.join(dir, 'MOVED-TO-.idleshift.txt'));
    return { dir, dbPath, mtime, size, isMigrated };
  };

  const l1Dir = path.join(localAppData, 'IdleShift');
  const l1 = checkDir(l1Dir, 'idleshift.db');

  const l2 = [];
  const pkgDir = path.join(localAppData, 'Packages');
  if (fs.existsSync(pkgDir)) {
    try {
      for (const ent of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith('Claude_')) continue;
        const candidate = path.join(pkgDir, ent.name, 'LocalCache', 'Local', 'IdleShift');
        const res = checkDir(candidate, 'idleshift.db');
        if (res) l2.push(res);
      }
    } catch { /* ignore */ }
  }

  const l3 = [];
  const l3Plain = checkDir(path.join(localAppData, 'Conclavity'), 'conclavity.db');
  if (l3Plain) l3.push(l3Plain);
  if (fs.existsSync(pkgDir)) {
    try {
      for (const ent of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith('Claude_')) continue;
        const candidate = path.join(pkgDir, ent.name, 'LocalCache', 'Local', 'Conclavity');
        const res = checkDir(candidate, 'conclavity.db');
        if (res) l3.push(res);
      }
    } catch { /* ignore */ }
  }

  return { l1, l2, l3 };
}

export function migrateDataHome(env = process.env, { select = null } = {}) {
  const target = dataHome(env);
  if (fs.existsSync(target) && (fs.existsSync(path.join(target, 'idleshift.db')) || fs.existsSync(path.join(target, 'service.json')))) {
    return { status: 'target_exists', target };
  }

  const legacy = detectLegacyDataHomes(env);
  const activeL1 = legacy.l1 && !legacy.l1.isMigrated ? legacy.l1 : null;
  const activeL2 = legacy.l2.filter(x => !x.isMigrated);

  if (!activeL1 && activeL2.length === 0) {
    return { status: 'fresh', target };
  }

  let source = null;
  if (typeof select === 'string' && select.toLowerCase() === 'l1' && activeL1) {
    source = activeL1;
  } else if (typeof select === 'string' && select.toLowerCase() === 'l2' && activeL2.length > 0) {
    source = activeL2[0];
  } else if (activeL1 && activeL2.length > 0) {
    return {
      status: 'choice_required',
      message: '本物の %LOCALAPPDATA%\\IdleShift と Claudeデスクトップ振り替え先の両方にデータがあります。どちらを移行するか手動で選択してください。',
      candidates: [activeL1, ...activeL2]
    };
  } else {
    source = activeL1 || activeL2[0];
  }
  const sourceDir = source.dir;

  // Check running service
  const svcFile = path.join(sourceDir, 'service.json');
  if (fs.existsSync(svcFile)) {
    try {
      const svc = JSON.parse(fs.readFileSync(svcFile, 'utf8'));
      if (svc.pid) {
        try {
          process.kill(svc.pid, 0);
          return { status: 'service_running', message: `移行元のサービス(pid: ${svc.pid})が稼働中です。停止してから移行を実行してください。` };
        } catch { /* not running */ }
      }
    } catch { /* corrupted service.json */ }
  }

  ensureHome(target);
  const tmpDb = path.join(target, 'idleshift.db.migrating');
  try {
    // Copy using SQLite VACUUM INTO to safely include any uncheckpointed WAL pages
    const srcDb = new DatabaseSync(source.dbPath);
    srcDb.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
    srcDb.close();

    // Verify integrity of the destination
    const db = new DatabaseSync(tmpDb);
    const check = db.prepare('PRAGMA integrity_check').get();
    db.close();
    if (check?.integrity_check !== 'ok') {
      fs.rmSync(tmpDb, { force: true });
      return { status: 'corrupted', message: 'データベースの整合性チェックに失敗しました。' };
    }
  } catch (err) {
    fs.rmSync(tmpDb, { force: true });
    return { status: 'failed', error: err.message };
  }

  // Migrate restore watermark file if present (required to prevent generation replay on restore)
  const watermarkFile = path.join(sourceDir, 'restore-watermark.json');
  if (fs.existsSync(watermarkFile)) {
    try {
      fs.copyFileSync(watermarkFile, path.join(target, 'restore-watermark.json'));
    } catch { /* ignore non-critical copy error */ }
  }

  for (const d of ['backups', 'exports', 'host-backups', 'logs', 'worktrees']) {
    const s = path.join(sourceDir, d);
    const dst = path.join(target, d);
    if (fs.existsSync(s)) {
      try { fs.cpSync(s, dst, { recursive: true }); } catch { /* ignore non-critical copy failure */ }
    }
  }

  fs.renameSync(tmpDb, path.join(target, 'idleshift.db'));

  try {
    fs.writeFileSync(path.join(sourceDir, 'MOVED-TO-.idleshift.txt'), `Migrated to ${target} at ${new Date().toISOString()}\n`);
  } catch { /* ignore if readonly */ }

  return { status: 'migrated', from: sourceDir, to: target };
}
