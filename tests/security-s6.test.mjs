import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpDir } from './helpers.mjs';
import { inspectBackup, SCHEMA_VERSION } from '../src/db.mjs';
import { runService } from '../src/service.mjs';

function makeIncompleteBackup(file, missingTable = 'participants') {
  const db = new DatabaseSync(file);
  const tables = {
    meta: 'CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT)',
    seq: 'CREATE TABLE seq(name TEXT PRIMARY KEY, n INTEGER NOT NULL)',
    projects: 'CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0, adapters TEXT NOT NULL DEFAULT \'{}\', created_at INTEGER NOT NULL)',
    roots: 'CREATE TABLE roots(path_norm TEXT PRIMARY KEY, project_id TEXT NOT NULL, path_display TEXT NOT NULL, created_at INTEGER NOT NULL)',
    root_requests: 'CREATE TABLE root_requests(path_norm TEXT PRIMARY KEY, path_display TEXT NOT NULL, client TEXT, label TEXT, last_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)',
    goals: 'CREATE TABLE goals(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL)',
    branches: 'CREATE TABLE branches(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL)',
    tasks: 'CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, goal_id TEXT NOT NULL)',
    participants: 'CREATE TABLE participants(id TEXT PRIMARY KEY, project_id TEXT NOT NULL)',
    clients: 'CREATE TABLE clients(client TEXT PRIMARY KEY)',
    reports: 'CREATE TABLE reports(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL)',
    evidence: 'CREATE TABLE evidence(id TEXT PRIMARY KEY, goal_id TEXT NOT NULL)',
    decisions: 'CREATE TABLE decisions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL)',
    events: 'CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL)',
    quota: 'CREATE TABLE quota(client TEXT PRIMARY KEY)',
    participant_profiles: 'CREATE TABLE participant_profiles(project_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(project_id,label))',
    usage_log: 'CREATE TABLE usage_log(id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL)',
    worktrees: 'CREATE TABLE worktrees(task_id TEXT PRIMARY KEY)',
  };
  for (const [name, ddl] of Object.entries(tables)) {
    if (name !== missingTable) db.exec(ddl);
  }
  db.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  db.close();
}

test('S-6: inspectBackup and restoreBackup refuse backup missing participants or seq before touching live DB', async () => {
  const home = tmpDir('s6-incomplete');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
    body: JSON.stringify({ method, params }),
  })).json());
  try {
    const project = (await gui('createProject', { name: 'p' })).result.id;
    const goal = (await gui('createGoal', { project, goal: { title: 'live-goal' } })).result.id;

    const backupsDir = path.join(home, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    for (const missing of ['participants', 'seq']) {
      const badFile = path.join(backupsDir, `missing-${missing}.db`);
      makeIncompleteBackup(badFile, missing);
      assert.throws(() => inspectBackup(badFile), `inspectBackup must reject missing ${missing}`);
      const res = await gui('restoreBackup', { name: path.basename(badFile) });
      assert.equal(res.ok, false, `restoreBackup must refuse missing ${missing}`);
      assert.ok(svc.ctx.core.one('SELECT id FROM goals WHERE id=?', goal), 'live DB must remain intact');
    }
  } finally {
    await svc.stop();
  }
});

test('S-6: inspectBackup and restoreBackup refuse corrupt DB file before touching live DB', async () => {
  const home = tmpDir('s6-corrupt');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
    body: JSON.stringify({ method, params }),
  })).json());
  try {
    const project = (await gui('createProject', { name: 'p' })).result.id;
    const goal = (await gui('createGoal', { project, goal: { title: 'live-goal' } })).result.id;

    const backupsDir = path.join(home, 'backups');
    fs.mkdirSync(backupsDir, { recursive: true });
    const corruptFile = path.join(backupsDir, 'corrupt.db');
    fs.writeFileSync(corruptFile, 'not a sqlite database at all');

    assert.throws(() => inspectBackup(corruptFile));
    const res = await gui('restoreBackup', { name: 'corrupt.db' });
    assert.equal(res.ok, false);
    assert.ok(svc.ctx.core.one('SELECT id FROM goals WHERE id=?', goal), 'live DB must remain intact');
  } finally {
    await svc.stop();
  }
});
