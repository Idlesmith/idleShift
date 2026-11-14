import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, facilitate, tmpDir } from './helpers.mjs';
import { runService } from '../src/service.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

const MIN = 60_000;
const READ = { role: 'research', mode: 'read_only' };
const WRITE = { role: 'implement', mode: 'writes' };
const WRITE_REVIEW = { role: 'review', mode: 'writes' };
const ALLOW_WRITES = { write_files: 'allow', prototype: 'allow' };

async function setupWithClients(clients, tasks, timing = {}) {
  const env = makeCore(timing);
  const seeded = seed(env.core, { delegation: ALLOW_WRITES });
  const ids = {};
  for (const [label, clientName] of Object.entries(clients)) {
    const conn = `conn-${label}`;
    env.core.connOpened(conn);
    ids[label] = env.core.join({ root: seeded.root, label }, { conn, client: { name: clientName } }).participant;
  }
  const firstId = Object.values(ids)[0];
  const { planned } = await facilitate(env.core, firstId, seeded.goal, tasks.map(t => ({ op: 'add_task', ...t })));
  return { ...env, ...seeded, ids, created: planned.created.map(c => c.task) };
}

function setUsage(core, service, window, used_percent, resetsInMs = 2 * 3600_000) {
  return core.setUsageManual({
    service,
    window,
    used_percent,
    resets_at: new Date(core.now() + resetsInMs).toISOString(),
  });
}

test('high usage (>= 90%) prefers read_only tasks over writes and implement tasks', async () => {
  const { core, ids, created } = await setupWithClients(
    { worker: 'codex-mcp-client' },
    [
      { title: 'write task', ...WRITE },
      { title: 'research task', ...READ },
    ],
  );
  setUsage(core, 'codex', '5h', 92);

  const first = await core.next({ participant: ids.worker });
  assert.equal(first.kind, 'offer');
  assert.equal(first.task, created[1]); // read_only research task offered first
});

test('high usage (weekly window >= 90%) yields writes/implement task to a healthy participant during grace and falls back after grace', async () => {
  const { core, advance, ids, created } = await setupWithClients(
    { heavy: 'codex-mcp-client', healthy: 'claude-code' },
    [
      { title: 'implement first', ...WRITE },
      { title: 'write review second', ...WRITE_REVIEW },
    ],
  );
  setUsage(core, 'codex', 'weekly', 90);
  setUsage(core, 'claude', '5h', 25);

  // Heavy cannot get the write task immediately while healthy exists within preferGrace
  const noneYet = await core.next({ participant: ids.heavy });
  assert.equal(noneYet.kind, 'none');

  // Healthy gets the write task immediately
  const healthyOffer = await core.next({ participant: ids.healthy });
  assert.equal(healthyOffer.kind, 'offer');
  assert.equal(healthyOffer.task, created[0]);
  core.claim({ participant: ids.healthy, task: healthyOffer.task, gen: healthyOffer.gen });

  // After preferGrace elapses without a healthy waiter, heavy falls back to the remaining write task.
  advance(core.t.preferGrace + 100);
  const res = await core.next({ participant: ids.heavy });
  assert.equal(res.kind, 'offer');
  assert.equal(res.task, created[1]);
});

test('high usage delivers to a concurrently waiting healthy participant before a high-usage waiter', async () => {
  const env = makeCore();
  const seeded = seed(env.core, { delegation: ALLOW_WRITES });
  env.core.connOpened('c-heavy');
  env.core.connOpened('c-fresh');
  const heavy = env.core.join({ root: seeded.root, label: 'heavy' }, { conn: 'c-heavy', client: { name: 'codex-mcp-client' } }).participant;
  const fresh = env.core.join({ root: seeded.root, label: 'fresh' }, { conn: 'c-fresh', client: { name: 'claude-code' } }).participant;

  const { planned } = await facilitate(env.core, fresh, seeded.goal, [{ op: 'add_task', title: 'blocker', ...READ }]);
  const blockerId = planned.created[0].task;

  const offer1 = await env.core.next({ participant: fresh });
  assert.equal(offer1.task, blockerId);
  env.core.claim({ participant: fresh, task: offer1.task, gen: offer1.gen });
  const goalObj = env.core.goal(seeded.goal);
  const { created: depCreated } = env.core.plan({
    participant: fresh,
    goal: seeded.goal,
    base_version: goalObj.plan_version,
    ops: [{ op: 'add_task', title: 'queued write', ...WRITE, depends_on: [blockerId] }],
  });

  // Only dependent task exists now; set codex high and claude healthy.
  setUsage(env.core, 'codex', '5h', 95);
  setUsage(env.core, 'claude', '5h', 10);

  // Both heavy and an extra healthy participant wait concurrently before the task unblocks.
  env.core.connOpened('c-fresh2');
  const fresh2 = env.core.join({ root: seeded.root, label: 'fresh2' }, { conn: 'c-fresh2', client: { name: 'claude-code' } }).participant;
  const heavyWait = env.core.next({ participant: heavy, wait_seconds: 60 });
  const fresh2Wait = env.core.next({ participant: fresh2, wait_seconds: 60 });

  await env.core.report({ participant: fresh, task: offer1.task, gen: offer1.gen, report_id: 'r1', kind: 'result', summary: 'done', body: 'done' });
  env.core.tick();

  // deliver() skips high-usage heavy waiter and serves healthy waiter immediately
  const fresh2Res = await fresh2Wait;
  assert.equal(fresh2Res.kind, 'offer');
  assert.equal(fresh2Res.task, depCreated[0].task);

  assert.equal(env.core.waiters.has(heavy), true);
  env.core.cancelWait(heavy);
  void heavyWait;
});

test('high usage takes writes task immediately when no healthy candidate exists', async () => {
  const { core, ids, created } = await setupWithClients(
    { solo: 'codex-mcp-client' },
    [{ title: 'solo write', ...WRITE }],
  );
  setUsage(core, 'codex', '5h', 95);

  const offer = await core.next({ participant: ids.solo });
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.task, created[0]);
});

test('100% usage blocks all offers until resets_at and rejects late claim with usage_limit', async () => {
  const { core, clock, advance, project, ids, created } = await setupWithClients(
    { blocked: 'codex-mcp-client', other: 'claude-code' },
    [
      { title: 'read task', ...READ },
      { title: 'write task', ...WRITE },
    ],
  );

  // First, blocked participant receives an offer while healthy
  setUsage(core, 'codex', '5h', 40, 60 * MIN);
  const pendingOffer = await core.next({ participant: ids.blocked });
  assert.equal(pendingOffer.kind, 'offer');

  // Usage hits 100% before claim!
  const resetMs = 45 * MIN;
  setUsage(core, 'codex', '5h', 100, resetMs);
  assert.throws(
    () => core.claim({ participant: ids.blocked, task: pendingOffer.task, gen: pendingOffer.gen }),
    e => e.code === 'usage_limit' && e.extra?.limited_until === new Date(clock.t + resetMs).toISOString(),
  );

  // Next returns none with limited_until
  const noneRes = await core.next({ participant: ids.blocked });
  assert.equal(noneRes.kind, 'none');
  assert.equal(noneRes.limited_until, new Date(clock.t + resetMs).toISOString());

  // offerableCount and boardView reflect the pause
  assert.equal(core.offerableCount(project, 'codex-mcp-client'), 0);
  const board = core.boardView(project);
  const blockedBoard = board.participants.find(x => x.participant === ids.blocked);
  assert.equal(blockedBoard.offers_paused, true);
  assert.equal(blockedBoard.until, clock.t + resetMs);

  // Healthy other participant does NOT wait on 100%-blocked participant
  const otherOffer = await core.next({ participant: ids.other });
  assert.equal(otherOffer.kind, 'offer');
  assert.ok(created.includes(otherOffer.task));

  // Once resets_at passes, blocked participant can receive offers again
  advance(resetMs + 1000);
  const afterReset = await core.next({ participant: ids.blocked });
  assert.equal(afterReset.kind, 'offer');
});

test('stale (>30m), expired reset, and null used_percent do not defer or block offers', async () => {
  const { core, clock, advance, ids, created } = await setupWithClients(
    { heavy: 'codex-mcp-client', healthy: 'claude-code' },
    [{ title: 'write task', ...WRITE }],
  );

  // Missing percentage (null)
  core.setUsageManual({ service: 'codex', window: '5h', used_percent: null, resets_at: new Date(clock.t + 2 * 3600_000).toISOString() });
  let offer = await core.next({ participant: ids.heavy });
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.task, created[0]);
  core.withdrawOffer(core.task(created[0]), 'test_reset');

  // Stale (>30 minutes old) 100% value does NOT block or defer
  setUsage(core, 'codex', '5h', 100, 3 * 3600_000);
  advance(31 * MIN);
  offer = await core.next({ participant: ids.heavy });
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.task, created[0]);
  core.withdrawOffer(core.task(created[0]), 'test_reset');

  // Expired reset (resets_at <= now) does NOT block or defer
  setUsage(core, 'codex', '5h', 100, 5 * MIN);
  advance(6 * MIN);
  offer = await core.next({ participant: ids.heavy });
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.task, created[0]);
});

test('usage deferral threshold is configurable via core and GUI HTTP API', async t => {
  const svc = await runService({ home: tmpDir('usage-policy-api'), quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());
  const api = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${svc.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token },
      body: JSON.stringify({ method, params }),
    });
    return { status: response.status, ...(await response.json()) };
  };

  let state = (await api('state')).result;
  assert.deepEqual(state.usage_policy, { defer_writes_percent: 90 });

  // Lower threshold to 70%
  const updated = await api('setUsagePolicy', { defer_writes_percent: 70 });
  assert.equal(updated.ok, true);
  assert.equal(updated.result.defer_writes_percent, 70);

  state = (await api('state')).result;
  assert.deepEqual(state.usage_policy, { defer_writes_percent: 70 });

  // Invalid values rejected
  const bad = await api('setUsagePolicy', { defer_writes_percent: 0 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_input');
  const badField = await api('setUsagePolicy', { unknown: 50 });
  assert.equal(badField.ok, false);
  assert.equal(badField.code, 'bad_input');

  // Verify lowered threshold defers writes when codex is at 75% and healthy peer exists
  const project = (await api('createProject', { name: 'policy' })).result.id;
  const root = tmpDir('usage-policy-root');
  svc.ctx.core.addRoot(project, root);
  const goal = svc.ctx.core.createGoal(project, { title: 'g', delegation: ALLOW_WRITES }).id;
  svc.ctx.core.tick();
  svc.ctx.core.connOpened('c1');
  svc.ctx.core.connOpened('c2');
  const codex = svc.ctx.core.join({ root, label: 'c1' }, { conn: 'c1', client: { name: 'codex-mcp-client' } }).participant;
  const claude = svc.ctx.core.join({ root, label: 'c2' }, { conn: 'c2', client: { name: 'claude-code' } }).participant;
  await facilitate(svc.ctx.core, codex, goal, [{ op: 'add_task', title: 'w', ...WRITE }]);

  setUsage(svc.ctx.core, 'codex', '5h', 75);
  assert.equal((await svc.ctx.core.next({ participant: codex })).kind, 'none');

  // Turn deferral off (null): now 75% is offered immediately even with healthy peer
  const disabled = await api('setUsagePolicy', { defer_writes_percent: null });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.result.defer_writes_percent, null);
  assert.equal((await svc.ctx.core.next({ participant: codex })).kind, 'offer');
  assert.ok(claude);
});
