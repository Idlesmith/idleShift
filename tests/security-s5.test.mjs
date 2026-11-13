// S-5: add_goal must require an active template goal and enforce a project-wide AI-goal limit with human decision.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs } from './helpers.mjs';

test('S-5: add_goal accepts non-active templates (inherits delegation); other ops still need active', () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const p = joinAs(core, root, 'fac', 'c1');

  for (const status of ['stopped', 'paused', 'done', 'done_candidate']) {
    core.run('UPDATE goals SET status=? WHERE id=?', status, goal);
    const r = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: `from-${status}` }] }, { conn: 'c1' });
    assert.ok(r.created[0].goal, `template with status=${status} may seed a goal`);
    core.run("UPDATE goals SET status='archived_tmp' WHERE project_id=? AND id<>?", core.goal(goal).project_id, goal);
  }

  // Active template still works
  core.run("UPDATE goals SET status='active' WHERE id=?", goal);
  const res = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: 'from-active' }] }, { conn: 'c1' });
  assert.ok(res.created[0].goal);
});

test('S-5: exceeding project-wide AI-created goal limit raises human decision and refuses add_goal', () => {
  const { core } = makeCore();
  const { root, project, goal } = seed(core);
  const p = joinAs(core, root, 'fac', 'c1');

  // Create 10 AI goals (even if earlier ones are marked done, they still count toward project total)
  for (let i = 0; i < 10; i++) {
    const r = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: `ai-g-${i}` }] }, { conn: 'c1' });
    assert.ok(r.created[0].goal);
    core.run("UPDATE goals SET status='done' WHERE id=?", r.created[0].goal);
  }

  // 11th AI goal must be refused and raise a pending human decision
  assert.throws(
    () => core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: 'ai-g-11' }] }, { conn: 'c1' }),
    e => e.code === 'too_many_goals'
  );
  const decisions = core.get({ participant: p, ref: 'decisions' }, { conn: 'c1' }).data.decisions;
  const dec = decisions.find(d => d.kind === 'ai_goal_limit' && d.state === 'pending');
  assert.ok(dec, 'human decision ai_goal_limit must be raised');

  // When human allows more, add_goal succeeds again
  core.answerDecision(dec.id, 'allow_more', '2');
  const r11 = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: 'ai-g-11' }] }, { conn: 'c1' });
  assert.ok(r11.created[0].goal);
});
