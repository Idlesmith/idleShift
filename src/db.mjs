// The local database is the single source of truth. Only the service process
// opens it; GUI and MCP both go through the same Core.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 8;

const V1 = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE seq(name TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0,
  adapters TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE roots(
  path_norm TEXT PRIMARY KEY, project_id TEXT NOT NULL, path_display TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE root_requests(
  path_norm TEXT PRIMARY KEY, path_display TEXT NOT NULL, client TEXT, label TEXT, last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1);
CREATE TABLE goals(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT '',
  done_evidence TEXT NOT NULL DEFAULT '', priorities TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  delegation TEXT NOT NULL, budgets TEXT NOT NULL, status TEXT NOT NULL,
  goal_version INTEGER NOT NULL DEFAULT 1, permission_version INTEGER NOT NULL DEFAULT 1, plan_version INTEGER NOT NULL DEFAULT 1,
  summary TEXT NOT NULL DEFAULT '', next_step TEXT NOT NULL DEFAULT '',
  assignments_used INTEGER NOT NULL DEFAULT 0, facilitator_streak INTEGER NOT NULL DEFAULT 0, facilitator_marker INTEGER NOT NULL DEFAULT -1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
CREATE TABLE branches(
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, parent_id TEXT, hypothesis TEXT NOT NULL, expected TEXT NOT NULL DEFAULT '',
  keep_cond TEXT NOT NULL DEFAULT '', reject_cond TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  created_by TEXT, created_at INTEGER NOT NULL, closed_at INTEGER);
CREATE TABLE tasks(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT NOT NULL, branch_id TEXT, parent_id TEXT,
  kind TEXT NOT NULL, role TEXT NOT NULL, mode TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  author TEXT, author_kind TEXT NOT NULL, state TEXT NOT NULL, gen INTEGER NOT NULL DEFAULT 1,
  assignee TEXT, prefer TEXT, exclude TEXT NOT NULL DEFAULT '[]', depends TEXT NOT NULL DEFAULT '[]', review INTEGER NOT NULL DEFAULT 0,
  offered_to TEXT, offer_expires INTEGER, lease_expires INTEGER, opened_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, redelegations INTEGER NOT NULL DEFAULT 0, past_assignees TEXT NOT NULL DEFAULT '[]',
  release_marker INTEGER NOT NULL DEFAULT 0, flag TEXT NOT NULL DEFAULT '', handoff TEXT NOT NULL DEFAULT '', result_summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX tasks_goal ON tasks(goal_id, state);
CREATE TABLE participants(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, label TEXT NOT NULL, client TEXT NOT NULL, client_version TEXT NOT NULL DEFAULT '',
  conn TEXT, root TEXT, revoked INTEGER NOT NULL DEFAULT 0, joined_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  cycles INTEGER NOT NULL DEFAULT 0, pending_unattended INTEGER NOT NULL DEFAULT 0, pending_limit_resume INTEGER NOT NULL DEFAULT 0,
  hold_pending_ms INTEGER, hold_pending_at INTEGER);
CREATE TABLE clients(
  client TEXT PRIMARY KEY, client_version TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, measured_at INTEGER,
  joins INTEGER NOT NULL DEFAULT 0, cycles INTEGER NOT NULL DEFAULT 0, unattended_cycles INTEGER NOT NULL DEFAULT 0,
  limit_resumes INTEGER NOT NULL DEFAULT 0, hold_ok_ms INTEGER NOT NULL DEFAULT 0, hold_fail_ms INTEGER, hold_fail_at INTEGER,
  wait_resumes INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'mcp');
CREATE TABLE reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, gen INTEGER NOT NULL, report_id TEXT NOT NULL,
  participant TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', stale INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id, gen, report_id));
CREATE TABLE evidence(
  id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, branch_id TEXT, task_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', by_participant TEXT, excluded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE decisions(
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT, task_id TEXT, kind TEXT NOT NULL, question TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, answer TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  asked_by TEXT, created_at INTEGER NOT NULL, answered_at INTEGER);
CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, project_id TEXT, goal_id TEXT, task_id TEXT, branch_id TEXT,
  participant TEXT, type TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}');
CREATE INDEX events_goal ON events(goal_id, id);
CREATE TABLE quota(
  client TEXT PRIMARY KEY, state TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  reported_at INTEGER NOT NULL, reset_at INTEGER, tried_after_reset INTEGER NOT NULL DEFAULT 0);
`;

// v2: a review remembers which submission (generation) of its target it is about (review #7).
const V2 = 'ALTER TABLE tasks ADD COLUMN target_gen INTEGER;';

// v3: report_id belongs to its sender, not to every participant on the task.
// Rebuild the UNIQUE constraint while retaining IDs, history and the sequence.
const V3 = `
CREATE TABLE reports_v3(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, gen INTEGER NOT NULL, report_id TEXT NOT NULL,
  participant TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', stale INTEGER NOT NULL DEFAULT 0,
  outcome TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id, gen, participant, report_id));
INSERT INTO reports_v3(id,task_id,gen,report_id,participant,kind,body,stale,outcome,created_at)
  SELECT id,task_id,gen,report_id,participant,kind,body,stale,outcome,created_at FROM reports;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='reports'),0)) WHERE name='reports_v3';
DROP TABLE reports;
ALTER TABLE reports_v3 RENAME TO reports;
`;

const V4 = db => {
  db.exec(`
CREATE TABLE participant_profiles(
  project_id TEXT NOT NULL, label TEXT NOT NULL, tier TEXT,
  limit_5h_claims INTEGER, limit_5h_minutes INTEGER, limit_7d_claims INTEGER, limit_7d_minutes INTEGER,
  updated_at INTEGER NOT NULL, PRIMARY KEY(project_id,label));
CREATE TABLE usage_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, label TEXT NOT NULL, participant TEXT NOT NULL,
  task_id TEXT NOT NULL, gen INTEGER NOT NULL, claimed_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT,
  UNIQUE(task_id,gen,participant));
CREATE INDEX usage_label ON usage_log(project_id,label,claimed_at);
`);
  // Isolated migration fixtures may contain only the table under test.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get()) {
    db.exec("ALTER TABLE tasks ADD COLUMN tier TEXT NOT NULL DEFAULT 'any'; ALTER TABLE tasks ADD COLUMN senior_review INTEGER NOT NULL DEFAULT 0;");
  }
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) db.exec("ALTER TABLE projects ADD COLUMN tier_policy TEXT NOT NULL DEFAULT '{}';");
};

const V5 = db => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()) db.exec('ALTER TABLE projects ADD COLUMN archived_at INTEGER;');
};

const V6 = db => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'").get()) {
    db.exec("ALTER TABLE goals ADD COLUMN git_isolation TEXT NOT NULL DEFAULT 'auto';");
  }
  db.exec(`
CREATE TABLE IF NOT EXISTS worktrees(
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  target_branch TEXT,
  state TEXT NOT NULL,
  uncommitted INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL);
`);
};

const V7 = db => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goals'").get()) {
    db.exec("ALTER TABLE goals ADD COLUMN author_kind TEXT NOT NULL DEFAULT 'human';");
    db.exec("ALTER TABLE goals ADD COLUMN author TEXT;");
    db.exec("UPDATE goals SET author_kind='ai' WHERE notes LIKE '[AI %';");
  }
};

const V8 = db => {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decisions'").get()) {
    db.exec('ALTER TABLE decisions ADD COLUMN message_key TEXT;');
    db.exec('ALTER TABLE decisions ADD COLUMN message_args TEXT;');
  }
};

const MIGRATIONS = [null, V1, V2, V3, V4, V5, V6, V7, V8];

export function openDb(file, { backupDir } = {}) {
  const existed = file !== ':memory:' && fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 3000;');
  let current = 0;
  try { current = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0); } catch { current = 0; }
  if (current > SCHEMA_VERSION) {
    db.close();
    throw new Error(`このデータは新しい版(${current})で作られています。IdleShiftを更新してください。`);
  }
  if (current < SCHEMA_VERSION) {
    // Keep a copy before any format change so a failed update can be undone.
    if (existed && current > 0 && backupDir) backupTo(db, path.join(backupDir, `pre-migrate-v${current}-${stamp()}.db`));
    for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db);
        else db.exec(MIGRATIONS[v]);
        db.prepare("INSERT INTO meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
    }
  }
  return db;
}

export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function backupTo(db, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.rmSync(target);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  return target;
}

const REQUIRED_TABLES_V1 = [
  'meta', 'seq', 'projects', 'roots', 'root_requests', 'goals', 'branches', 'tasks',
  'participants', 'clients', 'reports', 'evidence', 'decisions', 'events', 'quota',
];

// A file is restorable only if it passes integrity_check, has a known schema version,
// and contains every required table for that version.
export function inspectBackup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const icRow = db.prepare('PRAGMA integrity_check').get();
    const ic = icRow ? Object.values(icRow)[0] : '';
    if (ic !== 'ok') throw new Error(`バックアップの整合性検査に失敗しました: ${ic || 'unknown'}`);
    const v = Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value || 0);
    if (!v || v > SCHEMA_VERSION) throw new Error('対応していない版のバックアップです');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const required = [...REQUIRED_TABLES_V1];
    if (v >= 4) required.push('participant_profiles', 'usage_log');
    if (v >= 6) required.push('worktrees');
    const missing = required.filter(t => !tables.has(t));
    if (missing.length) throw new Error(`バックアップに必要なテーブルが不足しています: ${missing.join(', ')}`);
    const count = t => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    return { schema_version: v, projects: count('projects'), goals: count('goals'), tasks: count('tasks'), events: count('events') };
  } finally { db.close(); }
}
