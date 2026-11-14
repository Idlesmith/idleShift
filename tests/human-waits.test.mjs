import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.mjs';
import { Core } from '../src/core.mjs';
import { makeCore, seed, joinAs, facilitate, done } from './helpers.mjs';

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

test('humanWaits: detects unmerged worktree, pending decision, and done_candidate; next immediate/timeout none include reason & waiting_on in en/ja', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-hw-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const home = path.join(tmp, 'home');
  const repo = makeTempGitRepo(tmp, 'repo');
  const db = openDb(':memory:');
  const core = new Core(db, { home });
  const pid = core.createProject({ name: 'hw-test' }).id;
  core.addRoot(pid, repo);
  const gid = core.createGoal(pid, {
    title: 'HW test',
    delegation: { research: 'allow', write_files: 'allow', run_code: 'allow' }
  }).id;
  core.tick();

  const pA = joinAs(core, repo, 'worker-a', 'c-a');
  const pB = joinAs(core, repo, 'worker-b', 'c-b');

  // Create T-1 (writes) and T-2 (writes, depends on T-1)
  const { planned } = await facilitate(core, pA, gid, [
    { op: 'add_task', title: 'write-1', body: 'w1', role: 'implement', mode: 'writes', tier: 'any', ref: 'w1' },
    { op: 'add_task', title: 'write-2', body: 'w2', role: 'implement', mode: 'writes', tier: 'any', depends_on: ['w1'] }
  ]);
  const t1 = planned.created[0].task;

  const o1 = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(o1.kind, 'offer');
  assert.equal(o1.task, t1);
  const c1 = core.claim({ participant: pA, task: t1, gen: o1.gen });
  const wtPath = c1.assignment.program.workspace.path;
  fs.writeFileSync(path.join(wtPath, 'a.txt'), 'hello\n');
  git(wtPath, 'add', 'a.txt');
  git(wtPath, 'commit', '-m', 'add a');
  core.report({ participant: pA, task: t1, gen: o1.gen, report_id: 'r1', kind: 'result', summary: 'done', body: 'done' });

  // Now T-1 is accepted & unmerged, T-2 is open & blocked on T-1 merge
  const waits = core.humanWaits(pid);
  assert.deepEqual(waits, [{ kind: 'merge', task: t1 }]);

  // Immediate none in en
  core.setLanguages({ ai_language: 'en' });
  const nEn = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(nEn.kind, 'none');
  assert.deepEqual(nEn.waiting_on, [{ kind: 'merge', task: t1 }]);
  assert.match(nEn.reason, new RegExp(`merge ${t1}`));

  // Immediate none in ja
  core.setLanguages({ ai_language: 'ja' });
  const nJa = await core.next({ participant: pA, wait_seconds: 0 });
  assert.equal(nJa.kind, 'none');
  assert.deepEqual(nJa.waiting_on, [{ kind: 'merge', task: t1 }]);
  assert.match(nJa.reason, new RegExp(`${t1} のマージ`));

  // Snapshot includes human_waits
  const snap = core.snapshot();
  assert.deepEqual(snap.projects[0].human_waits, [{ kind: 'merge', task: t1 }]);

  // Timeout none includes reason & waiting_on
  core.holdFor = () => 30;
  const nTimeout = await core.next({ participant: pA, wait_seconds: 5 });
  assert.equal(nTimeout.kind, 'none');
  assert.equal(nTimeout.again, true);
  assert.deepEqual(nTimeout.waiting_on, [{ kind: 'merge', task: t1 }]);
  assert.match(nTimeout.reason, new RegExp(`${t1} のマージ`));
});

test('humanWaits: pending decision and done_candidate + notify once per unchanged state', async () => {
  const { core } = makeCore();
  const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'worker', 'c-1');
  const notifications = [];
  core.on('notify', n => { if (n.kind === 'human_wait') notifications.push(n); });
  core.setLanguages({ ui_language: 'ja' });

  // Raise a pending budget decision (puts goal in waiting_decision, so 0 offerable tasks remain) -> notifies once with D-ID
  const decision = core.raiseDecision({ project, goal, kind: 'budget', messageKey: 'decision.budget', messageArgs: [1, 1], options: ['extend', 'stop'] });
  core.settle();
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].body, new RegExp(`判断 ${decision}`));

  // Calling settle/tick again with same waits does NOT re-notify
  core.settle();
  core.tick();
  assert.equal(notifications.length, 1);

  const waits1 = core.humanWaits(project);
  assert.deepEqual(waits1, [{ kind: 'decision', decision, goal }]);

  // Answer decision to reactivate, then propose_done -> adds done_candidate + done decision, changing waits -> notifies once more with G-ID & D-ID
  core.answerDecision(decision, 'extend');
  core.setLanguages({ ui_language: 'en' });
  core.plan({ participant: p, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'propose_done', evidence: 'all done' }] });
  core.settle();
  assert.equal(notifications.length, 2);
  assert.match(notifications[1].body, new RegExp(`confirm done ${goal}`));

  const waits2 = core.humanWaits(project);
  assert.ok(waits2.some(w => w.kind === 'done_candidate' && w.goal === goal));
  assert.ok(waits2.some(w => w.kind === 'decision'));

  const n = await core.next({ participant: p, wait_seconds: 0 });
  assert.equal(n.kind, 'none');
  assert.ok(n.waiting_on.length >= 2);
});
