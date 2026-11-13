// Review #4: withdrawing file-write permission must stop writing tasks from being offered or claimed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Refusal } from '../src/core.mjs';
import { makeCore, seed, joinAs, take, facilitate } from './helpers.mjs';

const NO_WRITE = { write_files: 'deny', prototype: 'deny' };
async function setup() {
  const env = makeCore();
  const { core } = env;
  const s = seed(core, { delegation: { write_files: 'allow' } });
  const a = joinAs(core, s.root, 'a', 'c1');
  const b = joinAs(core, s.root, 'b', 'c2');
  await facilitate(core, a, s.goal, [{ op: 'add_task', title: '実装', role: 'implement', mode: 'writes' }]);
  const task = core.all("SELECT id FROM tasks WHERE goal_id=? AND mode='writes'", s.goal)[0].id;
  return { ...env, ...s, a, b, task };
}

test('#4: after revocation an open writing task is not offered, and is parked for a human instead of blocking the goal', async () => {
  const { core, goal, b, task } = await setup();
  core.updateGoal(goal, { delegation: NO_WRITE });
  assert.equal((await core.next({ participant: b })).kind, 'none');
  assert.equal(core.task(task).state, 'parked');
  assert.ok(core.snapshot().decisions.some(d => d.task_id === task), 'a human is asked what to do with it');
});

test('#4: an offer made before revocation is withdrawn and cannot be claimed', async () => {
  const { core, goal, b, task } = await setup();
  const offer = await core.next({ participant: b });
  assert.equal(offer.task, task);
  core.updateGoal(goal, { delegation: NO_WRITE });
  assert.throws(() => core.claim({ participant: b, task, gen: offer.gen }), e => e instanceof Refusal);
  assert.equal(core.task(task).assignee, null);
});

test('#4: claim re-checks permission even if the offer was not withdrawn', async () => {
  const { core, goal, b, task } = await setup();
  const offer = await core.next({ participant: b });
  // change permissions behind updateGoal's back (e.g. restored data) to test claim on its own
  const g = core.goal(goal);
  core.run('UPDATE goals SET delegation=? WHERE id=?', JSON.stringify({ ...JSON.parse(g.delegation), ...NO_WRITE }), goal);
  assert.throws(() => core.claim({ participant: b, task, gen: offer.gen }), e => e instanceof Refusal && e.code === 'not_delegated');
  assert.equal(core.task(task).state, 'parked');
});

test('#4: allowing writes again lets the human reopen the task', async () => {
  const { core, goal, b, task } = await setup();
  core.updateGoal(goal, { delegation: NO_WRITE });
  await core.next({ participant: b });
  core.updateGoal(goal, { delegation: { write_files: 'allow' } });
  const d = core.snapshot().decisions.find(x => x.task_id === task);
  core.answerDecision(d.id, '再開', '許可を戻した');
  const w = await take(core, b);
  assert.equal(w.task, task);
});
