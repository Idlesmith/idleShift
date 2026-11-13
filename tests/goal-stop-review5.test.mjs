import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, facilitate, take } from './helpers.mjs';

async function working({ claim = true } = {}) {
  const state = makeCore();
  const { core } = state;
  const { root, goal, project } = seed(core);
  const participant = joinAs(core, root, 'worker', 'c1');
  await facilitate(core, participant, goal, [{ op: 'add_task', title: 'work', role: 'research', mode: 'read_only' }]);
  const offer = await core.next({ participant });
  assert.equal(offer.kind, 'offer');
  if (claim) core.claim({ participant, task: offer.task, gen: offer.gen });
  return { ...state, goal, project, participant, task: offer.task, gen: offer.gen };
}

for (const status of ['paused', 'stopped']) {
  test(`#5: next tells a holder to stop when its goal is ${status}`, async () => {
    const { core, goal, participant, task } = await working();
    core.setGoalStatus(goal, status);
    const next = await core.next({ participant });
    assert.equal(next.kind, 'stop');
    assert.equal(next.goal, goal);
    assert.equal(next.task, task);
    assert.equal(next.goal_status, status);
  });

  test(`#5: claim cannot resume/extend a task whose goal is ${status}`, async () => {
    const { core, advance, goal, participant, task, gen } = await working();
    const lease = core.task(task).lease_expires;
    core.setGoalStatus(goal, status);
    advance(1000);
    assert.throws(() => core.claim({ participant, task, gen }), e => e.code === 'goal_not_active');
    assert.equal(core.task(task).lease_expires, lease);
  });

  test(`#5: progress is recorded without extending the lease when goal is ${status}`, async () => {
    const { core, advance, goal, participant, task, gen } = await working();
    const before = core.task(task);
    core.setGoalStatus(goal, status);
    advance(1000);
    const args = { participant, task, gen, kind: 'progress', report_id: 'halted-progress' };
    const result = core.report(args);
    assert.equal(result.stop, true);
    assert.equal(result.stop_work, true);
    assert.equal(result.goal_status, status);
    assert.equal(result.header.next_tool, 'next');
    assert.equal(core.task(task).lease_expires, before.lease_expires);
    assert.equal(core.task(task).state, before.state);
    assert.equal(core.report(args).stop, true, 'retry also communicates the stop');
    if (status === 'paused') {
      core.setGoalStatus(goal, 'active');
      assert.equal(core.claim({ participant, task, gen }).assignment.program.task, task);
      assert.ok(core.task(task).lease_expires > before.lease_expires);
    }
  });

  test(`#5: outstanding offers are cleared when goal is ${status}`, async () => {
    const { core, goal, participant, task, gen } = await working({ claim: false });
    core.setGoalStatus(goal, status);
    assert.equal((await core.next({ participant })).kind, 'none');
    assert.equal(core.task(task).state, 'open');
    assert.equal(core.task(task).offered_to, null);
    assert.throws(() => core.claim({ participant, task, gen }), e => e.code === 'goal_not_active');
  });
}

test('#5: inactive held work does not hide held work in an active goal', async () => {
  const { core, goal, project, participant } = await working();
  const other = core.createGoal(project, { title: 'other goal', outcome: 'work', done_evidence: 'proof' }).id;
  core.tick();
  const held = await take(core, participant);
  // next normally resumes the first task; explicitly offer the other goal's task.
  assert.equal(held.offer.kind, 'resume');
  const otherTask = core.all("SELECT * FROM tasks WHERE goal_id=? AND state='open'", other)[0];
  core.makeOffer(otherTask, core.goal(other), core.one('SELECT * FROM participants WHERE id=?', participant));
  core.claim({ participant, task: otherTask.id, gen: otherTask.gen });
  core.setGoalStatus(goal, 'paused');
  const next = await core.next({ participant });
  assert.equal(next.kind, 'resume');
  assert.equal(next.task, otherTask.id);
});

for (const status of ['waiting_decision', 'done_candidate']) {
  test(`#5: ${status} blocks new work but preserves already counted assignments`, async () => {
    const { core, advance } = makeCore();
    const { root, goal } = seed(core, { budgets: { max_assignments: 3, max_parallel: 3 } });
    const a = joinAs(core, root, 'planner', 'a');
    const b = joinAs(core, root, 'worker', 'b');
    const c = joinAs(core, root, 'extra', 'c');
    await facilitate(core, a, goal, [1, 2, 3].map(i => ({ op: 'add_task', title: `work-${i}`, role: 'research', mode: 'read_only' })));
    const first = await take(core, a);
    const second = await take(core, b);
    if (status === 'waiting_decision') {
      assert.equal((await core.next({ participant: c })).kind, 'none');
    } else {
      const plan = core.plan({ participant: a, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'propose_done', evidence: 'candidate pending human confirmation' }] });
      assert.equal(plan.applied, true);
    }
    assert.equal(core.goal(goal).status, status);
    const before = core.task(second.task).lease_expires;
    advance(1000);
    const progress = core.report({ participant: b, task: second.task, gen: second.gen, kind: 'progress', report_id: 'keep-working' });
    assert.notEqual(progress.stop, true);
    assert.ok(core.task(second.task).lease_expires > before);
    assert.equal((await core.next({ participant: b })).kind, 'resume');
    assert.equal(core.claim({ participant: b, task: second.task, gen: second.gen }).assignment.program.task, second.task);
    assert.equal(core.goal(goal).assignments_used, 3);
    assert.equal(core.report({ participant: b, task: second.task, gen: second.gen, kind: 'result', report_id: 'finished' }).accepted, true);
    assert.equal(core.task(first.task).state, 'claimed');
    assert.equal((await core.next({ participant: c })).kind, 'none');
  });
}
