import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, facilitate, done } from './helpers.mjs';

test('#9: cancelling a parked task via answerDecision propagates cancellation to dependent unstarted tasks', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'planner', 'c1');
  const b = joinAs(core, root, 'worker', 'c2');

  // 1. Facilitator creates task A and task B (B depends on A)
  await facilitate(core, a, goal, [
    { op: 'add_task', title: 'Task A', ref: 'taskA', role: 'research', mode: 'read_only' },
    { op: 'add_task', title: 'Task B', ref: 'taskB', role: 'research', mode: 'read_only', depends_on: ['taskA'] }
  ]);

  const tasks = core.all('SELECT id, title, state FROM tasks WHERE goal_id=? ORDER BY created_at', goal);
  const taskA = tasks.find(t => t.title === 'Task A');
  const taskB = tasks.find(t => t.title === 'Task B');
  assert.ok(taskA);
  assert.ok(taskB);

  // 2. Worker takes Task A and parks it on a question
  const workA = await take(core, b);
  assert.equal(workA.task, taskA.id);
  core.report({
    participant: b,
    task: taskA.id,
    gen: workA.gen,
    kind: 'decision_needed',
    report_id: 'q1',
    body: 'How should Task A proceed?',
    options: ['continue', 'cancel_task']
  });

  assert.equal(core.task(taskA.id).state, 'parked');
  const decision = core.snapshot().decisions.find(d => d.task_id === taskA.id);
  assert.ok(decision);

  // 3. Human answers decision with 'cancel_task'
  core.answerDecision(decision.id, 'cancel_task');
  assert.equal(core.task(taskA.id).state, 'cancelled');

  // 4. Dependent Task B MUST also be cancelled (not stuck in open waiting for A)
  assert.equal(core.task(taskB.id).state, 'cancelled');

  // 5. Goal is NOT stuck: a facilitator is generated to decide next steps
  core.tick();
  const next = await take(core, a);
  assert.equal(next.got.assignment.program.kind, 'facilitator');
});

test('#9: cancelling a task in plan propagates cancellation through a dependency chain A -> B -> C', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'planner', 'c1');

  // 1. Facilitator creates chain A -> B -> C and an independent task X
  await facilitate(core, a, goal, [
    { op: 'add_task', title: 'Task A', ref: 'tA', role: 'research', mode: 'read_only' },
    { op: 'add_task', title: 'Task B', ref: 'tB', role: 'research', mode: 'read_only', depends_on: ['tA'] },
    { op: 'add_task', title: 'Task C', ref: 'tC', role: 'research', mode: 'read_only', depends_on: ['tB'] },
    { op: 'add_task', title: 'Task X', ref: 'tX', role: 'research', mode: 'read_only' }
  ]);

  const tasks = core.all('SELECT id, title FROM tasks WHERE goal_id=?', goal);
  const tA = tasks.find(t => t.title === 'Task A').id;
  const tB = tasks.find(t => t.title === 'Task B').id;
  const tC = tasks.find(t => t.title === 'Task C').id;
  const tX = tasks.find(t => t.title === 'Task X').id;

  // 2. While tA is open, planner cancels task A via plan
  core.plan({
    participant: a,
    goal,
    base_version: core.goal(goal).plan_version,
    ops: [{ op: 'cancel_task', task: tA, reason: 'obsolete' }]
  });

  // 3. A, B, and C are all cancelled; independent task X remains open
  assert.equal(core.task(tA).state, 'cancelled');
  assert.equal(core.task(tB).state, 'cancelled');
  assert.equal(core.task(tC).state, 'cancelled');
  assert.equal(core.task(tX).state, 'open');
});

test('#9: resolveNeedsCheck cancel propagates cancellation to dependent tasks', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core, { delegation: { write_files: 'allow' } });
  const a = joinAs(core, root, 'planner', 'c1');
  const b = joinAs(core, root, 'worker', 'c2');

  await facilitate(core, a, goal, [
    { op: 'add_task', title: 'Write Task A', ref: 'wA', role: 'implement', mode: 'writes' },
    { op: 'add_task', title: 'Read Task B', ref: 'rB', role: 'research', mode: 'read_only', depends_on: ['wA'] }
  ]);

  const tasks = core.all('SELECT id, title FROM tasks WHERE goal_id=?', goal);
  const wA = tasks.find(t => t.title === 'Write Task A').id;
  const rB = tasks.find(t => t.title === 'Read Task B').id;

  // Worker claims wA and goes silent (lease expires)
  const work = await take(core, b);
  assert.equal(work.task, wA);

  // Time passes and lease expires -> needs_check
  core.run("UPDATE tasks SET lease_expires=0 WHERE id=?", wA);
  core.tick();
  assert.equal(core.task(wA).state, 'needs_check');

  // Human cancels wA from needs_check
  core.resolveNeedsCheck(wA, 'cancel');
  assert.equal(core.task(wA).state, 'cancelled');

  // Dependent task rB must also be cancelled
  assert.equal(core.task(rB).state, 'cancelled');
});

test('#9: actively claimed writes task is not silently cancelled; gets recheck flag and a decision', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core, { delegation: { write_files: 'allow' } });
  const a = joinAs(core, root, 'planner', 'c1');
  const b = joinAs(core, root, 'worker-b', 'c2');
  const c = joinAs(core, root, 'worker-c', 'c3');

  // 1. A creates source task A, and writes task B depending on A
  await facilitate(core, a, goal, [
    { op: 'add_task', title: 'Source A', ref: 'tA', role: 'research', mode: 'read_only' },
    { op: 'add_task', title: 'Writes B', ref: 'tB', role: 'implement', mode: 'writes', depends_on: ['tA'] }
  ]);

  const tasks = core.all('SELECT id, title FROM tasks WHERE goal_id=?', goal);
  const tA = tasks.find(t => t.title === 'Source A').id;
  const tB = tasks.find(t => t.title === 'Writes B').id;

  // 2. Source A is worked on and completed/accepted
  const workA = await take(core, b);
  assert.equal(workA.task, tA);
  done(core, b, tA, workA.gen);
  assert.equal(core.task(tA).state, 'accepted');

  // 3. Worker C claims Writes B
  const workB = await take(core, c);
  assert.equal(workB.task, tB);
  assert.equal(core.task(tB).state, 'claimed');
  assert.equal(core.task(tB).assignee, c);

  // 4. Source A is reworked and then cancelled by planner
  core.reworkTask(core.task(tA), core.goal(goal), 'needs rework', a);
  core.plan({
    participant: a,
    goal,
    base_version: core.goal(goal).plan_version,
    ops: [{ op: 'cancel_task', task: tA, reason: 'dropped' }]
  });
  assert.equal(core.task(tA).state, 'cancelled');

  // 5. Writes B MUST NOT be cancelled; it remains claimed by worker C with recheck flag
  assert.equal(core.task(tB).state, 'claimed');
  assert.equal(core.task(tB).assignee, c);
  assert.equal(core.task(tB).flag, 'recheck');

  // 6. Worker C calling next gets resume to finish or handle the task
  const nextC = await core.next({ participant: c });
  assert.equal(nextC.kind, 'resume');
  assert.equal(nextC.task, tB);

  // 7. A decision was raised informing human/worker about the cancelled dependency
  const decision = core.snapshot().decisions.find(d => d.task_id === tB);
  assert.ok(decision);
  assert.match(decision.question, /取り消されました/);

  // 8. If human answers decision with cancel_task, B is now explicitly cancelled
  core.answerDecision(decision.id, 'cancel_task');
  assert.equal(core.task(tB).state, 'cancelled');
});
