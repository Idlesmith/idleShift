// Review #6: after restoring a backup, work reported after that backup must not be replayed through old connections, ids or generations.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { runService } from '../src/service.mjs';
import { pipePath } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

// A pipe client speaking the relay's protocol directly, so the test controls the connection.
async function pipeClient(home, token, name) {
  const sock = net.connect(pipePath(home));
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const pending = new Map(); let seq = 0; let closed = false;
  readline.createInterface({ input: sock }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
  sock.on('close', () => { closed = true; for (const r of pending.values()) r({ error: 'closed' }); });
  sock.on('error', () => {});
  const req = (method, params) => new Promise(r => { if (closed) return r({ error: 'closed' }); const id = ++seq; pending.set(id, r); sock.write(JSON.stringify({ id, method, params }) + '\n'); });
  const clientNonce = crypto.randomBytes(16).toString('hex');
  const h1 = await req('hello', { nonce: clientNonce, pid: process.pid, version: '1' });
  assert.equal(h1.result?.ok, true);
  const serverProof = crypto.createHmac('sha256', token).update(`server:${clientNonce}`).digest('hex');
  assert.equal(h1.result.proof, serverProof);
  const clientProof = crypto.createHmac('sha256', token).update(`client:${h1.result.challenge}`).digest('hex');
  const h2 = await req('hello_verify', { proof: clientProof });
  assert.equal(h2.result?.ok, true);
  const call = async (tool, args) => { const m = await req('tool', { name: tool, args, client: { name, version: '1' } }); if (m.error) return { transport_error: m.error }; return m.result.refusal ? { refused: true, ...m.result.refusal } : m.result.result; };
  return { call, isClosed: () => closed, close: () => sock.destroy() };
}

test('#6: restore invalidates connections and post-backup work cannot be replayed', async t => {
  const home = tmpDir('restore-home');
  const root = tmpDir('restore-work');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());
  const gui = async (method, params) => { const r = await fetch(`http://127.0.0.1:${svc.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token }, body: JSON.stringify({ method, params }) }); return r.json(); };
  const project = (await gui('createProject', { name: '復元試験' })).result.id;
  await gui('addRoot', { project, path: root });
  await gui('createGoal', { project, goal: { title: '復元ゴール' } });

  const a = await pipeClient(home, svc.token, 'app-a');
  const ja = await a.call('join', { root });
  let offer;
  for (let i = 0; i < 40; i++) { offer = await a.call('next', { participant: ja.participant }); if (offer.kind === 'offer') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(offer.kind, 'offer');
  await a.call('claim', { participant: ja.participant, task: offer.task, gen: offer.gen });

  const backup = path.basename((await gui('backupNow', {})).result.file);
  const first = await a.call('report', { participant: ja.participant, task: offer.task, gen: offer.gen, report_id: 'r1', kind: 'result', body: 'バックアップ後の結果' });
  assert.equal(first.accepted, true);

  assert.equal((await gui('restoreBackup', { name: backup })).ok, true);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(a.isClosed(), true, 'connections from before the restore are closed');

  const b = await pipeClient(home, svc.token, 'app-a');
  const stale = await b.call('report', { participant: ja.participant, task: offer.task, gen: offer.gen, report_id: 'r1', kind: 'result', body: '再送' });
  assert.ok(stale.refused || stale.accepted === false, 'an old id/generation cannot report without joining again');
  const task = svc.ctx.core.task(offer.task);
  assert.notEqual(task.state, 'accepted', 'the replayed result did not finish the task');
  assert.ok(task.gen > offer.gen, 'the generation moved past the one handed out before the restore');

  const again = await b.call('join', { root });
  assert.equal(again.registered, true);
  const late = await b.call('report', { participant: again.participant, task: offer.task, gen: offer.gen, report_id: 'r1', kind: 'result', body: '再送' });
  assert.equal(late.accepted, false, 'even after re-joining, the pre-restore generation is stale');
  let next = await b.call('next', { participant: again.participant });
  for (let i = 0; i < 20 && next.kind !== 'offer' && next.kind !== 'resume'; i++) { await new Promise(r => setTimeout(r, 100)); next = await b.call('next', { participant: again.participant }); }
  assert.ok(['offer', 'resume'].includes(next.kind), 'normal work continues after re-joining');
  b.close();
});

import { openDb, backupTo } from '../src/db.mjs';
import { Core } from '../src/core.mjs';

// Restores of any mix of snapshots must never hand out a generation or id that any earlier timeline used.
// The high-watermark lives outside the database, like the service keeps it in restore-watermark.json.
function harness() {
  const dir = tmpDir('restore-mix');
  const now = () => Date.parse('2026-11-10T00:00:00Z');
  let W = null; let n = 0;
  const open = file => { const c = new Core(openDb(file), { now }); return c; };
  const restore = (current, snapshot) => {
    W = Core.mergeWatermarks(W, current.watermark());
    current.db.close();
    const file = path.join(dir, `live-${++n}.db`);
    fs.copyFileSync(snapshot, file);
    const c = open(file);
    c.recover();
    c.invalidateAfterRestore(W);
    return c;
  };
  const snap = (core, name) => backupTo(core.db, path.join(dir, name));
  return { dir, open, restore, snap, now };
}

async function work(core, root, conn) {
  core.connOpened(conn);
  const pid = core.join({ root, label: 'a' }, { conn, client: { name: 'a' } }).participant;
  let o = await core.next({ participant: pid });
  if (o.kind === 'resume') o = { task: o.task, gen: o.gen };
  core.claim({ participant: pid, task: o.task, gen: o.gen });
  const gen = core.task(o.task).gen;
  const added = core.createGoal(core.one('SELECT id FROM projects').id, { title: 'new' }).id;
  return { pid, task: o.task, gen, added };
}

test('#6 (rework 2): mixing snapshots across restores never reuses generations or ids', async () => {
  const h = harness();
  const root = tmpDir('restore-mix-root');
  let c = h.open(path.join(h.dir, 'live-0.db'));
  const project = c.createProject({ name: 'p' }).id;
  c.addRoot(project, root);
  c.createGoal(project, { title: 'g' });
  c.tick();
  const base = h.snap(c, 'base.db');

  c = h.restore(c, base);                       // timeline 1
  const s1 = h.snap(c, 's1.db');
  c = h.restore(c, s1);                         // timeline 2, from a snapshot taken after a restore
  const t2 = await work(c, root, 'k2');
  assert.equal(c.report({ participant: t2.pid, task: t2.task, gen: t2.gen, report_id: 'done', kind: 'result', body: 'x' }).accepted, true);

  c = h.restore(c, base);                       // timeline 3, back to the original base
  const t3 = await work(c, root, 'k3');
  assert.ok(t3.gen > t2.gen, `generation must move past every earlier one (${t3.gen} > ${t2.gen})`);
  assert.notEqual(t3.added, t2.added, 'ids are not reused');
  const replay = c.report({ participant: t3.pid, task: t2.task, gen: t2.gen, report_id: 'done', kind: 'result', body: 'x' });
  assert.equal(replay.accepted, false);
  assert.notEqual(c.task(t2.task).state, 'accepted');
  for (let i = 0; i < 20; i++) c = h.restore(c, i % 2 ? base : s1);
  assert.ok(c.one('SELECT MAX(gen) m FROM tasks').m < 1e6, 'generations grow slowly, not exponentially');
});

test('#6 (rework 2): the real service keeps the watermark across restarts, and refuses to restore with a corrupt one', async () => {
  const home = tmpDir('restore-svc');
  let svc = await runService({ home, quiet: true, adaptersEnabled: false });
  const gui = async (method, params) => (await (await fetch(`http://127.0.0.1:${svc.port}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-idleshift-token': svc.token }, body: JSON.stringify({ method, params }) })).json());
  const project = (await gui('createProject', { name: 'p' })).result.id;
  const g1 = (await gui('createGoal', { project, goal: { title: 'g' } })).result.id;
  const base = path.basename((await gui('backupNow', {})).result.file);
  await gui('createGoal', { project, goal: { title: 'after backup' } });
  assert.equal((await gui('restoreBackup', { name: base })).ok, true);
  const afterFirst = (await gui('createGoal', { project, goal: { title: 'timeline 1' } })).result.id;
  await svc.stop();
  svc = await runService({ home, quiet: true, adaptersEnabled: false });
  assert.equal((await gui('restoreBackup', { name: base })).ok, true);
  const afterSecond = (await gui('createGoal', { project, goal: { title: 'timeline 2' } })).result.id;
  const num = id => Number(id.split('-')[1]);
  assert.ok(num(afterSecond) > num(afterFirst), `ids keep increasing across a restart (${afterSecond} > ${afterFirst})`);
  fs.writeFileSync(path.join(home, 'restore-watermark.json'), '{broken');
  const refused = await gui('restoreBackup', { name: base });
  assert.equal(refused.ok, false, 'a corrupt watermark refuses the restore instead of starting from zero');
  assert.ok(svc.ctx.core.one('SELECT id FROM goals WHERE id=?', afterSecond), 'data was not replaced');
  void g1;
  await svc.stop();
});
