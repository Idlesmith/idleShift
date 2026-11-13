import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, done } from './helpers.mjs';

async function setup() {
  const { core } = makeCore();
  const { root, goal } = seed(core, { budgets: { max_parallel: 3 } });
  const a = joinAs(core, root, 'planner', 'a');
  const b = joinAs(core, root, 'worker', 'b');
  const c = joinAs(core, root, 'other-worker', 'c');
  const f = await take(core, a);
  const plan = core.plan({ participant: a, goal, base_version: core.goal(goal).plan_version, ops: [
    { op: 'add_branch', hypothesis: 'candidate', ref: 'branch' },
    { op: 'add_task', title: 'remaining work', role: 'research', mode: 'read_only', branch: 'branch' },
  ] });
  const branch = plan.created[0].branch;
  const task = plan.created[1].task;
  const close = verdict => core.plan({ participant: a, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'close_branch', branch, verdict, reason: 'evidence evaluated' }] });
  return { core, goal, a, b, c, f, branch, task, close };
}

for (const verdict of ['kept', 'merged']) {
  test(`#8: ${verdict} promotes open work so it can finish and the facilitator can advance`, async () => {
    const { core, a, b, f, task, close } = await setup();
    close(verdict);
    assert.equal(core.task(task).branch_id, null);
    done(core, a, f.task, f.gen);
    const work = await take(core, b);
    assert.equal(work.task, task);
    done(core, b, work.task, work.gen);
    core.tick();
    const next = await take(core, b);
    assert.equal(next.got.assignment.program.kind, 'facilitator');
  });

  test(`#8: ${verdict} preserves a valid offer and its generation when promoting it`, async () => {
    const { core, b, task, close } = await setup();
    const offer = await core.next({ participant: b });
    assert.equal(offer.task, task);
    close(verdict);
    assert.equal(core.task(task).branch_id, null);
    const claimed = core.claim({ participant: b, task, gen: offer.gen });
    assert.equal(claimed.assignment.program.task, task);
    assert.equal(core.task(task).gen, offer.gen);
  });

  test(`#8: ${verdict} promotes a parked task while retaining its human question`, async () => {
    const { core, b, task, close } = await setup();
    const work = await take(core, b);
    core.report({ participant: b, task, gen: work.gen, report_id: 'question', kind: 'decision_needed', body: 'which source?' });
    const question = core.one("SELECT * FROM decisions WHERE task_id=? AND state='pending'", task);
    close(verdict);
    assert.equal(core.task(task).branch_id, null);
    assert.equal(core.task(task).state, 'parked');
    core.answerDecision(question.id, 'continue');
    assert.equal((await take(core, b)).task, task);
  });

  test(`#8: ${verdict} retains the origin/exclusion of late evidence from a held task`, async () => {
    const { core, b, branch, task, close } = await setup();
    const work = await take(core, b);
    close(verdict);
    assert.equal(core.task(task).branch_id, branch);
    done(core, b, task, work.gen, { evidence: [{ kind: 'fact', text: 'late finding' }] });
    const evidence = core.one("SELECT * FROM evidence WHERE task_id=? AND text='late finding'", task);
    assert.equal(evidence.branch_id, branch);
    assert.equal(evidence.excluded, 1);
    assert.equal(core.task(task).flag, 'late_branch');
  });

  test(`#8: work released after ${verdict} can be offered again outside the closed branch`, async () => {
    const { core, b, c, task, close } = await setup();
    const work = await take(core, b);
    close(verdict);
    core.report({ participant: b, task, gen: work.gen, report_id: 'decline', kind: 'decline', body: 'cannot continue' });
    const retry = await take(core, c);
    assert.equal(retry.task, task);
    assert.equal(core.task(task).branch_id, null);
    assert.ok(retry.gen > work.gen);
  });
}
