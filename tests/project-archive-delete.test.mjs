import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';
import { makeCore, seed, joinAs, tmpDir } from './helpers.mjs';

const refuses = (fn, code) => assert.throws(fn, e => e.code === code);

function empty() {
  const state = makeCore();
  const project = state.core.createProject({ name: 'empty project' }).id;
  const root = tmpDir('archive-delete-root');
  state.core.addRoot(project, root);
  return { ...state, project, root };
}

test('delete: empty project removes only its roots, profiles and longest-owned folder requests', () => {
  const { core, project, root } = empty();
  const other = core.createProject({ name: 'other' }).id;
  const nested = path.join(root, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  core.addRoot(other, nested);
  const requested = [root, path.join(root, 'child'), path.join(nested, 'child'), root + '-similar-prefix', tmpDir('unrelated-root')];
  for (const dir of requested) core.run('INSERT INTO root_requests(path_norm,path_display,last_at) VALUES(?,?,?)', core.resolveRoot(dir).norm, dir, core.now());
  core.setProfile(project, 'unused', { tier: 'worker' });
  core.setClientJoinBlocked(project, 'app', true);
  core.setClientJoinBlocked(other, 'app', true);
  const marker = path.join(root, 'keep.txt'); fs.writeFileSync(marker, 'keep');
  refuses(() => core.deleteProject(project, 'wrong name'), 'confirm');
  assert.equal(core.deleteProject(project, 'empty project').ok, true);
  assert.equal(core.one('SELECT id FROM projects WHERE id=?', project), undefined);
  assert.equal(core.one('SELECT path_norm FROM roots WHERE project_id=?', project), undefined);
  assert.equal(core.one('SELECT label FROM participant_profiles WHERE project_id=?', project), undefined);
  assert.equal(core.meta(`client_join_block:${project}:app`), null);
  assert.ok(core.meta(`client_join_block:${other}:app`));
  assert.deepEqual(core.all('SELECT path_display FROM root_requests ORDER BY path_display').map(r => r.path_display), requested.slice(2).sort());
  assert.equal(core.resolveRoot(path.join(nested, 'child')).root.project_id, other);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
  assert.notEqual(core.createProject({ name: 'new' }).id, project);
});

test('delete: a storage failure rolls back roots, requests, profiles and project together', () => {
  const { core, project, root } = empty();
  core.setProfile(project, 'unused', { tier: 'worker' });
  const norm = core.resolveRoot(path.join(root, 'requested')).norm;
  core.run('INSERT INTO root_requests(path_norm,path_display,last_at) VALUES(?,?,?)', norm, norm, core.now());
  const before = JSON.stringify(core.snapshot());
  const run = core.run;
  core.run = function(sql, ...args) {
    if (sql === 'DELETE FROM projects WHERE id=?') throw new Error('injected storage failure');
    return run.call(this, sql, ...args);
  };
  try { assert.throws(() => core.deleteProject(project, 'empty project'), /injected storage failure/); }
  finally { core.run = run; }
  assert.equal(JSON.stringify(core.snapshot()), before);
  assert.ok(core.one('SELECT path_norm FROM root_requests WHERE path_norm=?', norm));
});

for (const kind of ['goal', 'participant', 'removed participant', 'task']) {
  test(`delete: refuses ${kind} history and preserves the whole project`, () => {
    const { core, project, root } = empty();
    if (kind === 'goal' || kind === 'task') {
      const goal = core.createGoal(project, { title: 'history', start: false }).id;
      if (kind === 'task') {
        core.addHumanTask(goal, { title: 'history task' });
        core.run('DELETE FROM goals WHERE id=?', goal); // independently test even orphaned task history
      }
    } else {
      const participant = joinAs(core, root, 'worker', 'c1');
      if (kind === 'removed participant') core.removeParticipant(participant);
    }
    const before = JSON.stringify(core.snapshot());
    refuses(() => core.deleteProject(project, 'empty project'), 'project_not_empty');
    assert.equal(JSON.stringify(core.snapshot()), before);
    assert.equal(core.snapshot().projects.find(p => p.id === project).can_delete, false);
  });
}

test('archive: keeps roots and history, stops distribution and resumes without changing stopped state', async () => {
  const { core } = makeCore(); const { root, project, goal } = seed(core);
  const participant = joinAs(core, root, 'worker', 'c1');
  const task = core.one('SELECT * FROM tasks WHERE goal_id=?', goal);
  const count = core.one('SELECT COUNT(*) n FROM tasks').n;
  core.setProjectArchived(project, true);
  const snapshot = core.snapshot().projects.find(p => p.id === project);
  assert.equal(snapshot.archived, true);
  assert.equal(snapshot.can_delete, false);
  assert.equal(core.header(core.one('SELECT * FROM participants WHERE id=?', participant), null).stop, true);
  refuses(() => core.join({ root, label: 'worker' }, { conn: 'c1', client: { name: 'worker' } }), 'project_archived');
  assert.equal((await core.next({ participant })).kind, 'stop');
  assert.equal(core.offerableCount(project), 0);
  assert.equal(core.offerableCount(project, 'worker'), 0);
  refuses(() => core.claim({ participant, task: task.id, gen: task.gen }), 'project_archived');
  refuses(() => core.plan({ participant, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'add_evidence', text: 'new' }] }), 'project_archived');
  refuses(() => core.createGoal(project, { title: 'new while archived' }), 'project_archived');
  refuses(() => core.addHumanTask(goal, { title: 'new while archived' }), 'project_archived');
  const other = core.createProject({ name: 'other' }).id;
  refuses(() => core.addRoot(other, root), 'root_taken');
  core.tick();
  assert.equal(core.one('SELECT COUNT(*) n FROM tasks').n, count);
  assert.equal(core.task(task.id).state, 'open');
  core.setProjectArchived(project, false);
  assert.equal(core.join({ root, label: 'worker' }, { conn: 'c1', client: { name: 'worker' } }).participant, participant);
  assert.equal((await core.next({ participant })).kind, 'offer');
  core.setProjectStop(project, true); // withdraw offer before archiving again
  core.setProjectArchived(project, true);
  core.setProjectArchived(project, false);
  assert.equal(core.project(project).stopped, 1);
});

for (const reset of ['recover', 'restore']) {
  test(`archive: next stops on a real connection after ${reset}, without binding that connection`, async () => {
    const { core, project, root } = empty();
    const participant = joinAs(core, root, 'worker', 'c1');
    core.setProjectArchived(project, true);
    if (reset === 'recover') core.recover(); else core.invalidateAfterRestore();
    const before = core.one('SELECT * FROM participants WHERE id=?', participant);
    const out = await core.next({ participant, wait_seconds: 3600 }, { conn: 'new-connection' });
    assert.equal(out.kind, 'stop');
    assert.equal(out.header, undefined); // an unbound caller gets no project contents
    assert.deepEqual(core.one('SELECT * FROM participants WHERE id=?', participant), before);
    assert.equal(core.waiters.size, 0);
    await assert.rejects(core.next({ participant: 'P-unknown' }, { conn: 'new-connection' }), e => e.code === 'unknown_participant');
    core.setProjectArchived(project, false);
    await assert.rejects(core.next({ participant }, { conn: 'new-connection' }), e => e.code === 'rejoin_required');
  });
}

test('archive: next retains live-connection, removed-ID and revocation protection', async () => {
  const { core, project, root } = empty();
  const participant = joinAs(core, root, 'worker', 'c1');
  core.setProjectArchived(project, true);
  await assert.rejects(core.next({ participant }, { conn: 'intruder' }), e => e.code === 'not_yours');
  core.run('UPDATE participants SET conn=NULL, revoked=1 WHERE id=?', participant);
  await assert.rejects(core.next({ participant }, { conn: 'intruder' }), e => e.code === 'revoked');
  core.meta(`participant_removed:${participant}`, 1);
  await assert.rejects(core.next({ participant }, { conn: 'intruder' }), e => e.code === 'unknown_participant');
});

test('archive: pending next is resolved with stop; idempotent operations and zero timestamps work', async t => {
  const { core, project, root, clock } = empty();
  const participant = joinAs(core, root, 'worker', 'c1');
  const pending = core.next({ participant, wait_seconds: 5 });
  t.after(() => core.resolveWaiter(participant, { kind: 'none' }, 'test-cleanup'));
  assert.equal(core.waiters.has(participant), true);
  clock.t = 0;
  core.setProjectArchived(project, true);
  assert.equal((await pending).kind, 'stop');
  assert.equal(core.snapshot().projects[0].archived, true);
  assert.equal(core.project(project).archived_at, 0);
  assert.equal(core.setProjectArchived(project, true).ok, true);
  assert.equal(core.setProjectArchived(project, false).ok, true);
  assert.equal(core.setProjectArchived(project, false).ok, true);
  refuses(() => core.setProjectArchived(project, 'false'), 'bad_input');
});

for (const state of ['offered', 'claimed', 'needs_check']) {
  test(`archive: ${state} task blocks archiving even after project stop`, async () => {
    const { core } = makeCore(); const { root, project } = seed(core);
    const participant = joinAs(core, root, 'worker', 'c1');
    const offer = await core.next({ participant });
    if (state !== 'offered') core.claim({ participant, task: offer.task, gen: offer.gen });
    if (state === 'needs_check') core.run("UPDATE tasks SET state='needs_check' WHERE id=?", offer.task);
    const before = core.task(offer.task);
    refuses(() => core.setProjectArchived(project, true), 'project_busy');
    assert.equal(core.project(project).archived_at, null);
    assert.deepEqual(core.task(offer.task), before);
    if (state !== 'offered') {
      core.setProjectStop(project, true);
      refuses(() => core.setProjectArchived(project, true), 'project_busy');
    }
  });
}

test('archive: pending human decision blocks it; resolving that decision permits archiving', () => {
  const { core, project } = empty();
  const decision = core.raiseDecision({ project, kind: 'question', question: 'choose', options: ['ok'] });
  refuses(() => core.setProjectArchived(project, true), 'project_busy');
  core.answerDecision(decision, 'ok');
  assert.equal(core.setProjectArchived(project, true).ok, true);
});

test('archive: tick does not create facilitators, deadline decisions or stalled notifications', () => {
  const { core, project, advance } = empty();
  const goal = core.createGoal(project, { title: 'active', budgets: { deadline: core.now() + 1000 } }).id;
  core.setProjectArchived(project, true);
  const tasks = core.one('SELECT COUNT(*) n FROM tasks').n;
  advance(180_000); core.tick(); core.checkStalled(core.now());
  assert.equal(core.one('SELECT COUNT(*) n FROM tasks').n, tasks);
  assert.equal(core.one("SELECT COUNT(*) n FROM decisions WHERE state='pending'").n, 0);
  assert.equal(core.goal(goal).status, 'active');
});

test('v5: migrating v4 backs up and retains existing projects with archived_at=NULL', () => {
  const dir = tmpDir('v5-archive-migrate'), file = path.join(dir, 'legacy.db');
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','4'); CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT); INSERT INTO projects VALUES('PRJ-1','keep');");
  legacy.close();
  let db = openDb(file, { backupDir: path.join(dir, 'backups') });
  assert.equal(Number(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT archived_at FROM projects').get().archived_at, null);
  assert.equal(db.prepare('SELECT name FROM projects').get().name, 'keep');
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some(name => name.startsWith('pre-migrate-v4-')));
  db.close(); db = openDb(file); db.close();
});
