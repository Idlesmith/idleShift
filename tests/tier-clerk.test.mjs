// The clerk tier: routine chores, below worker. docs/tiers-contract.md §1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, facilitate } from './helpers.mjs';

const MIN = 60_000;
const R = { role: 'research', mode: 'read_only' };

function setProfile(core, project, label, tier) {
  core.run(`INSERT INTO participant_profiles(project_id,label,tier,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(project_id,label) DO UPDATE SET tier=excluded.tier`, project, label, tier, core.now());
}
const peek = async (core, participant) => { const r = await core.next({ participant }); return r?.kind === 'offer' ? r.task : r.kind; };

async function setup(tasks, names) {
  const state = makeCore();
  const seeded = seed(state.core);
  const ids = {};
  for (const n of names) ids[n] = joinAs(state.core, seeded.root, n, `conn-${n}`);
  const { planned } = await facilitate(state.core, ids[names[0]], seeded.goal, tasks.map(t => ({ op: 'add_task', ...R, ...t })));
  return { ...state, ...seeded, ids, created: planned.created.map(c => c.task) };
}

test('clerk: add_task stores the clerk tier', async () => {
  const { core, created } = await setup([{ title: 'c', tier: 'clerk' }], ['boss']);
  assert.equal(core.task(created[0]).tier, 'clerk');
});

test('clerk: a clerk never takes worker work, not even with a downgrade policy', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 'w', tier: 'worker' }], ['boss', 'ck']);
  setProfile(core, project, 'ck', 'clerk');
  core.run('UPDATE projects SET tier_policy=? WHERE id=?', JSON.stringify({ downgrade_after_minutes: 1 }), project);
  pass(60 * MIN);
  assert.equal(await peek(core, ids.ck), 'none');
  assert.equal(core.task(created[0]).state, 'open');
});

test('clerk: a clerk takes clerk work', async () => {
  const { core, project, ids, created } = await setup([{ title: 'c', tier: 'clerk' }], ['boss', 'ck']);
  setProfile(core, project, 'ck', 'clerk');
  assert.equal(await peek(core, ids.ck), created[0]);
});

test('clerk: a higher tier takes clerk work at once when no clerk exists', async () => {
  const { core, project, ids, created } = await setup([{ title: 'c', tier: 'clerk' }], ['boss', 'wk']);
  setProfile(core, project, 'wk', 'worker');
  assert.equal(await peek(core, ids.wk), created[0]);
});

test('clerk: with a clerk present, a worker leaves clerk work alone inside the grace period', async () => {
  const { core, project, ids } = await setup([{ title: 'c', tier: 'clerk' }, { title: 'hold', exclude: ['wk', 'ck'] }], ['boss', 'wk', 'ck']);
  setProfile(core, project, 'wk', 'worker'); setProfile(core, project, 'ck', 'clerk');
  assert.equal(await peek(core, ids.wk), 'none');
});

test('clerk: unset tier still means no restriction (rank 0 stays reserved)', async () => {
  const { core, ids, created } = await setup([{ title: 'c', tier: 'clerk' }], ['boss', 'free']);
  assert.equal(await peek(core, ids.free), created[0]);
});
