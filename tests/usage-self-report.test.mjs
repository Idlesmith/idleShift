import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, take } from './helpers.mjs';
import { TOOLS } from '../src/tools.mjs';

const setup = () => {
  const env = makeCore();
  const { root, project } = seed(env.core);
  const meta = { conn: 'claude', client: { name: 'claude-ai' } };
  env.core.connOpened(meta.conn);
  return { ...env, root, project, meta };
};
const window = (now, extra = {}) => ({ label: '5h', used_percent: 35, resets_at: new Date(now + 3600_000).toISOString(), ...extra });

test('join and report expose one backwards-compatible quota schema', () => {
  const schema = name => TOOLS.find(t => t.name === name).inputSchema.properties.quota;
  assert.deepEqual(schema('join'), schema('report'));
  assert.deepEqual(schema('join').properties.windows.items.required, ['label', 'used_percent', 'resets_at']);
  assert.ok(schema('report').properties.reset_at);
});

test('join stores multiple self-reported windows under the configured service', () => {
  const { core, clock, root, project, meta } = setup();
  core.setProfile(project, 'desktop', { usage_service: 'custom-claude' });
  const joined = core.join({ root, label: 'desktop', quota: { windows: [window(clock.t), window(clock.t, { label: 'weekly-sonnet', used_percent: 70 })] } }, meta);
  assert.equal(joined.quota_request, undefined);
  assert.equal(core.usageWindows('claude').length, 0);
  const rows = core.usageWindows('custom-claude');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.window, r.used_percent, r.source]), [['5h', 35, 'self-report'], ['weekly-sonnet', 70, 'self-report']]);
});

test('legacy scalar quota still sets the service limit and records usage', () => {
  const { core, clock, root, meta } = setup();
  core.join({ root, quota: { state: 'low', used_percent: 90, reset_at: new Date(clock.t + 3600_000).toISOString() } }, meta);
  assert.equal(core.quotaView('claude-ai').state, 'known');
  const [row] = core.usageWindows('claude');
  assert.equal(row.window, 'default');
  assert.equal(row.used_percent, 90);
  assert.equal(row.source, 'self-report');
});

test('invalid percentages, labels and obsolete resets are discarded without aborting valid windows', () => {
  const { core, clock, root, meta } = setup();
  const invalid = [null, window(clock.t, { used_percent: -1 }), window(clock.t, { used_percent: 101 }),
    window(clock.t, { used_percent: '30' }), window(clock.t, { used_percent: null }), window(clock.t, { used_percent: NaN }),
    window(clock.t, { resets_at: 'invalid' }), window(clock.t, { resets_at: new Date(clock.t - 6 * 60_000).toISOString() }),
    window(clock.t, { label: '../bad' }), window(clock.t, { label: {} })];
  core.join({ root, quota: { windows: [...invalid, window(clock.t, { used_percent: 0 }), window(clock.t, { label: 'weekly', used_percent: 100 })] } }, meta);
  assert.deepEqual(core.usageWindows('claude').map(r => r.used_percent), [0, 100]);
});

test('missing or 30-minute-old usage prompts on offer, assignment and next in the AI language', async () => {
  const { core, clock, root, meta, advance } = setup();
  const joined = core.join({ root }, meta);
  assert.match(joined.quota_request, /get_usage/);
  const offer = await core.next({ participant: joined.participant });
  assert.match(offer.quota_request, /quota.windows/);
  const got = core.claim({ participant: joined.participant, task: offer.task, gen: offer.gen });
  assert.match(got.assignment.program.quota_request, /quota.windows/);
  core.recordUsageWindows([{ service: 'claude', window: '5h', used_percent: 20, resets_at: clock.t + 7200_000, fetched_at: clock.t, source: 'claude-code' }]);
  assert.equal((await core.next({ participant: joined.participant })).quota_request, undefined);
  assert.equal(core.claim({ participant: joined.participant, task: offer.task, gen: offer.gen }).assignment.program.quota_request, undefined);
  advance(30 * 60_000);
  core.setLanguages({ ai_language: 'ja' });
  assert.match((await core.next({ participant: joined.participant })).quota_request, /自分の使用量/);
  core.setProjectStop(core.one('SELECT project_id FROM participants WHERE id=?', joined.participant).project_id, true);
  const stopped = await core.next({ participant: joined.participant });
  assert.equal(stopped.kind, 'stop');
  assert.equal(stopped.quota_request, undefined);
});

test('progress report updates usage, ignores duplicate and stale reports, and leaves legacy limits intact', async () => {
  const { core, clock, root, meta, advance } = setup();
  const { participant } = core.join({ root }, meta);
  const task = await take(core, participant);
  core.setQuota('claude-ai', { state: 'limit', reset_at: new Date(clock.t + 3600_000).toISOString() });
  const report = { participant, task: task.task, gen: task.gen, report_id: 'progress', kind: 'progress', quota: { windows: [window(clock.t)] } };
  assert.equal(core.report(report).accepted, true);
  assert.equal(core.quotaView('claude-ai').state, 'limit_reported');
  assert.equal(core.usageWindows('claude')[0].used_percent, 35);
  advance(60_000);
  core.report({ ...report, quota: { windows: [window(clock.t, { used_percent: 99 })] } });
  assert.equal(core.usageWindows('claude')[0].used_percent, 35);
  core.report({ ...report, gen: task.gen - 1, report_id: 'stale', quota: { windows: [window(clock.t, { used_percent: 99 })] } });
  assert.equal(core.usageWindows('claude')[0].used_percent, 35);
});

test('kind limit with only windows still blocks new work until reset', async () => {
  const { core, clock, root, meta } = setup();
  const { participant } = core.join({ root }, meta);
  const task = await take(core, participant);
  const reset_at = new Date(clock.t + 3600_000).toISOString();
  core.report({ participant, task: task.task, gen: task.gen, report_id: 'limit', kind: 'limit', reset_at, quota: { windows: [window(clock.t)] } });
  assert.equal(core.quotaView('claude-ai').state, 'limit_reported');
  assert.equal(core.quotaView('claude-ai').blocked_until, Date.parse(reset_at));
});

test('unmapped clients can self-report without modifying a different service', () => {
  const { core, clock, root } = setup();
  core.join({ root, client: 'other-client', quota: { windows: [window(clock.t)] } });
  assert.equal(core.usageWindows('other-client').length, 1);
  assert.equal(core.usageWindows('claude').length, 0);
});

test('next attaches a current hint to immediate and held none responses', async () => {
  const { core, clock, root, meta } = setup();
  const { participant } = core.join({ root }, meta);
  const task = await take(core, participant);
  core.report({ participant, task: task.task, gen: task.gen, report_id: 'blocked', kind: 'blocked', body: 'waiting on human' });
  const immediate = await core.next({ participant });
  assert.equal(immediate.kind, 'none');
  assert.match(immediate.quota_request, /get_usage/);
  const pending = core.next({ participant, wait_seconds: 3600 });
  assert.ok(core.waiters.has(participant));
  core.recordUsageWindows([{ service: 'claude', window: '5h', used_percent: 25, resets_at: clock.t + 3600_000, fetched_at: clock.t, source: 'claude-code' }]);
  core.resolveWaiter(participant, { kind: 'none', again: true }, 'timeout');
  assert.equal((await pending).quota_request, undefined);
  const pendingStale = core.next({ participant, wait_seconds: 3600 });
  clock.t += 30 * 60_000;
  core.resolveWaiter(participant, { kind: 'none', again: true }, 'timeout');
  assert.match((await pendingStale).quota_request, /quota.windows/);
});

test('fresh automatic usage suppresses join, offer and assignment hints; unrelated usage does not', async () => {
  const { core, clock, root, meta } = setup();
  core.recordUsageWindows([{ service: 'codex', window: '5h', used_percent: 20, resets_at: clock.t + 7200_000, fetched_at: clock.t, source: 'codex-session' }]);
  assert.match(core.join({ root }, meta).quota_request, /quota.windows/);
  core.recordUsageWindows([{ service: 'claude', window: '5h', used_percent: 20, resets_at: clock.t + 7200_000, fetched_at: clock.t, source: 'claude-code' }]);
  const joined = core.join({ root }, meta);
  assert.equal(joined.quota_request, undefined);
  const offer = await core.next({ participant: joined.participant });
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.quota_request, undefined);
  assert.equal(core.claim({ participant: joined.participant, task: offer.task, gen: offer.gen }).assignment.program.quota_request, undefined);
});

test('a recent fetch with an expired reset or unknown percentage still requests usage', () => {
  const { core, clock, root, meta } = setup();
  core.recordUsageWindows([{ service: 'claude', window: '5h', used_percent: 20, resets_at: clock.t - 1, fetched_at: clock.t, source: 'claude-code' }]);
  assert.match(core.join({ root }, meta).quota_request, /quota.windows/);
  core.recordUsageWindows([{ service: 'claude', window: '5h', used_percent: null, resets_at: clock.t + 7200_000, fetched_at: clock.t, source: 'claude-code' }]);
  assert.match(core.join({ root }, meta).quota_request, /quota.windows/);
});
