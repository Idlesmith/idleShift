import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';
import { makeCore, seed, joinAs, take, tmpDir } from './helpers.mjs';

async function setup() {
  const state = makeCore();
  const seeded = seed(state.core);
  const a = joinAs(state.core, seeded.root, 'worker', 'a');
  const b = joinAs(state.core, seeded.root, 'other', 'b');
  const work = await take(state.core, a);
  const report = (kind, id = kind, participant = a) => state.core.report({ participant, task: work.task, gen: work.gen, kind, report_id: id, body: 'test' });
  return { ...state, ...seeded, a, b, work, report };
}

test('v4: first claim counts once; progress, own re-claim, stale and duplicate reports do not count again', async () => {
  const { core, clock, advance, project, a, b, work, report } = await setup();
  assert.equal(core.usageView(project).find(x => x.label === 'worker').used.claims_5h, 1);
  core.claim({ participant: a, task: work.task, gen: work.gen });
  advance(30_000);
  report('progress');
  report('result', 'foreign', b);
  assert.equal(core.one('SELECT ended_at FROM usage_log WHERE participant=?', a).ended_at, null);
  advance(60_000);
  report('result');
  const ended = core.one('SELECT * FROM usage_log WHERE participant=?', a);
  assert.equal(ended.ended_at, clock.t);
  advance(60_000);
  report('result');
  const view = core.usageView(project).find(x => x.label === 'worker');
  assert.deepEqual(view.used, { claims_5h: 1, minutes_5h: 2, claims_7d: 1, minutes_7d: 2 });
  assert.equal(core.one('SELECT COUNT(*) AS n FROM usage_log').n, 1);
  assert.equal(core.one('SELECT ended_at FROM usage_log WHERE participant=?', a).ended_at, ended.ended_at);
});

test('v4: join resume changes generation but retains one usage interval until the final report', async () => {
  const { core, advance, root, project, a, work } = await setup();
  advance(90_000);
  core.connClosed('a'); core.connOpened('new-a');
  const resumed = core.join({ root, label: 'worker' }, { conn: 'new-a', client: { name: 'worker' } });
  assert.equal(resumed.participant, a);
  const gen = core.task(work.task).gen;
  assert.ok(gen > work.gen);
  core.claim({ participant: a, task: work.task, gen });
  core.report({ participant: a, task: work.task, gen, kind: 'result', report_id: 'new-generation' });
  assert.equal(core.one('SELECT COUNT(*) AS n FROM usage_log').n, 1);
  assert.equal(core.usageView(project).find(x => x.label === 'worker').used.minutes_5h, 2);
  assert.notEqual(core.one('SELECT ended_at FROM usage_log').ended_at, null);
});

for (const kind of ['decline', 'blocked', 'decision_needed', 'limit']) {
  test(`v4: ${kind} ends the measured interval`, async () => {
    const { core, advance, clock, report } = await setup();
    advance(1000);
    report(kind);
    const row = core.one('SELECT * FROM usage_log');
    assert.equal(row.ended_at, clock.t);
    assert.equal(row.outcome, kind);
  });
}

test('v4: releasing and revoking a holder closes its active interval', async () => {
  const { core, advance, clock, a, work } = await setup();
  advance(1000);
  core.revokeParticipant(a);
  assert.equal(core.one('SELECT ended_at FROM usage_log').ended_at, clock.t);
  assert.equal(core.one('SELECT outcome FROM usage_log').outcome, 'released');
  assert.equal(core.task(work.task).state, 'open');
});

test('v4: rolling windows exclude the exact left boundary and aggregate time before rounding', async () => {
  const { core, advance, project, a, work, report } = await setup();
  advance(20_000); report('result');
  const first = core.one('SELECT * FROM usage_log');
  core.recordClaimUsage({ ...core.task(work.task), id: 'synthetic-second', gen: 1 }, core.one('SELECT * FROM participants WHERE id=?', a));
  advance(20_000);
  core.endUsage({ id: 'synthetic-second', assignee: a }, 'result');
  assert.equal(core.usageView(project).find(x => x.label === 'worker').used.minutes_5h, 1);
  advance(5 * 3600_000 - 40_000);
  let used = core.usageView(project).find(x => x.label === 'worker').used;
  assert.equal(used.claims_5h, 1);
  assert.equal(used.claims_7d, 2);
  advance(7 * 86400_000 - 5 * 3600_000);
  used = core.usageView(project).find(x => x.label === 'worker').used;
  assert.equal(used.claims_7d, 1);
  assert.ok(first.claimed_at < core.now());
});

test('v4: label profile and usage survive reconnect and remain isolated by project', async () => {
  const { core, root, project, a, work } = await setup();
  core.run("INSERT INTO participant_profiles(project_id,label,tier,limit_5h_claims,updated_at) VALUES(?,?,'senior',1,?)", project, 'worker', core.now());
  assert.equal(core.profile(project, 'worker').tier, 'senior');
  assert.ok(core.usageBlock(project, 'worker'));
  core.connClosed('a'); core.connOpened('new');
  core.join({ root, label: 'worker' }, { conn: 'new', client: { name: 'worker' } });
  assert.equal(core.profile(project, 'worker').tier, 'senior');
  assert.equal(core.one('SELECT COUNT(*) AS n FROM usage_log WHERE participant=?', a).n, 1);
  const other = core.createProject({ name: 'other' }).id;
  assert.equal(core.profile(other, 'worker').tier, null);
  assert.equal(core.usageBlock(other, 'worker'), null);
  assert.equal(core.task(work.task).assignee, a);
});

test('v4: each count/time limit uses >=, reports the actual recovery boundary, and has no default limit', async () => {
  const { core, clock, advance, project, a, report } = await setup();
  assert.equal(core.usageBlock(project, 'worker'), null);
  const started = clock.t;
  advance(60_000); report('result');
  for (const field of ['limit_5h_claims', 'limit_5h_minutes', 'limit_7d_claims', 'limit_7d_minutes']) {
    core.run('DELETE FROM participant_profiles');
    core.run(`INSERT INTO participant_profiles(project_id,label,${field},updated_at) VALUES(?,?,1,?)`, project, 'worker', clock.t);
    const block = core.usageBlock(project, 'worker');
    assert.ok(block, field);
    assert.equal(block.until, started + (field.includes('5h') ? 5 * 3600_000 : 7 * 86400_000));
    assert.ok(core.usageView(project).find(x => x.label === 'worker').blocked);
  }
  assert.equal(core.one('SELECT COUNT(*) n FROM usage_log WHERE participant=?', a).n, 1);
});

test('v4: restore closes rolled-back active usage and does not attach it to a new generation', async () => {
  const { core, advance, clock, work } = await setup();
  advance(61_000);
  core.invalidateAfterRestore(core.watermark());
  assert.equal(core.one('SELECT ended_at FROM usage_log').ended_at, clock.t);
  assert.equal(core.one('SELECT outcome FROM usage_log').outcome, 'released');
  assert.ok(core.task(work.task).gen > work.gen);
});

test('v4: v3 migration backs up and retains data with any/default policy and no profiles', () => {
  const dir = tmpDir('v4-migrate'); const file = path.join(dir, 'legacy.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','3'); CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES('T-old'); CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('PRJ-old');");
  db.close();
  const next = openDb(file, { backupDir: path.join(dir, 'backups') });
  try {
    assert.equal(next.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(SCHEMA_VERSION));
    assert.equal(next.prepare('SELECT tier FROM tasks').get().tier, 'any');
    assert.equal(next.prepare('SELECT senior_review FROM tasks').get().senior_review, 0);
    assert.equal(next.prepare('SELECT tier_policy FROM projects').get().tier_policy, '{}');
    assert.equal(next.prepare('SELECT COUNT(*) n FROM participant_profiles').get().n, 0);
    assert.equal(next.prepare('SELECT COUNT(*) n FROM usage_log').get().n, 0);
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).some(x => x.startsWith('pre-migrate-v3-')));
  } finally { next.close(); }
});
