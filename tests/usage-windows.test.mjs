import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, SCHEMA_VERSION } from '../src/db.mjs';
import { Core, Refusal } from '../src/core.mjs';
import { collectUsage, normalizeRecord } from '../src/usage/index.mjs';
import { codexCollector } from '../src/usage/collectors/codex.mjs';
import { antigravityCollector } from '../src/usage/collectors/antigravity.mjs';

const T0 = Date.parse('2026-11-14T10:00:00Z');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-usage-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const mk = (now = () => T0) => new Core(openDb(':memory:'), { now });
const rec = (o = {}) => ({ service: 'codex', window: '5h', resetAt: new Date(T0 + 60 * 60_000).toISOString(), periodMinutes: 300, usedPercent: 30, source: 'codex-session', fetchedAt: new Date(T0).toISOString(), ...o });

test('schema v9 creates usage_windows and participant_profiles.usage_service', () => {
  const db = openDb(':memory:');
  assert.equal(SCHEMA_VERSION, 9);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_windows'").get());
  assert.ok(db.prepare('PRAGMA table_info(participant_profiles)').all().some(c => c.name === 'usage_service'));
});

test('recordUsageWindows keeps the newest snapshot and rejects bad records', () => {
  const core = mk();
  assert.equal(core.recordUsageWindows([rec()]), 1);
  assert.equal(core.recordUsageWindows([rec({ usedPercent: 10, fetchedAt: new Date(T0 - 60_000).toISOString() })]), 0, 'older snapshot ignored');
  assert.equal(core.recordUsageWindows([rec({ usedPercent: 40, fetchedAt: new Date(T0 + 60_000).toISOString() })]), 1);
  assert.equal(core.recordUsageWindows([rec({ usedPercent: 140 }), rec({ service: 'bad name!' }), rec({ resetAt: 'x' })]), 0);
  const [row] = core.usageWindows('codex');
  assert.equal(row.used_percent, 40);
  assert.equal(row.remaining_minutes, 60);
  assert.equal(row.stale, false);
});

test('usageWindows rolls periodic windows forward, clears the old percentage and marks stale', () => {
  let now = T0;
  const core = mk(() => now);
  core.recordUsageWindows([rec()]);
  now = T0 + 90 * 60_000; // 30 min past the reset
  const [row] = core.usageWindows();
  assert.equal(row.remaining_minutes, 270);
  assert.equal(row.used_percent, null);
  assert.equal(row.stale, true);
});

test('syncUsage isolates failing collectors and records the rest', async () => {
  const core = mk();
  const good = { name: 'good', collect: async () => [rec()] };
  const bad = { name: 'bad', collect: async () => { throw new Error('boom'); } };
  const r = await core.syncUsage({ collectors: [bad, good] });
  assert.equal(r.saved, 1);
  assert.deepEqual(r.errors.map(e => e.collector), ['bad']);
  assert.equal(core.usageWindows().length, 1);
});

test('vendored codex collector reads only rate_limits from a synthetic session tail', async t => {
  const home = tmp(t);
  const dir = path.join(home, 'sessions', '2026', '11', '14');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    { timestamp: '2026-11-14T09:00:00.000Z', type: 'response_item', payload: { type: 'message', content: 'SECRET conversation text' } },
    { timestamp: '2026-11-14T09:30:00.000Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
      primary: { used_percent: 12, window_minutes: 300, resets_at: Math.floor(T0 / 1000) + 3600 },
      secondary: { used_percent: 55, window_minutes: 10080, resets_at: Math.floor(T0 / 1000) + 86400 } } } }
  ];
  fs.writeFileSync(path.join(dir, 'rollout-test.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const prev = process.env.CODEX_HOME; process.env.CODEX_HOME = home;
  t.after(() => { if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev; });
  const { records, errors } = await collectUsage({ collectors: [codexCollector], home: tmp(t), now: new Date(T0) });
  assert.deepEqual(errors, []);
  assert.deepEqual(records.map(r => [r.window, r.used_percent, r.period_minutes]), [['5h', 12, 300], ['weekly', 55, 10080]]);
  assert.ok(!JSON.stringify(records).includes('SECRET'));
});

test('vendored antigravity collector reads the quota-clock statusline cache', async t => {
  const home = tmp(t);
  fs.writeFileSync(path.join(home, 'antigravity.json'), JSON.stringify({ version: 1, fetchedAt: new Date(T0).toISOString(),
    quota: { 'gemini-5h': { remaining_fraction: 0.75, reset_time: new Date(T0 + 7200_000).toISOString() } } }));
  const { records } = await collectUsage({ collectors: [antigravityCollector], home, now: new Date(T0) });
  assert.equal(records.length, 1);
  assert.equal(records[0].service, 'antigravity');
  assert.equal(records[0].used_percent, 25);
});

test('manual entry, removal and validation', () => {
  const core = mk();
  core.setUsageManual({ service: 'claude', window: 'weekly', resets_at: Math.floor(T0 / 1000) + 3600, used_percent: 43, period_minutes: 10080 });
  const [row] = core.usageWindows('claude');
  assert.equal(row.source, 'manual');
  assert.equal(row.used_percent, 43);
  assert.throws(() => core.setUsageManual({ service: 'claude', window: '5h', resets_at: 'soon' }), Refusal);
  assert.throws(() => core.setUsageManual({ service: 'claude', window: '5h', resets_at: T0, used_percent: 101 }), Refusal);
  core.removeUsage('claude');
  assert.equal(core.usageWindows().length, 0);
});

test('participant service mapping: client default, per-label override', () => {
  const core = mk();
  const pid = core.createProject({ name: 'u' }).id;
  assert.equal(core.usageServiceFor({ project_id: pid, label: 'codex-sol', client: 'codex-mcp-client' }), 'codex');
  assert.equal(core.usageServiceFor({ project_id: pid, label: 'x', client: 'unknown' }), null);
  core.setProfile(pid, 'agy-argon', { usage_service: 'antigravity' });
  assert.equal(core.usageServiceFor({ project_id: pid, label: 'agy-argon', client: 'unknown' }), 'antigravity');
  assert.throws(() => core.setProfile(pid, 'agy-argon', { usage_service: 'bad name!' }), Refusal);
});

test('normalizeRecord accepts epoch seconds and ISO strings', () => {
  assert.equal(normalizeRecord({ service: 'a', window: 'w', resets_at: 1_800_000_000 }).resets_at, 1_800_000_000_000);
  assert.equal(normalizeRecord({ service: 'a', window: 'w', resetAt: '2026-11-14T10:00:00Z' }).resets_at, T0);
});

import { joinAs } from './helpers.mjs';
import { callTool, TOOLS } from '../src/tools.mjs';

test('usage MCP shows own project with caller first and mapped service windows', async t => {
  const core = mk();
  const root = tmp(t), otherRoot = tmp(t);
  const project = core.createProject({ name: 'one' }).id, other = core.createProject({ name: 'other' }).id;
  core.addRoot(project, root); core.addRoot(other, otherRoot);
  const a = joinAs(core, root, 'first', 'c1'), b = joinAs(core, root, 'second', 'c2'), foreign = joinAs(core, otherRoot, 'foreign', 'c3');
  core.setProfile(project, 'first', { usage_service: 'codex' });
  core.setProfile(project, 'second', { usage_service: 'codex' });
  core.setProfile(other, 'foreign', { usage_service: 'codex' });
  core.recordUsageWindows([rec()]);
  const { result } = await callTool(core, 'usage', { participant: b }, { conn: 'c2' });
  assert.deepEqual(result.participants.map(p => p.participant), [b, a]);
  assert.ok(!result.participants.some(p => p.participant === foreign));
  assert.deepEqual(result.participants[0].windows[0], core.usageWindows('codex')[0]);
  assert.equal(result.participants[0].windows[0].stale, false);
  assert.deepEqual(TOOLS.find(x => x.name === 'usage').inputSchema.required, ['participant']);
  const snap = core.snapshot();
  assert.equal(snap.usage_windows[0].service, 'codex');
  assert.equal(snap.projects.find(p => p.id === project).participants.find(p => p.id === b).usage_service_override, 'codex');
  assert.equal((await callTool(core, 'usage', { participant: b }, { conn: 'c1' })).refusal.code, 'not_yours');
});
