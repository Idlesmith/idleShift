import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.mjs';
import { Core, Refusal } from '../src/core.mjs';
import { joinAs, facilitate } from './helpers.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function setup(t, name, n = 1) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `idleshift-${name}-`));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test User');
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n'); git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
  const core = new Core(openDb(':memory:'), { home: path.join(tmp, 'home') });
  const pid = core.createProject({ name }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, { title: name, delegation: { write_files: 'allow', research: 'allow' } }).id;
  core.tick();
  const p = joinAs(core, repo, 'wA', 'cA');
  const ops = Array.from({ length: n }, (_, i) => ({ op: 'add_task', title: `t${i}`, body: 'b', role: 'implement', mode: 'writes', tier: 'any' }));
  const { planned } = await facilitate(core, p, gid, ops);
  return { tmp, repo, core, p, tasks: planned.created.map(c => c.task) };
}

async function claimAndCommit(core, p, task, file) {
  const o = await core.next({ participant: p, wait_seconds: 0 });
  assert.equal(o.task, task);
  const a = core.claim({ participant: p, task, gen: o.gen });
  const ws = a.assignment.program.workspace;
  fs.writeFileSync(path.join(ws.path, file), 'x\n'); git(ws.path, 'add', file); git(ws.path, 'commit', '-m', file);
  core.run("UPDATE tasks SET state='accepted' WHERE id=?", task);
  return ws;
}

test('T-332: merge/discard cleanup failure is recorded in last_error, event and return value', async t => {
  const { tmp, core, p, tasks } = await setup(t, 'cleanup', 2);
  const bogus = path.join(tmp, 'not-a-worktree'); fs.mkdirSync(bogus);

  await claimAndCommit(core, p, tasks[0], 'a.txt');
  core.run('UPDATE worktrees SET path=? WHERE task_id=?', bogus, tasks[0]);
  const r = core.mergeTaskWorktree(tasks[0]);
  assert.equal(r.ok, true);
  assert.ok(r.cleanup_error, 'cleanup_error returned');
  assert.ok(r.warning);
  const row = core.one('SELECT state, last_error FROM worktrees WHERE task_id=?', tasks[0]);
  assert.equal(row.state, 'merged');
  assert.ok(row.last_error);
  assert.equal(core.taskDetail(tasks[0]).worktree.last_error, row.last_error);
  const ev = core.one("SELECT data FROM events WHERE type='worktree_merged' AND task_id=?", tasks[0]);
  assert.match(ev.data, /cleanup_error/);

  await claimAndCommit(core, p, tasks[1], 'b.txt');
  core.run('UPDATE worktrees SET path=? WHERE task_id=?', bogus, tasks[1]);
  const d = core.discardTaskWorktree(tasks[1]);
  assert.ok(d.cleanup_error);
  const row2 = core.one('SELECT state, last_error FROM worktrees WHERE task_id=?', tasks[1]);
  assert.equal(row2.state, 'discarded');
  assert.ok(row2.last_error);
});

test('T-332: successful merge leaves last_error empty and no warning', async t => {
  const { core, p, tasks } = await setup(t, 'cleanok');
  await claimAndCommit(core, p, tasks[0], 'a.txt');
  const r = core.mergeTaskWorktree(tasks[0]);
  assert.equal(r.cleanup_error, undefined);
  assert.equal(core.one('SELECT last_error FROM worktrees WHERE task_id=?', tasks[0]).last_error, '');
});

test('T-332: merge is refused with detached_head when main is detached, nothing changes', async t => {
  const { repo, core, p, tasks } = await setup(t, 'detmerge');
  await claimAndCommit(core, p, tasks[0], 'a.txt');
  git(repo, 'checkout', '--detach');
  const head = git(repo, 'rev-parse', 'HEAD');
  assert.throws(() => core.mergeTaskWorktree(tasks[0]), e => e instanceof Refusal && e.code === 'detached_head');
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
  assert.equal(core.one('SELECT state FROM worktrees WHERE task_id=?', tasks[0]).state, 'active');
});

test('T-332: claim on detached main records target_branch=null, warns, and merges into the branch checked out later', async t => {
  const { repo, core, p, tasks } = await setup(t, 'detclaim');
  git(repo, 'checkout', '--detach');
  const ws = await claimAndCommit(core, p, tasks[0], 'a.txt');
  assert.equal(ws.target_branch, null);
  assert.ok(ws.rules.some(r => /detached HEAD/.test(r)));
  git(repo, 'checkout', 'main');
  const r = core.mergeTaskWorktree(tasks[0]);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')));
});
