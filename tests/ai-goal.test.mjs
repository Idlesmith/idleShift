import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DELEGATION, DEFAULT_BUDGETS } from '../src/core.mjs';
import { makeCore, seed, joinAs, tmpDir } from './helpers.mjs';

test('add_goal: an AI creates a goal that inherits and can only narrow the template', () => {
  const { core } = makeCore(); const { root, goal } = seed(core);
  core.updateGoal(goal, { delegation: { write_files: 'allow', run_code: 'allow' }, budgets: { max_parallel: 2 } });
  const p = joinAs(core, root, 'fac', 'c1');
  const r = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: '新しい仕事', outcome: 'x', delegation: { run_code: 'deny', install_deps: 'allow' }, budgets: { max_parallel: 8 } }] });
  const id = r.created[0].goal;
  const g = core.goal(id);
  const d = JSON.parse(g.delegation);
  assert.equal(g.status, 'active');
  assert.equal(d.write_files, 'allow');
  assert.equal(d.run_code, 'deny', 'narrowing applies');
  assert.equal(d.install_deps, 'deny', 'widening is ignored');
  assert.equal(JSON.parse(g.budgets).max_parallel, 2, 'budget capped at template');
  assert.match(g.notes, /を元に作成/);
});

test('add_goal: refused from a finished template, cannot mix with other ops, refused on empty title', () => {
  const { core } = makeCore(); const { root, goal } = seed(core);
  const p = joinAs(core, root, 'fac', 'c1');
  assert.throws(() => core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: 'b' }, { op: 'add_evidence', text: 't' }] }));
  assert.throws(() => core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: '' }] }), e => e.code === 'bad_input');
  core.run("UPDATE goals SET status='done' WHERE id=?", goal);
  const r = core.plan({ participant: p, goal, ops: [{ op: 'add_goal', title: 'a' }] });
  assert.equal(core.goal(r.created[0].goal).status, 'active', 'done template can still seed a goal');
  assert.throws(() => core.plan({ participant: p, goal, ops: [{ op: 'add_evidence', text: 't' }] }), e => e.code === 'goal_not_active');
});

test('add_goal without a template uses safe defaults even for a worker', () => {
  const { core } = makeCore();
  const root = tmpDir('no-goals');
  const project = core.createProject({ name: 'empty' }).id; core.addRoot(project, root);
  const participant = joinAs(core, root, 'worker', 'worker-conn');
  const result = core.plan({ participant, ops: [{ op: 'add_goal', title: 'first', delegation: { write_files: 'allow', run_code: 'allow', install_deps: 'allow' }, budgets: { max_parallel: 100 } }] });
  const goal = core.goal(result.created[0].goal);
  assert.equal(goal.author_kind, 'ai');
  assert.deepEqual(core.delegation(goal), DEFAULT_DELEGATION);
  assert.ok(core.budgets(goal).max_parallel <= DEFAULT_BUDGETS.max_parallel);
  assert.throws(() => core.plan({ participant, ops: [{ op: 'add_evidence', text: 'x' }] }));
  core.setGoalStatus(goal.id, 'stopped'); assert.equal(core.goal(goal.id).status, 'stopped');
  core.setProjectStop(project, true);
  assert.throws(() => core.plan({ participant, ops: [{ op: 'add_goal', title: 'blocked' }] }), e => e.code === 'stopped');
  core.setProjectStop(project, false);
  core.run('UPDATE projects SET archived_at=? WHERE id=?', Date.now(), project);
  assert.throws(() => core.plan({ participant, ops: [{ op: 'add_goal', title: 'blocked' }] }), e => e.code === 'project_archived');
});
