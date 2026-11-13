// Review #7: a review written for an older submission must not accept a newer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, facilitate, done } from './helpers.mjs';

async function setup() {
  const env = makeCore();
  const { core } = env;
  const s = seed(core, { budgets: { max_parallel: 3 } });
  const a = joinAs(core, s.root, 'a', 'c1');
  const b = joinAs(core, s.root, 'b', 'c2');
  const c = joinAs(core, s.root, 'c', 'c3');
  await facilitate(core, c, s.goal, [{ op: 'add_task', title: '重要な作業', role: 'research', mode: 'read_only', review: true, prefer: 'a' }]);
  const w = await take(core, a);
  done(core, a, w.task, w.gen);                       // submission 1 -> review R1 created
  const r1 = await take(core, b);                     // B holds the review of submission 1
  assert.equal(r1.got.assignment.program.kind, 'review');
  return { ...env, ...s, a, b, c, w, r1 };
}

test('#7: an old accept arriving after rework and resubmission does not accept the new work', async () => {
  const { core, goal, a, b, c, w, r1 } = await setup();
  core.plan({ participant: c, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'rework', task: w.task, reason: '出典が足りない' }] });
  const w2 = await take(core, a);
  assert.equal(w2.task, w.task);
  done(core, a, w2.task, w2.gen);                     // submission 2 -> waits for a fresh review
  assert.equal(core.task(w.task).state, 'reported');
  core.report({ participant: b, task: r1.task, gen: r1.gen, report_id: 'old-accept', kind: 'result', verdict: 'accept', body: '提出1を確認' });
  assert.equal(core.task(w.task).state, 'reported', 'submission 2 still needs its own review');
  const fresh = core.all("SELECT * FROM tasks WHERE kind='review' AND parent_id=? AND state IN ('open','offered')", w.task);
  assert.equal(fresh.length, 1, 'a review for submission 2 is waiting');
});

test('#7: rework cancels the review still held for the old submission', async () => {
  const { core, goal, b, c, w, r1 } = await setup();
  core.plan({ participant: c, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'rework', task: w.task, reason: 'やり直し' }] });
  assert.equal(core.task(r1.task).state, 'cancelled');
  const late = core.report({ participant: b, task: r1.task, gen: r1.gen, report_id: 'late', kind: 'result', verdict: 'accept', body: 'x' });
  assert.equal(late.accepted, false);
  assert.equal(core.task(w.task).state, 'open');
});

test('#7: a matching review still works', async () => {
  const { core, b, w, r1 } = await setup();
  core.report({ participant: b, task: r1.task, gen: r1.gen, report_id: 'ok', kind: 'result', verdict: 'accept', body: '問題なし' });
  assert.equal(core.task(w.task).state, 'accepted');
});

test('#7 (rework 2): an old review parked on a question is voided by rework and cannot come back through the answer', async () => {
  const { core, goal, a, b, c, w, r1 } = await setup();
  core.report({ participant: b, task: r1.task, gen: r1.gen, report_id: 'q', kind: 'decision_needed', body: '判断基準は？' });
  assert.equal(core.task(r1.task).state, 'parked');
  core.plan({ participant: c, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'rework', task: w.task, reason: 'やり直し' }] });
  assert.equal(core.task(r1.task).state, 'cancelled');
  assert.equal(core.snapshot().decisions.filter(d => d.task_id === r1.task).length, 0, 'the question for the void review is closed');
  const w2 = await take(core, a);
  done(core, a, w2.task, w2.gen);
  const pendingOld = core.all("SELECT * FROM decisions WHERE task_id=?", r1.task)[0];
  assert.throws(() => core.answerDecision(pendingOld.id, 'continue'), /回答済み/);
  assert.equal(core.task(w.task).state, 'reported');
});

test('#7 (rework 2): a review without a recorded generation (made before the upgrade) is not applied; a fresh review is created', async () => {
  const { core, b, w, r1 } = await setup();
  core.run('UPDATE tasks SET target_gen=NULL WHERE id=?', r1.task);
  core.report({ participant: b, task: r1.task, gen: r1.gen, report_id: 'legacy', kind: 'result', verdict: 'accept', body: '旧形式' });
  assert.equal(core.task(w.task).state, 'reported');
  const fresh = core.all("SELECT * FROM tasks WHERE kind='review' AND parent_id=? AND state='open'", w.task);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].target_gen, core.task(w.task).gen);
});

test('#7 (rework 3): with only two participants, the re-review after a legacy review can still be done by the same reviewer', async () => {
  const { core } = makeCore();
  const s = seed(core);
  const a = joinAs(core, s.root, 'a', 'c1');
  const b = joinAs(core, s.root, 'b', 'c2');
  await facilitate(core, b, s.goal, [{ op: 'add_task', title: '作業', role: 'research', mode: 'read_only', review: true, prefer: 'a' }]);
  const w = await take(core, a);
  done(core, a, w.task, w.gen);
  const r = await take(core, b);
  core.run('UPDATE tasks SET target_gen=NULL WHERE id=?', r.task);
  core.report({ participant: b, task: r.task, gen: r.gen, report_id: 'legacy', kind: 'result', verdict: 'accept', body: '旧形式' });
  assert.equal(core.task(w.task).state, 'reported');
  assert.equal((await core.next({ participant: a })).kind, 'none', 'the author never reviews their own work');
  const again = await take(core, b);
  assert.equal(again.got.assignment.program.kind, 'review');
  core.report({ participant: b, task: again.task, gen: again.gen, report_id: 'fresh', kind: 'result', verdict: 'accept', body: '最新を確認' });
  assert.equal(core.task(w.task).state, 'accepted');
});
