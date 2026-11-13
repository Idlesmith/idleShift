import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take } from './helpers.mjs';

const deleg = core => JSON.parse(core.goal('G-1').delegation);

test('ask_permission: a human choosing the grant option changes the goal delegation', async () => {
  const { core } = makeCore(); const { root, goal } = seed(core);
  const p = joinAs(core, root, 'fac', 'c1');
  await take(core, p);
  const pv = core.goal(goal).permission_version;
  const r = core.plan({ participant: p, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'ask_permission', keys: ['write_files', 'run_code'], reason: '実装のため' }] });
  const id = r.created.find(c => c.decision).decision;
  const d = core.one('SELECT * FROM decisions WHERE id=?', id);
  assert.equal(d.kind, 'permission');
  assert.deepEqual(JSON.parse(d.options), ['grant:write_files,run_code', 'deny']);
  assert.throws(() => core.answerDecision(id, 'grant:write_files,run_code,install_deps'), e => e.code === 'bad_input', 'only the stored option can grant');
  core.answerDecision(id, 'grant:write_files,run_code');
  assert.equal(deleg(core).write_files, 'allow');
  assert.equal(deleg(core).run_code, 'allow');
  assert.equal(deleg(core).install_deps, 'deny');
  assert.equal(core.goal(goal).permission_version, pv + 1);
});

test('ask_permission: deny changes nothing; bad keys and already-allowed keys are refused', async () => {
  const { core } = makeCore(); const { root, goal } = seed(core);
  const p = joinAs(core, root, 'fac', 'c1');
  await take(core, p);
  const plan = ops => core.plan({ participant: p, goal, base_version: core.goal(goal).plan_version, ops });
  assert.throws(() => plan([{ op: 'ask_permission', keys: ['root_access'], reason: 'x' }]), e => e.code === 'bad_input');
  assert.throws(() => plan([{ op: 'ask_permission', keys: ['research'], reason: 'x' }]), e => e.code === 'already_allowed');
  const id = plan([{ op: 'ask_permission', keys: ['write_files'], reason: 'x' }]).created.find(c => c.decision).decision;
  core.answerDecision(id, 'deny');
  assert.equal(deleg(core).write_files, 'deny');
});
