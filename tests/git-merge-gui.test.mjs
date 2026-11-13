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

test('B-3: mergeTaskWorktree success, dirty rejection, conflict rejection, discardTaskWorktree', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-b3-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const repo = makeTempGitRepo(tmp, 'repo');

  const db = openDb(':memory:');
  const core = new Core(db, { home });
  const pid = core.createProject({ name: 'b3-test' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: 'b3 goal', delegation: { write_files: 'allow', research: 'allow' } }).id;
  core.tick();

  const pA = joinAs(core, repo, 'wA', 'cA');
  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', title: 'task-merge', body: 'b1', role: 'implement', mode: 'writes', tier: 'any' },
    { op: 'add_task', title: 'task-conflict', body: 'b2', role: 'implement', mode: 'writes', tier: 'any' },
    { op: 'add_task', title: 'task-discard', body: 'b3', role: 'implement', mode: 'writes', tier: 'any' }
  ]);
  const tMerge = planned.created[0].task;
  const tConflict = planned.created[1].task;
  const tDiscard = planned.created[2].task;

  // 1. Successful merge
  const o1 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o1.task, tMerge);
  const a1 = core.claim({ participant: pA, task: tMerge, gen: o1.gen });
  const wt1 = a1.assignment.program.workspace.path;
  fs.writeFileSync(path.join(wt1, 'feature.txt'), 'feature-content\n');
  git(wt1, 'add', 'feature.txt');
  git(wt1, 'commit', '-m', 'add feature');
  // Report as review: true or non-accepted first to verify accepted-only guard
  core.run("UPDATE tasks SET state='reported' WHERE id=?", tMerge);

  // Must be accepted first
  assert.throws(() => core.mergeTaskWorktree(tMerge), /accepted/);
  core.run("UPDATE tasks SET state='accepted' WHERE id=?", tMerge);

  // Task detail exposes worktree diff stats
  const detail1 = core.taskDetail(tMerge);
  assert.equal(detail1.worktree.commit_count, 1);
  assert.match(detail1.worktree.diff_stat, /feature\.txt/);

  // Dirty main repo rejects merge with file list
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'human dirty\n');
  assert.throws(() => core.mergeTaskWorktree(tMerge), err => {
    return err instanceof Refusal && err.code === 'repo_dirty' && err.message.includes('dirty.txt');
  });

  // Verify multiple dirty files (more than 10 files) displays count and overflow text
  for (let i = 1; i <= 12; i++) {
    fs.writeFileSync(path.join(repo, `dirty_${String(i).padStart(2, '0')}.txt`), `dirty ${i}\n`);
  }
  assert.throws(() => core.mergeTaskWorktree(tMerge), err => {
    return err instanceof Refusal && err.code === 'repo_dirty' && err.message.includes('他 3 件') && err.message.includes('dirty_01.txt');
  });
  // Cleanup dirty files
  fs.rmSync(path.join(repo, 'dirty.txt'));
  for (let i = 1; i <= 12; i++) {
    fs.rmSync(path.join(repo, `dirty_${String(i).padStart(2, '0')}.txt`));
  }

  // Now merge succeeds
  const mRes = core.mergeTaskWorktree(tMerge);
  assert.equal(mRes.ok, true);
  assert.equal(fs.existsSync(path.join(repo, 'feature.txt')), true);
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', tMerge).state, 'merged');
  assert.equal(fs.existsSync(wt1), false);

  // 2. Conflict rejection
  const o2 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o2.task, tConflict);
  const a2 = core.claim({ participant: pA, task: tConflict, gen: o2.gen });
  const wt2 = a2.assignment.program.workspace.path;
  // Conflict change on feature.txt in worktree
  fs.writeFileSync(path.join(wt2, 'feature.txt'), 'from-worktree\n');
  git(wt2, 'add', 'feature.txt');
  git(wt2, 'commit', '-m', 'conflict commit in wt');
  core.run("UPDATE tasks SET state='accepted' WHERE id=?", tConflict);

  // Change feature.txt in main repo
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'from-main-human\n');
  git(repo, 'add', 'feature.txt');
  git(repo, 'commit', '-m', 'human update');

  assert.throws(() => core.mergeTaskWorktree(tConflict), err => {
    return err instanceof Refusal && err.code === 'merge_conflict' && err.message.includes('feature.txt');
  });
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', tConflict).state, 'active');
  assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'from-main-human\n'); // main unchanged

  // 3. Discard worktree
  const o3 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o3.task, tDiscard);
  const a3 = core.claim({ participant: pA, task: tDiscard, gen: o3.gen });
  const wt3 = a3.assignment.program.workspace.path;
  fs.writeFileSync(path.join(wt3, 'discard.txt'), 'discard\n');
  git(wt3, 'add', 'discard.txt');
  git(wt3, 'commit', '-m', 'discard commit');
  core.run("UPDATE tasks SET state='accepted' WHERE id=?", tDiscard);

  const dRes = core.discardTaskWorktree(tDiscard);
  assert.equal(dRes.ok, true);
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', tDiscard).state, 'discarded');
  assert.equal(fs.existsSync(wt3), false);
  assert.equal(fs.existsSync(path.join(repo, 'discard.txt')), false);
});

test('B-6: merge is refused when the main working tree is on a different branch, and nothing changes', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-b6-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = makeTempGitRepo(tmp, 'repo');
  const core = new Core(openDb(':memory:'), { home: path.join(tmp, 'home') });
  const pid = core.createProject({ name: 'b6' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: 'b6', delegation: { write_files: 'allow', research: 'allow' } }).id;
  core.tick();
  const pA = joinAs(core, repo, 'wA', 'cA');
  const { planned } = await facilitate(core, pA, gid, [{ op: 'add_task', title: 'tm', body: 'b', role: 'implement', mode: 'writes', tier: 'any' }]);
  const task = planned.created[0].task;
  const o = await core.next({ participant: pA, wait_seconds: 0 });
  const wt = core.claim({ participant: pA, task, gen: o.gen }).assignment.program.workspace.path;
  fs.writeFileSync(path.join(wt, 'f.txt'), 'x\n');
  git(wt, 'add', 'f.txt');
  git(wt, 'commit', '-m', 'f');
  core.run("UPDATE tasks SET state='accepted' WHERE id=?", task);

  git(repo, 'checkout', '-b', 'other');
  const headBefore = git(repo, 'rev-parse', 'HEAD');
  assert.throws(() => core.mergeTaskWorktree(task), err => err instanceof Refusal && err.code === 'branch_mismatch');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(git(repo, 'symbolic-ref', '--short', 'HEAD'), 'other');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', task).state, 'active');
});
