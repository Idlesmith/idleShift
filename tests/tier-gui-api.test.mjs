import test from 'node:test';
import assert from 'node:assert/strict';
import { runService } from '../src/service.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

async function setup(t) {
  const svc = await runService({ home: tmpDir('tier-gui-api'), quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());
  const api = async (method, params = {}, token = svc.token) => {
    const response = await fetch(`http://127.0.0.1:${svc.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': token }, body: JSON.stringify({ method, params }) });
    return { status: response.status, ...(await response.json()) };
  };
  const project = (await api('createProject', { name: 'tiers' })).result.id;
  const root = tmpDir('tier-api-root');
  svc.ctx.core.addRoot(project, root);
  svc.ctx.core.createGoal(project, { title: 'work' });
  svc.ctx.core.tick(); svc.ctx.core.connOpened('test');
  const participant = svc.ctx.core.join({ root, label: 'worker' }, { conn: 'test', client: { name: 'worker' } }).participant;
  const offer = await svc.ctx.core.next({ participant });
  svc.ctx.core.claim({ participant, task: offer.task, gen: offer.gen });
  return { svc, api, project, root, participant };
}

test('tier GUI API: authenticated manual profile changes persist and snapshot shows tier, usage, limits and remaining', async t => {
  const { svc, api, project, root } = await setup(t);
  const changed = await api('setProfile', { project, label: 'worker', profile: { tier: 'senior', limit_5h_claims: 1, limit_5h_minutes: 90, limit_7d_claims: 20, limit_7d_minutes: 300 } });
  assert.equal(changed.ok, true);
  const state = (await api('state')).result;
  const worker = state.projects.find(p => p.id === project).participants[0];
  assert.equal(worker.tier, 'senior');
  assert.equal(worker.usage.used.claims_5h, 1);
  assert.equal(worker.usage.limits.limit_5h_claims, 1);
  assert.equal(worker.usage.remaining.claims_5h, 0);
  assert.equal(worker.usage.remaining.claims_7d, 19);
  assert.ok(worker.usage.blocked);
  svc.ctx.core.connClosed('test'); svc.ctx.core.connOpened('new');
  svc.ctx.core.join({ root, label: 'worker' }, { conn: 'new', client: { name: 'worker' } });
  assert.equal(svc.ctx.core.profile(project, 'worker').tier, 'senior');
  assert.equal((await api('setProfile', { project, label: 'worker', profile: { tier: null, limit_5h_claims: null } })).ok, true);
  assert.equal(svc.ctx.core.profile(project, 'worker').tier, null);
  assert.equal(svc.ctx.core.profile(project, 'worker').limit_7d_claims, 20, 'partial update preserves other settings');
});

test('tier GUI API: invalid profile values are rejected atomically', async t => {
  const { svc, api, project } = await setup(t);
  assert.equal((await api('setProfile', { project, label: 'worker', profile: { tier: 'worker', limit_5h_claims: 3 } })).ok, true);
  for (const profile of [{ tier: 'boss' }, { limit_5h_claims: 0 }, { limit_5h_minutes: -1 }, { limit_7d_claims: 10001 }, { limit_7d_minutes: 1.5 }, { limit_5h_claims: '2' }, { tier: 'senior', limit_7d_minutes: true }, { write_files: 'allow' }]) {
    const result = await api('setProfile', { project, label: 'worker', profile });
    assert.equal(result.ok, false, JSON.stringify(profile));
    assert.equal(svc.ctx.core.profile(project, 'worker').tier, 'worker');
    assert.equal(svc.ctx.core.profile(project, 'worker').limit_5h_claims, 3);
  }
});

test('tier GUI API: project fallback policy is validated and visible in state', async t => {
  const { api, project } = await setup(t);
  assert.equal((await api('setTierPolicy', { project, policy: { downgrade_after_minutes: 10 } })).ok, true);
  assert.equal((await api('state')).result.projects.find(p => p.id === project).tier_policy.downgrade_after_minutes, 10);
  for (const value of [0, -1, 1441, 1.5, '10']) {
    assert.equal((await api('setTierPolicy', { project, policy: { downgrade_after_minutes: value } })).ok, false);
  }
  assert.equal((await api('setTierPolicy', { project, policy: { downgrade_after_minutes: null } })).ok, true);
});

test('tier GUI API: profile and policy writes require the existing GUI token', async t => {
  const { svc, api, project } = await setup(t);
  assert.equal((await api('setProfile', { project, label: 'worker', profile: { tier: 'planner' } }, 'wrong')).status, 401);
  assert.equal((await api('setTierPolicy', { project, policy: { downgrade_after_minutes: 1 } }, 'wrong')).status, 401);
  assert.equal(svc.ctx.core.profile(project, 'worker').tier, null);
});
