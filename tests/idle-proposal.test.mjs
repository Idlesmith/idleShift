import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, done } from './helpers.mjs';

const finish = (core, goal) => { core.run("UPDATE tasks SET state='cancelled' WHERE goal_id=?", goal); core.run("UPDATE goals SET status='done', closed_at=?, updated_at=? WHERE id=?", core.now(), core.now(), goal); };
const proposalTasks = (core, project) => core.all("SELECT * FROM tasks WHERE project_id=? AND kind='proposal'", project);

test('idle: one proposal task per idle period; proposed goals are not handed out; approve starts them', async () => {
  const { core, notes } = makeCore(); const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'planner', 'c1');
  finish(core, goal);
  core.tick(); core.tick();
  assert.equal(proposalTasks(core, project).length, 1, 'created exactly once');

  const got = await take(core, p);
  assert.equal(got.offer.task_kind, 'proposal');
  const hostGoal = got.offer.goal;
  const r = core.plan({ participant: p, goal: hostGoal, ops: [{ op: 'add_goal', title: '次の案' }] });
  const proposed = r.created[0].goal;
  assert.equal(core.goal(proposed).status, 'proposed');
  assert.ok(notes.some(n => /ゴール案/.test(n.body)));
  done(core, p, got.task, got.gen);
  core.tick(); core.tick();
  assert.equal(proposalTasks(core, project).length, 1, 'still once after finishing');
  assert.equal(core.goal(hostGoal).status, 'done');
  assert.equal(core.goal(proposed).status, 'proposed', 'nothing starts without approval');
  assert.equal(core.all("SELECT * FROM tasks WHERE goal_id=?", proposed).length, 0);

  // approval makes it a normal goal again
  core.approveProposedGoal(proposed);
  assert.equal(core.goal(proposed).status, 'active');
  core.tick();
  const next = await core.next({ participant: p });
  assert.equal(next.kind, 'offer', 'facilitator task for the approved goal');
});

test('idle: after the proposal, waiting AIs get stop(idle_disband); rejoin works after approval', async () => {
  const { core, notes } = makeCore(); const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'planner', 'c1');
  const q = joinAs(core, root, 'other', 'c2');
  finish(core, goal);
  core.tick();
  const got = await take(core, p);
  const r = core.plan({ participant: p, goal: got.offer.goal, ops: [{ op: 'add_goal', title: '案' }] });
  const waiting = core.next({ participant: q, wait_seconds: 3600 });
  done(core, p, got.task, got.gen);
  core.tick();
  const stopped = await waiting;
  assert.equal(stopped.kind, 'stop');
  assert.equal(stopped.reason, 'idle_disband');
  assert.ok(notes.some(n => /解散/.test(n.body)));
  const again = await core.next({ participant: q });
  assert.equal(again.kind, 'stop', 'immediate next also stops while idle');

  core.approveProposedGoal(r.created[0].goal);
  core.tick();
  const resumed = await core.next({ participant: q });
  assert.equal(resumed.kind, 'offer');
  assert.equal(proposalTasks(core, project).length, 1);
});

test('idle: rejecting a proposal discards it and does not trigger a second proposal', async () => {
  const { core } = makeCore(); const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'planner', 'c1');
  finish(core, goal);
  core.tick();
  const got = await take(core, p);
  const r = core.plan({ participant: p, goal: got.offer.goal, ops: [{ op: 'add_goal', title: '案' }] });
  done(core, p, got.task, got.gen);
  core.tick();
  core.rejectProposedGoal(r.created[0].goal);
  core.tick(); core.tick();
  assert.throws(() => core.goal(r.created[0].goal), e => e.code === 'unknown_goal');
  assert.equal(proposalTasks(core, project).length, 1);
});

test('idle: a pending human decision means no proposal and no disband', async () => {
  const { core } = makeCore(); const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'planner', 'c1');
  core.raiseDecision({ project, goal, kind: 'question', messageKey: 'decision.no_progress', messageArgs: [1], options: ['continue', 'stop'] });
  finish(core, goal);
  core.tick(); core.tick();
  assert.equal(proposalTasks(core, project).length, 0, 'human wait comes first');
  const r = await core.next({ participant: p });
  assert.notEqual(r.kind, 'stop');
});

test('idle: a project with no finished goal gets no proposal', () => {
  const { core } = makeCore(); const { project, goal } = seed(core);
  core.run("UPDATE goals SET status='stopped' WHERE id=?", goal);
  core.tick(); core.tick();
  assert.equal(proposalTasks(core, project).length, 0);
});
