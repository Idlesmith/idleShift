import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.mjs';
import { Core, Refusal } from '../src/core.mjs';
import { joinAs, facilitate, done } from './helpers.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotepath=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

function makeTempGitRepo(tmpRoot, name = 'repo') {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(dir, 'README.md'), 'init\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'initial');
  return dir;
}

test('B-2: concurrent writes tasks get isolated git worktrees without touching main repo', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-b2-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const repo = makeTempGitRepo(tmp, 'repo');
  // Leave an uncommitted change in main repo: must not block claim and must not be carried into worktree
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'human wip\n');

  const db = openDb(':memory:');
  const core = new Core(db, { home });
  const pid = core.createProject({ name: 'git-test' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, {
    title: 'B2 test',
    delegation: { research: 'allow', write_files: 'allow', run_code: 'allow' }
  }).id;
  core.tick();

  const pA = joinAs(core, repo, 'worker-a', 'c-a');
  const pB = joinAs(core, repo, 'worker-b', 'c-b');

  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', title: 'write-1', body: 'w1', role: 'implement', mode: 'writes', tier: 'any' },
    { op: 'add_task', title: 'write-2', body: 'w2', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const t1 = planned.created[0].task;
  const t2 = planned.created[1].task;

  const oA = await core.next({ participant: pA, wait_seconds: 0 });
  const oB = await core.next({ participant: pB, wait_seconds: 0 });
  assert.equal(oA.kind, 'offer');
  assert.equal(oB.kind, 'offer');

  const a1 = core.claim({ participant: pA, task: oA.task, gen: oA.gen });
  const a2 = core.claim({ participant: pB, task: oB.task, gen: oB.gen });

  const ws1 = a1.assignment.program.workspace;
  const ws2 = a2.assignment.program.workspace;
  assert.equal(ws1.kind, 'git_worktree');
  assert.equal(ws2.kind, 'git_worktree');
  assert.notEqual(ws1.path, ws2.path);
  assert.ok(ws1.path.startsWith(path.join(home, 'worktrees', pid)));
  assert.ok(ws2.path.startsWith(path.join(home, 'worktrees', pid)));
  assert.equal(ws1.branch, `idleshift/${oA.task}`);
  assert.equal(ws2.branch, `idleshift/${oB.task}`);
  assert.equal(ws1.target_branch, 'main');
  assert.ok(ws1.rules.some(r => r.includes('uncommitted') || r.includes('未コミット')));
  assert.equal(fs.existsSync(path.join(ws1.path, 'dirty.txt')), false);

  // Both workers write the same filename in their respective worktrees
  fs.writeFileSync(path.join(ws1.path, 'shared.txt'), 'from-A\n');
  git(ws1.path, 'add', 'shared.txt');
  git(ws1.path, 'commit', '-m', 'A work');

  fs.writeFileSync(path.join(ws2.path, 'shared.txt'), 'from-B\n');
  git(ws2.path, 'add', 'shared.txt');
  git(ws2.path, 'commit', '-m', 'B work');

  assert.equal(fs.readFileSync(path.join(ws1.path, 'shared.txt'), 'utf8'), 'from-A\n');
  assert.equal(fs.readFileSync(path.join(ws2.path, 'shared.txt'), 'utf8'), 'from-B\n');
  assert.equal(fs.existsSync(path.join(repo, 'shared.txt')), false);
  assert.equal(fs.readFileSync(path.join(repo, 'dirty.txt'), 'utf8'), 'human wip\n');
  assert.equal(t1 !== t2, true);
});

test('B-2: non-git folder and git_isolation=off fall back to shared_root', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-nongit-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const plainDir = path.join(tmp, 'plain');
  fs.mkdirSync(plainDir, { recursive: true });
  const repo = makeTempGitRepo(tmp, 'repo');

  const db = openDb(':memory:');
  const core = new Core(db, { home });

  // Case 1: non-git folder
  const pid1 = core.createProject({ name: 'plain' }).id;
  core.addRoot(pid1, plainDir);
  const g1 = core.createGoal(pid1, { title: 'plain goal', delegation: { write_files: 'allow' } }).id;
  core.tick();
  const p1 = joinAs(core, plainDir, 'w1', 'c1');
  await facilitate(core, p1, g1, [
    { op: 'add_task', title: 'w-plain', body: 'b', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const o1 = await core.next({ participant: p1, wait_seconds: 0 });
  const a1 = core.claim({ participant: p1, task: o1.task, gen: o1.gen });
  assert.equal(a1.assignment.program.workspace.kind, 'shared_root');
  assert.equal(path.normalize(a1.assignment.program.workspace.path).toLowerCase(), path.normalize(fs.realpathSync.native(plainDir)).toLowerCase());

  // Case 2: git repo with git_isolation='off'
  const pid2 = core.createProject({ name: 'off' }).id;
  core.addRoot(pid2, repo);
  const g2 = core.createGoal(pid2, { title: 'off goal', delegation: { write_files: 'allow' }, git_isolation: 'off' }).id;
  core.tick();
  const p2 = joinAs(core, repo, 'w2', 'c2');
  await facilitate(core, p2, g2, [
    { op: 'add_task', title: 'w-off', body: 'b', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const o2 = await core.next({ participant: p2, wait_seconds: 0 });
  const a2 = core.claim({ participant: p2, task: o2.task, gen: o2.gen });
  assert.equal(a2.assignment.program.workspace.kind, 'shared_root');
});

test('B-2: reassignment inherits worktree, cancel cleans empty vs keeps committed, restart persists', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-reopen-'));
  let db;
  t.after(() => {
    try { db?.close(); } catch { /* already closed */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const repo = makeTempGitRepo(tmp, 'repo');
  const dbPath = path.join(home, 'idleshift.db');

  db = openDb(dbPath);
  let core = new Core(db, { home });
  const pid = core.createProject({ name: 'persist' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: 'persist goal', delegation: { write_files: 'allow', research: 'allow' } }).id;
  core.tick();

  const pA = joinAs(core, repo, 'a', 'ca');
  const pB = joinAs(core, repo, 'b', 'cb');
  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', title: 'reopen-task', body: 'b1', role: 'implement', mode: 'writes', tier: 'any' },
    { op: 'add_task', title: 'cancel-empty', body: 'b2', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const tReopen = planned.created[0].task;
  const tCancelEmpty = planned.created[1].task;

  // pA claims tReopen, makes a commit + uncommitted file
  const o1 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o1.task, tReopen);
  const a1 = core.claim({ participant: pA, task: tReopen, gen: o1.gen });
  const wtPath = a1.assignment.program.workspace.path;
  fs.writeFileSync(path.join(wtPath, 'committed.txt'), 'v1\n');
  git(wtPath, 'add', 'committed.txt');
  git(wtPath, 'commit', '-m', 'part 1');
  fs.writeFileSync(path.join(wtPath, 'wip.txt'), 'uncommitted\n');

  // pB claims tCancelEmpty, leaves it clean, and declines so it becomes open and cancellable
  const o2 = await core.next({ participant: pB, wait_seconds: 0 });
  assert.equal(o2.task, tCancelEmpty);
  const a2 = core.claim({ participant: pB, task: tCancelEmpty, gen: o2.gen });
  const wtEmpty = a2.assignment.program.workspace.path;
  assert.equal(fs.existsSync(wtEmpty), true);
  core.report({ participant: pB, task: tCancelEmpty, gen: o2.gen, report_id: 'dec-empty', kind: 'decline', body: 'not needed' });

  // Now pA declines tReopen so pB can take it after restart
  core.report({ participant: pA, task: tReopen, gen: o1.gen, report_id: 'dec-1', kind: 'decline', body: 'hand off' });

  // Restart service (close and reopen DB)
  db.close();
  db = openDb(dbPath);
  core = new Core(db, { home });

  // pB can now claim tReopen (gen+1) and inherits the same worktree + commit + wip file
  const o1b = await core.next({ participant: pB, wait_seconds: 0 });
  assert.equal(o1b.task, tReopen);
  const a1b = core.claim({ participant: pB, task: tReopen, gen: o1b.gen });
  assert.equal(a1b.assignment.program.workspace.path, wtPath);
  assert.equal(fs.readFileSync(path.join(wtPath, 'committed.txt'), 'utf8'), 'v1\n');
  assert.equal(fs.readFileSync(path.join(wtPath, 'wip.txt'), 'utf8'), 'uncommitted\n');

  // Reporting result with uncommitted file marks uncommitted=1
  done(core, pB, tReopen, o1b.gen);
  const wtRow = core.one('SELECT * FROM worktrees WHERE task_id=?', tReopen);
  assert.equal(wtRow.state, 'active');
  assert.equal(wtRow.uncommitted, 1);

  // Cancel tCancelEmpty (empty worktree) -> removed automatically
  core.plan({
    participant: pA, goal: gid, base_version: core.goal(gid).plan_version,
    ops: [{ op: 'cancel_task', task: tCancelEmpty, reason: 'not needed' }]
  });
  assert.equal(fs.existsSync(wtEmpty), false);
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', tCancelEmpty).state, 'discarded');
});

test('B-2: refuses claim when unrecorded idleshift/<task> branch already exists', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-branch-conflict-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const repo = makeTempGitRepo(tmp, 'repo');

  const db = openDb(':memory:');
  const core = new Core(db, { home });
  const pid = core.createProject({ name: 'conflict' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: 'conflict goal', delegation: { write_files: 'allow' } }).id;
  core.tick();

  const pA = joinAs(core, repo, 'a', 'ca');
  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', title: 'conflict-task', body: 'b', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const tId = planned.created[0].task;

  // Create branch idleshift/<tId> manually outside IdleShift
  git(repo, 'branch', `idleshift/${tId}`);

  const offer = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(offer.task, tId);
  assert.throws(() => core.claim({ participant: pA, task: tId, gen: offer.gen }), Refusal);
  assert.equal(core.task(tId).state, 'open');
});

test('B-2: review_workspace, depends_on waits for merge, cleanupWorktrees and listOrphanWorktrees', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-cleanup-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const repo = makeTempGitRepo(tmp, 'repo');
  const db = openDb(':memory:');
  const core = new Core(db, { home });
  const pid = core.createProject({ name: 'dep-test' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: 'dep goal', delegation: { research: 'allow', write_files: 'allow' } }).id;
  core.tick();

  const pA = joinAs(core, repo, 'a', 'ca');
  const pB = joinAs(core, repo, 'b', 'cb');
  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', ref: 'w1', title: 'step-1', body: 'b1', role: 'implement', mode: 'writes', tier: 'any', review: true },
    { op: 'add_task', title: 'step-2', body: 'b2', role: 'implement', mode: 'writes', tier: 'any', depends_on: ['w1'] }
  ]);
  const t1 = planned.created[0].task;
  const t2 = planned.created[1].task;

  // pA completes t1 with a commit
  const o1 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o1.task, t1);
  const a1 = core.claim({ participant: pA, task: t1, gen: o1.gen });
  const wtPath = a1.assignment.program.workspace.path;
  fs.writeFileSync(path.join(wtPath, 'step1.txt'), 'done\n');
  git(wtPath, 'add', 'step1.txt');
  git(wtPath, 'commit', '-m', 'step1');
  done(core, pA, t1, o1.gen);

  // pB gets the auto-created review task with review_workspace
  const oRev = await core.next({ participant: pB, wait_seconds: 0 });
  assert.equal(oRev.task_kind, 'review');
  const aRev = core.claim({ participant: pB, task: oRev.task, gen: oRev.gen });
  assert.equal(aRev.assignment.program.review_workspace.branch, `idleshift/${t1}`);
  assert.equal(aRev.assignment.program.review_workspace.commit_count, 1);
  assert.match(aRev.assignment.program.review_workspace.diff_stat, /step1\.txt/);
  core.report({ participant: pB, task: oRev.task, gen: oRev.gen, report_id: 'rev-ok', kind: 'result', verdict: 'accept', body: 'ok' });

  // t1 is accepted, but its worktree is still active (unmerged) -> t2 must wait!
  assert.equal(core.task(t1).state, 'accepted');
  assert.equal((await core.next({ participant: pA, wait_seconds: 0 })).kind, 'none');

  // Simulate merge by marking worktree merged -> t2 becomes offerable
  core.run("UPDATE worktrees SET state='merged' WHERE task_id=?", t1);
  const o2 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o2.kind, 'offer');
  assert.equal(o2.task, t2);

  // Orphan folder detection + missing folder cleanup
  const orphanDir = path.join(home, 'worktrees', pid, 'T-999');
  fs.mkdirSync(orphanDir, { recursive: true });
  const orphans = core.listOrphanWorktrees();
  assert.equal(orphans.some(o => o.task_id === 'T-999'), true);
  assert.equal(fs.existsSync(orphanDir), true); // never auto-deleted

  fs.rmSync(wtPath, { recursive: true, force: true });
  core.run("UPDATE worktrees SET state='active' WHERE task_id=?", t1);
  core.cleanupWorktrees();
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', t1).state, 'missing');
});
