import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';
import { makeCore, seed, joinAs, take, tmpDir } from './helpers.mjs';

async function setup() {
  const { core } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'assignee', 'a');
  const b = joinAs(core, root, 'foreign-one', 'b');
  const c = joinAs(core, root, 'foreign-two', 'c');
  const work = await take(core, a);
  const report = participant => core.report({ participant, task: work.task, gen: work.gen, report_id: 'done', kind: 'result', body: participant });
  return { core, a, b, c, work, report };
}

test('#10: foreign stale report cannot reserve the assignee report id', async () => {
  const { core, a, b, work, report } = await setup();
  assert.equal(report(b).accepted, false);
  const legitimate = report(a);
  assert.equal(legitimate.accepted, true);
  assert.notEqual(legitimate.duplicate, true);
  assert.equal(core.task(work.task).state, 'accepted');
  assert.equal(report(a).duplicate, true);
  assert.equal(report(a).accepted, true);
  const rows = core.all('SELECT participant, stale FROM reports WHERE task_id=? ORDER BY id', work.task);
  assert.deepEqual(rows.map(r => [r.participant, r.stale]), [[b, 1], [a, 0]]);
});

test('#10: foreign report after the result is stale rather than a successful duplicate', async () => {
  const { core, a, b, work, report } = await setup();
  assert.equal(report(a).accepted, true);
  assert.equal(report(b).accepted, false);
  assert.equal(report(b).duplicate, true);
  assert.equal(report(b).accepted, false);
  assert.equal(core.all('SELECT * FROM reports WHERE task_id=?', work.task).length, 2);
});

test('#10: separate foreign senders each keep their own idempotent stale history', async () => {
  const { core, a, b, c, work, report } = await setup();
  assert.equal(report(b).accepted, false);
  const other = report(c);
  assert.equal(other.accepted, false);
  assert.notEqual(other.duplicate, true);
  assert.equal(report(c).duplicate, true);
  assert.equal(report(a).accepted, true);
  assert.equal(core.all('SELECT * FROM reports WHERE task_id=?', work.task).length, 3);
});

test('#10: v2 migration preserves historical reports and scopes uniqueness to the sender', () => {
  const dir = tmpDir('report-id-migrate');
  const file = path.join(dir, 'legacy.db');
  const backupDir = path.join(dir, 'backups');
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta VALUES('schema_version','2');
    CREATE TABLE reports(
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, gen INTEGER NOT NULL, report_id TEXT NOT NULL,
      participant TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', stale INTEGER NOT NULL DEFAULT 0,
      outcome TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, UNIQUE(task_id, gen, report_id));
    INSERT INTO reports VALUES(42,'T-1',1,'done','P-foreign','result','old history',1,'stale',123);
    INSERT INTO reports VALUES(43,'deleted-task',1,'deleted','P-foreign','result','deleted history',1,'stale',123);
    DELETE FROM reports WHERE id=43;
  `);
  legacy.close();
  const migrated = openDb(file, { backupDir });
  try {
    assert.equal(Number(migrated.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
    assert.equal(migrated.prepare('SELECT body FROM reports WHERE id=42').get().body, 'old history');
    const insert = migrated.prepare("INSERT INTO reports(task_id,gen,report_id,participant,kind,created_at) VALUES('T-1',1,'done',?,'result',124)");
    insert.run('P-owner');
    assert.throws(() => insert.run('P-owner'), /UNIQUE/);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM reports').get().n, 2);
    assert.ok(migrated.prepare("SELECT id FROM reports WHERE participant='P-owner'").get().id > 43, 'deleted history IDs are not reused');
    assert.ok(fs.readdirSync(backupDir).some(name => name.startsWith('pre-migrate-v2-')));
  } finally { migrated.close(); }
});
