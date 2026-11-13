import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, facilitate } from './helpers.mjs';

test('quota-routing (1)-(4): limit+reset_at, quota low, reset recovery, 5h usageBlock, tier interaction', async () => {
  const { core, clock, advance } = makeCore();
  const { root, goal: g, project: pid } = seed(core);

  const pA = core.join({ root, label: 'app-a' }, { conn: 'c-a', client: { name: 'client-a', version: '1.0' } }).participant;
  const pB = core.join({ root, label: 'app-b' }, { conn: 'c-b', client: { name: 'client-b', version: '1.0' } }).participant;
  const pC = core.join({ root, label: 'app-c' }, { conn: 'c-c', client: { name: 'client-c', version: '1.0' } }).participant;

  // Finish the opening facilitator task (T-1) and add work-1 (tier:any) + work-senior (tier:senior)
  const { planned } = await facilitate(core, pA, g, [
    { op: 'add_task', title: 'work-1', body: 'b1', role: 'research', mode: 'read_only', tier: 'any' },
    { op: 'add_task', title: 'work-senior', body: 'b2', role: 'research', mode: 'read_only', tier: 'senior' }
  ]);
  const t1 = planned.created[0].task;
  const tSenior = planned.created[1].task;

  // Set tiers: initially app-a=worker so it claims t1 (tier:any) first, then upgrade app-a=senior
  core.setProfile(pid, 'app-a', { tier: 'worker' });
  core.setProfile(pid, 'app-b', { tier: 'worker', limit_5h_claims: 1 });
  core.setProfile(pid, 'app-c', { tier: 'worker' });

  // 1. app-a claims T-1 and reports kind='limit' with reset_at = +10 minutes
  const oA = await core.next({ participant: pA, wait_seconds: 0 }, { conn: 'c-a' });
  assert.equal(oA.kind, 'offer');
  assert.equal(oA.task, t1);
  core.claim({ participant: pA, task: oA.task, gen: oA.gen }, { conn: 'c-a' });
  core.setProfile(pid, 'app-a', { tier: 'senior' });
  const resetAt = new Date(clock.t + 10 * 60_000).toISOString();
  const repLimit = core.report({
    participant: pA, task: oA.task, gen: oA.gen, report_id: 'lim-1',
    kind: 'limit', reset_at: resetAt, body: 'hit 5h limit'
  }, { conn: 'c-a' });
  assert.equal(repLimit.accepted, true);
  assert.equal(core.limited('client-a'), true);
  assert.equal(core.quotaView('client-a').state, 'limit_reported');

  // app-a gets none while limited
  const oA2 = await core.next({ participant: pA, wait_seconds: 0 }, { conn: 'c-a' });
  assert.equal(oA2.kind, 'none');

  // 2. Immediately after limit, t1 has prefer=pA (src/core.mjs:1341), so app-b waits out preferGrace.
  //    Once preferGrace elapses (still before reset_at=+10m), app-b receives t1 and reports quota low.
  assert.equal((await core.next({ participant: pB, wait_seconds: 0 }, { conn: 'c-b' })).kind, 'none');
  advance(core.t.preferGrace + 1000);
  assert.equal(core.limited('client-a'), true);
  const oB = await core.next({ participant: pB, wait_seconds: 0 }, { conn: 'c-b' });
  assert.equal(oB.kind, 'offer');
  assert.equal(oB.task, t1);
  core.claim({ participant: pB, task: t1, gen: oB.gen }, { conn: 'c-b' });
  core.report({
    participant: pB, task: t1, gen: oB.gen, report_id: 'done-b',
    kind: 'result', body: 'done', quota: { state: 'low', used_percent: 90 }
  }, { conn: 'c-b' });
  assert.equal(core.limited('client-b'), false);
  assert.equal(core.quotaView('client-b').state, 'known');
  assert.match(core.quotaView('client-b').detail, /残り少/);

  // 3. app-b now hit limit_5h_claims=1, and app-c is worker -> neither can take tSenior (senior only)
  const { created: c2 } = core.plan({
    participant: pC, goal: g, base_version: core.goal(g).plan_version,
    ops: [{ op: 'add_task', title: 'work-2', body: 'b3', role: 'research', mode: 'read_only', tier: 'any' }]
  }, { conn: 'c-c' });
  const t2 = c2[0].task;
  // app-b is blocked by usageBlock (1 claim in 5h) -> gets none; app-c gets t2
  assert.equal((await core.next({ participant: pB, wait_seconds: 0 }, { conn: 'c-b' })).kind, 'none');
  const oC = await core.next({ participant: pC, wait_seconds: 0 }, { conn: 'c-c' });
  assert.equal(oC.kind, 'offer');
  assert.equal(oC.task, t2);
  // app-c still cannot take tSenior because it is worker and no downgrade policy is active
  core.claim({ participant: pC, task: t2, gen: oC.gen }, { conn: 'c-c' });
  core.report({ participant: pC, task: t2, gen: oC.gen, report_id: 'done-c', kind: 'result', body: 'ok' }, { conn: 'c-c' });
  assert.equal((await core.next({ participant: pC, wait_seconds: 0 }, { conn: 'c-c' })).kind, 'none');

  // 4. Advance past reset_at (+10 min + 1s): client-a becomes stale (allowed 1 try) and gets tSenior!
  advance(10 * 60_000 + 1000);
  assert.equal(core.limited('client-a'), false);
  assert.equal(core.quotaView('client-a').state, 'stale');
  const oARecover = await core.next({ participant: pA, wait_seconds: 0 }, { conn: 'c-a' });
  assert.equal(oARecover.kind, 'offer');
  assert.equal(oARecover.task, tSenior);

  // 5. Advance past 5h window: app-b usageBlock clears
  advance(5 * 3600_000 + 1000);
  assert.equal(core.usageBlock(core.goal(g).project_id, 'app-b'), null);
});
