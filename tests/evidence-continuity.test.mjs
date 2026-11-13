// F-3 継続の実証：会話を捨てて別のAIが引き継ぐ（一時 IDLESHIFT_HOME 上の実サービス・実リレー検証）
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { runService } from '../src/service.mjs';
import { APP_ROOT } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

function mcpClient(home, name) {
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'idleshift.mjs'), 'mcp'], {
    env: { ...process.env, IDLESHIFT_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (tool, args) => {
    const r = await rpc('tools/call', { name: tool, arguments: args });
    return { ...JSON.parse(r.result.content[0].text), isError: r.result.isError };
  };
  return {
    child,
    call,
    init: () => rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1.0' } }),
    close: () => child.kill()
  };
}

const delay = ms => new Promise(r => setTimeout(r, ms));

test('continuity (1)-(3): same-label resume, service restart persistence, lease-expired handoff to another AI', async t => {
  const home = tmpDir('continuity-home');
  const root = tmpDir('continuity-work');

  let fakeNow = Date.now();
  let svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc?.stop());
  svc.ctx.core.now = () => fakeNow;

  const pr = svc.ctx.core.createProject({ name: '継続性実証' });
  svc.ctx.core.addRoot(pr.id, root);
  const goal = svc.ctx.core.createGoal(pr.id, {
    title: 'F-3 継続性',
    outcome: '会話を捨てても進捗と証拠を引き継げる',
    done_evidence: '自動テスト通過'
  });
  svc.ctx.core.tick();

  // --- 準備: Participant A (app-a) がファシリテートして作業タスクを作成し、progress と証拠を記録 ---
  const clientA1 = mcpClient(home, 'app-a');
  t.after(() => { try { clientA1.close(); } catch {} });
  await clientA1.init();

  const joinA1 = await clientA1.call('join', { root, label: 'worker-a' });
  assert.ok(!joinA1.isError, JSON.stringify(joinA1));
  const pA = joinA1.participant;

  // 初期 facilitate タスク (T-1) を完了して作業タスク (T-2) を作る
  const offerFac = await clientA1.call('next', { participant: pA, wait_seconds: 0 });
  assert.equal(offerFac.kind, 'offer');
  const claimFac = await clientA1.call('claim', { participant: pA, task: offerFac.task, gen: offerFac.gen });
  assert.ok(!claimFac.isError, JSON.stringify(claimFac));
  assert.equal(claimFac.assignment.program.task, offerFac.task);

  const planRes = await clientA1.call('plan', {
    participant: pA,
    goal: goal.id,
    base_version: 1,
    ops: [
      { op: 'update_summary', current: 'Step1完了済み、Step2待機', next_step: 'Step2を実施' },
      { op: 'add_evidence', kind: 'file_read', text: 'Aが調査した結論', source: 'src/dummy.mjs' },
      { op: 'add_task', title: '継続タスク', body: 'Step1とStep2を実施する', role: 'research', mode: 'read_only' }
    ]
  });
  assert.ok(!planRes.isError, JSON.stringify(planRes));
  const t2 = planRes.created.find(c => c.task).task;

  const repFac = await clientA1.call('report', {
    participant: pA, task: offerFac.task, gen: offerFac.gen,
    report_id: 'fac-a-1', kind: 'result', summary: '計画作成完了', body: 'T-2を作成した'
  });
  assert.equal(repFac.accepted, true);
  svc.ctx.core.tick();

  // A が T-2 を claim し、progress 報告 + evidence を残す
  const offerT2 = await clientA1.call('next', { participant: pA, wait_seconds: 0 });
  assert.equal(offerT2.kind, 'offer');
  assert.equal(offerT2.task, t2);
  const claimT2A1 = await clientA1.call('claim', { participant: pA, task: t2, gen: offerT2.gen });
  assert.ok(!claimT2A1.isError, JSON.stringify(claimT2A1));
  assert.equal(claimT2A1.assignment.program.task, t2);

  const progA = await clientA1.call('report', {
    participant: pA,
    task: t2,
    gen: offerT2.gen,
    report_id: 'prog-a-1',
    kind: 'progress',
    summary: '半分完了',
    body: 'AがStep1まで完了。残りはStep2。',
    evidence: [{ kind: 'file_read', text: '確認済みファイル', source: 'src/dummy.mjs' }]
  });
  assert.equal(progA.accepted, true);

  // --- シナリオ1: 会話を捨てて同一 label ('worker-a') で再接続 ---
  clientA1.close();
  await delay(150);

  const clientA2 = mcpClient(home, 'app-a');
  t.after(() => { try { clientA2.close(); } catch {} });
  await clientA2.init();

  const joinA2 = await clientA2.call('join', { root, label: 'worker-a' });
  assert.equal(joinA2.participant, pA);
  assert.equal(joinA2.resumed, true);
  const heldA2 = joinA2.your_tasks.find(x => x.task === t2);
  assert.ok(heldA2, '同じ label の再参加で保持タスクが復元される');
  assert.ok(heldA2.gen > offerT2.gen, '再接続で gen が繰り上がる');

  // 新しい gen で再 claim でき、過去の progress が取得できる
  const claimT2A2 = await clientA2.call('claim', { participant: pA, task: t2, gen: heldA2.gen });
  assert.ok(!claimT2A2.isError, JSON.stringify(claimT2A2));
  assert.equal(claimT2A2.assignment.program.task, t2);
  const repsA2 = await clientA2.call('get', { participant: pA, ref: `reports:${t2}` });
  assert.ok(repsA2.data.reports.some(r => r.body === 'AがStep1まで完了。残りはStep2。'));

  // --- シナリオ2: サービス再起動を跨いでの永続性 ---
  clientA2.close();
  await delay(150);
  const oldSvc = svc;
  svc = null;
  await oldSvc.stop();

  svc = await runService({ home, quiet: true, adaptersEnabled: false });
  svc.ctx.core.now = () => fakeNow;

  const clientA3 = mcpClient(home, 'app-a');
  t.after(() => { try { clientA3.close(); } catch {} });
  await clientA3.init();

  const joinA3 = await clientA3.call('join', { root, label: 'worker-a' });
  assert.equal(joinA3.participant, pA);
  assert.equal(joinA3.resumed, true);
  assert.ok(joinA3.your_tasks.some(x => x.task === t2), 'サービス再起動後も保持タスクが維持される');

  const goalAfterRestart = await clientA3.call('get', { participant: pA, ref: `goal:${goal.id}` });
  assert.equal(goalAfterRestart.data.current_summary, 'Step1完了済み、Step2待機');

  const evAfterRestart = await clientA3.call('get', { participant: pA, ref: `evidence:${goal.id}` });
  assert.ok(evAfterRestart.data.evidence.some(e => e.text.includes('Aが調査した結論')));
  assert.ok(evAfterRestart.data.evidence.some(e => e.source === 'src/dummy.mjs' || e.text.includes('src/dummy.mjs')));

  const repsAfterRestart = await clientA3.call('get', { participant: pA, ref: `reports:${t2}` });
  assert.ok(repsAfterRestart.data.reports.some(r => r.body === 'AがStep1まで完了。残りはStep2。'));

  // A はそのまま離脱（会話破棄）
  clientA3.close();
  await delay(150);

  // --- シナリオ3: リース期限切れ後、別クライアント app-b (Participant B) がタスクと履歴を引き継ぐ ---
  // sleepGap を踏まないよう 30 秒刻みで 31 分進めて tick() を回す
  for (let left = 31 * 60_000; left > 0; left -= 30_000) {
    fakeNow += Math.min(30_000, left);
    svc.ctx.core.tick();
  }
  assert.equal(svc.ctx.core.task(t2).state, 'open');

  const clientB = mcpClient(home, 'app-b');
  t.after(() => { try { clientB.close(); } catch {} });
  await clientB.init();

  const joinB = await clientB.call('join', { root, label: 'worker-b' });
  const pB = joinB.participant;
  assert.notEqual(pB, pA);
  const goalB = await clientB.call('get', { participant: pB, ref: `goal:${goal.id}` });
  assert.equal(goalB.data.current_summary, 'Step1完了済み、Step2待機');

  const offerB = await clientB.call('next', { participant: pB, wait_seconds: 0 });
  assert.equal(offerB.kind, 'offer');
  assert.equal(offerB.task, t2);

  const claimB = await clientB.call('claim', { participant: pB, task: t2, gen: offerB.gen });
  assert.ok(!claimB.isError, JSON.stringify(claimB));
  assert.equal(claimB.assignment.program.task, t2);

  // B が get() でタスク・過去レポート・証拠を取得できる
  const taskInfoB = await clientB.call('get', { participant: pB, ref: `task:${t2}` });
  assert.equal(taskInfoB.data.task, t2);
  const reportsB = await clientB.call('get', { participant: pB, ref: `reports:${t2}` });
  assert.ok(reportsB.data.reports.some(r => r.body === 'AがStep1まで完了。残りはStep2。'));
  const evidenceB = await clientB.call('get', { participant: pB, ref: `evidence:${goal.id}` });
  assert.ok(evidenceB.data.evidence.some(e => e.text.includes('Aが調査した結論')));
  assert.ok(evidenceB.data.evidence.some(e => e.source === 'src/dummy.mjs' || e.text.includes('src/dummy.mjs')));

  // B が引き継いで完了報告する
  const resB = await clientB.call('report', {
    participant: pB,
    task: t2,
    gen: offerB.gen,
    report_id: 'res-b-1',
    kind: 'result',
    summary: 'Step2完了',
    body: 'Aの調査と進捗を引き継いで完了した。',
    evidence: [{ kind: 'file_read', text: 'Bが完了確認', source: 'src/dummy.mjs' }]
  });
  assert.equal(resB.accepted, true);
  assert.equal(svc.ctx.core.task(t2).state, 'accepted');
});
