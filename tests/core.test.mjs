import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { Refusal } from '../src/core.mjs';
import { makeCore, seed, joinAs, take, done, facilitate, tmpDir } from './helpers.mjs';

const refused = (fn, code) => assert.throws(fn, e => e instanceof Refusal && e.code === code, `expected refusal ${code}`);
const W = { role: 'research', mode: 'read_only' };

test('unregistered folder: says so, guesses nothing, records a request for the human', () => {
  const { core } = makeCore();
  seed(core);
  const other = tmpDir('other');
  const r = core.join({ root: other }, { conn: 'c1', client: { name: 'codex' } });
  assert.equal(r.registered, false);
  assert.equal(r.participant, undefined);
  assert.equal(core.snapshot().root_requests.length, 1);
});

test('root lookup: sub-folder, case and separator differences resolve; longest root wins; one root one project', () => {
  const { core } = makeCore();
  const { root, project } = seed(core);
  const inner = path.join(root, 'pkg');
  const p2 = core.createProject({ name: '内側' }).id;
  fs.mkdirSync(inner, { recursive: true });
  core.addRoot(p2, inner);
  assert.equal(core.resolveRoot(path.join(root, 'src', 'a')).root.project_id, project);
  assert.equal(core.resolveRoot(path.join(inner, 'x')).root.project_id, p2);
  if (process.platform === 'win32') assert.equal(core.resolveRoot(root.toUpperCase().replace(/\\/g, '/') + '/').root.project_id, project);
  refused(() => core.addRoot(p2, root), 'root_taken');
});

test('full cycle: facilitator is created by rule, plans tasks, work is reported, goal becomes a candidate only', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'claude-code', 'c1');
  const b = joinAs(core, root, 'codex', 'c2');
  const { f, planned } = await facilitate(core, a, goal, [{ op: 'add_task', title: '調査', body: '競合を調べる', ...W }, { op: 'update_summary', current: '開始', next_step: '調査' }]);
  assert.equal(f.got.assignment.program.kind, 'facilitator');
  assert.equal(planned.applied, true);
  const w = await take(core, b);
  assert.equal(w.got.assignment.untrusted_ai_text.title, '調査', 'AI-written text is kept apart from human text');
  assert.equal(w.got.assignment.from_human.task_title, undefined);
  assert.equal(done(core, b, w.task, w.gen, { evidence: [{ kind: 'fact', text: '競合は3社', source: 'https://example.invalid' }] }).accepted, true);
  core.tick();
  const f2 = await take(core, b);
  assert.equal(f2.got.assignment.program.kind, 'facilitator');
  core.plan({ participant: b, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'propose_done', evidence: '証拠を満たした' }] });
  done(core, b, f2.task, f2.gen);
  assert.equal(core.goal(goal).status, 'done_candidate', 'an AI cannot close a goal');
  const d = core.snapshot().decisions.find(x => x.kind === 'done');
  core.answerDecision(d.id, 'confirm');
  assert.equal(core.goal(goal).status, 'done');
});

test('only the participant holding the offer can claim; 20 racing claims give exactly one assignee', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const ids = Array.from({ length: 20 }, (_, i) => joinAs(core, root, `app${i}`, `c${i}`));
  const offer = await core.next({ participant: ids[0] });
  let ok = 0;
  for (const id of ids) { try { core.claim({ participant: id, task: offer.task, gen: offer.gen }); ok++; } catch (e) { assert.ok(e instanceof Refusal); } }
  assert.equal(ok, 1);
  assert.equal(core.task(offer.task).assignee, ids[0]);
  assert.equal(core.goal(goal).assignments_used, 1);
});

test('stale generation and foreign reports are stored but change nothing; duplicate report ids are idempotent', async () => {
  const { core, pass } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const first = await take(core, a);
  pass(31 * 60_000); // read-only lease expires -> reopened with a new generation
  assert.equal(core.task(first.task).state, 'open');
  const second = await take(core, b);
  assert.equal(second.task, first.task);
  assert.equal(second.gen, first.gen + 1);
  const late = core.report({ participant: a, task: first.task, gen: first.gen, report_id: 'late', kind: 'result', body: 'old' });
  assert.equal(late.accepted, false); assert.equal(late.stop_work, true);
  assert.equal(core.task(first.task).state, 'claimed');
  const r1 = core.report({ participant: b, task: second.task, gen: second.gen, report_id: 'same', kind: 'result', body: 'new' });
  const r2 = core.report({ participant: b, task: second.task, gen: second.gen, report_id: 'same', kind: 'result', body: 'new' });
  assert.equal(r1.accepted, true); assert.equal(r2.duplicate, true);
  assert.equal(core.all('SELECT COUNT(*) c FROM reports WHERE task_id=? AND stale=0', first.task)[0].c, 1);
  assert.equal(core.goal(goal).assignments_used, 2, 'a new assignee does not reset the goal budget');
});

test('an unanswered offer returns to open without spending an attempt', async () => {
  const { core, pass } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const offer = await core.next({ participant: a });
  pass(121_000);
  const t = core.task(offer.task);
  assert.equal(t.state, 'open'); assert.equal(t.attempts, 0); assert.equal(t.gen, offer.gen);
  refused(() => core.claim({ participant: a, task: offer.task, gen: offer.gen }), 'not_offered');
});

test('a silent writing task is never re-assigned automatically; its own assignee can come back', async () => {
  const { core, pass, notes } = makeCore();
  const { root, goal } = seed(core, { delegation: { write_files: 'allow' } });
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: '実装', role: 'implement', mode: 'writes' }]);
  const w = await take(core, a);
  pass(31 * 60_000);
  assert.equal(core.task(w.task).state, 'needs_check');
  assert.ok(notes.some(n => n.kind === 'needs_check'));
  assert.equal((await core.next({ participant: b })).kind, 'none', 'nobody else is offered the half-written task');
  assert.equal(done(core, a, w.task, w.gen).accepted, true, 'the original assignee returned (e.g. after an approval dialog)');
  assert.equal(core.task(w.task).state, 'accepted');
});

test('needs_check: a human may reopen it, and the next assignee is told to look for traces first', async () => {
  const { core, pass } = makeCore();
  const { root, goal } = seed(core, { delegation: { write_files: 'allow' } });
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: '実装', role: 'implement', mode: 'writes' }]);
  const w = await take(core, a);
  pass(31 * 60_000);
  core.resolveNeedsCheck(w.task, 'reopen');
  const w2 = await take(core, b);
  assert.match(w2.got.assignment.handoff, /痕跡/);
  assert.equal(done(core, a, w.task, w.gen).accepted, false);
});

test('writing tasks cannot be created when the human did not allow file changes', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  await take(core, a);
  refused(() => core.plan({ participant: a, goal, base_version: 1, ops: [{ op: 'add_task', title: '実装', role: 'implement', mode: 'writes' }] }), 'not_delegated');
  assert.equal(core.goal(goal).plan_version, 1, 'a refused plan applies nothing');
});

test('everyone waiting with an unfinished goal yields exactly one facilitator, to the longest waiter', async () => {
  const { core, advance, pass } = makeCore({ holdInitial: 5000 });
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_evidence', kind: 'fact', text: '最初の根拠' }]);
  assert.equal((await core.next({ participant: a })).kind, 'offer');
  // a holds the only facilitator offer; let it lapse while both wait
  pass(121_000);
  const wa = core.next({ participant: a, wait_seconds: 5 });
  advance(10);
  const wb = core.next({ participant: b, wait_seconds: 5 });
  core.tick();
  const ra = await wa;
  assert.equal(ra.kind, 'offer');
  assert.equal(core.all("SELECT COUNT(*) c FROM tasks WHERE goal_id=? AND kind='facilitator' AND state IN ('open','offered','claimed')", goal)[0].c, 1);
  core.cancelWait(b);
  void wb;
});

test('facilitators without new evidence stop after the limit and go back to the human', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  for (let i = 0; i < 6 && core.goal(goal).status === 'active'; i++) { const f = await take(core, a); if (f.task) done(core, a, f.task, f.gen); core.tick(); }
  assert.equal(core.goal(goal).status, 'waiting_decision');
  const d = core.snapshot().decisions.find(x => x.kind === 'no_progress');
  assert.ok(d);
  assert.equal(core.all("SELECT COUNT(*) c FROM tasks WHERE goal_id=? AND kind='facilitator'", goal)[0].c, 3);
  core.answerDecision(d.id, 'continue', '対象客を変えて');
  core.tick();
  assert.equal(core.goal(goal).status, 'active');
  assert.equal((await core.next({ participant: a })).kind, 'offer');
});

test('global stop: held waits answer stop, nothing is offered, plans are refused, and no MCP call can lift it', async () => {
  const { core } = makeCore({ holdInitial: 5000 });
  const { root, goal, project } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const f = await take(core, a);
  const waiting = core.next({ participant: b, wait_seconds: 5 });
  core.setProjectStop(project, true);
  assert.equal((await waiting).kind, 'stop');
  assert.equal((await core.next({ participant: b })).kind, 'stop');
  refused(() => core.plan({ participant: a, goal, base_version: 1, ops: [{ op: 'add_task', title: 'x', ...W }] }), 'stopped');
  assert.equal(core.report({ participant: a, task: f.task, gen: f.gen, report_id: 'p', kind: 'progress' }).stop, true, 'a working assignee learns of the stop on its next call');
  core.tick();
  assert.equal(core.all("SELECT COUNT(*) c FROM tasks WHERE state='offered'")[0].c, 0);
});

test('assignment budget is counted per goal and ends in a human decision', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core, { budgets: { max_assignments: 2 } });
  const a = joinAs(core, root, 'a', 'c1');
  await facilitate(core, a, goal, [{ op: 'add_task', title: 't1', ...W }, { op: 'add_task', title: 't2', ...W }]);
  const w = await take(core, a); done(core, a, w.task, w.gen);
  assert.equal((await core.next({ participant: a })).kind, 'none');
  assert.equal(core.goal(goal).status, 'waiting_decision');
  const d = core.snapshot().decisions.find(x => x.kind === 'budget');
  core.answerDecision(d.id, 'extend', '5');
  assert.equal(core.budgets(core.goal(goal)).max_assignments, 7);
  assert.equal((await core.next({ participant: a })).kind, 'offer');
});

test('branches: limit of two, closing needs a reason, late results for a closed branch are kept out of conclusions', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core, { budgets: { max_parallel: 3 } });
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const f = await take(core, a);
  const v = () => core.goal(goal).plan_version;
  const p = core.plan({ participant: a, goal, base_version: v(), ops: [
    { op: 'add_branch', ref: 'A', hypothesis: '客層が違う' }, { op: 'add_branch', ref: 'B', hypothesis: '商品が弱い' },
    { op: 'add_task', ref: 'ta', title: 'A調査', branch: 'A', ...W }, { op: 'add_task', title: 'B調査', branch: 'B', ...W }] });
  const [brA] = p.created.filter(c => c.branch).map(c => c.branch);
  refused(() => core.plan({ participant: a, goal, base_version: v(), ops: [{ op: 'add_branch', hypothesis: '3本目' }] }), 'branch_limit');
  refused(() => core.plan({ participant: a, goal, base_version: v(), ops: [{ op: 'close_branch', branch: brA, verdict: 'rejected' }] }), 'bad_input');
  const w = await take(core, b);
  assert.equal(w.got.context.branch.id, brA);
  core.plan({ participant: a, goal, base_version: v(), ops: [{ op: 'close_branch', branch: brA, verdict: 'rejected', reason: '支払需要なし' }] });
  done(core, b, w.task, w.gen, { evidence: [{ kind: 'fact', text: '遅れて届いた結果' }] });
  const ev = core.all('SELECT * FROM evidence WHERE goal_id=?', goal);
  assert.equal(ev.find(e => e.text === '遅れて届いた結果').excluded, 1);
  assert.ok(ev.some(e => e.kind === 'rejection' && /支払需要なし/.test(e.text)), 'the rejection reason stays on record');
  assert.equal(core.task(w.task).flag, 'late_branch');
  done(core, a, f.task, f.gen);
});

test('plan based on an old version is refused and returns the current board', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await take(core, a);
  core.plan({ participant: a, goal, base_version: 1, ops: [{ op: 'update_summary', current: 'Aの要約' }] });
  assert.throws(() => core.plan({ participant: b, goal, base_version: 1, ops: [{ op: 'update_summary', current: 'Bが上書き' }] }), e => e.code === 'stale_plan' && e.extra.current.goals[0].current_summary === 'Aの要約');
  assert.equal(core.plan({ participant: b, goal, base_version: 1, ops: [{ op: 'add_evidence', text: '追記は版に関係なく可能' }] }).applied, true);
  assert.equal(core.goal(goal).summary, 'Aの要約');
});

test('decline excludes the decliner; handing a task back without new evidence is refused; redelegation is capped', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core, { budgets: { max_redelegate: 2 } });
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: '難題', ...W }]);
  const w = await take(core, b);
  core.report({ participant: b, task: w.task, gen: w.gen, report_id: 'd1', kind: 'decline', body: '無理' });
  assert.equal((await core.next({ participant: b })).kind, 'none', 'the decliner is not offered it again');
  refused(() => core.plan({ participant: a, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'reassign', task: w.task, prefer: b }] }), 'cycle');
  const w2 = await take(core, a);
  core.report({ participant: a, task: w2.task, gen: w2.gen, report_id: 'd2', kind: 'decline', body: '無理' });
  const c = joinAs(core, root, 'c', 'c3');
  const w3 = await take(core, c);
  core.report({ participant: c, task: w3.task, gen: w3.gen, report_id: 'd3', kind: 'decline', body: '無理' });
  assert.equal(core.task(w.task).state, 'parked');
  assert.ok(core.snapshot().decisions.some(d => d.kind === 'redelegate_limit'));
});

test('review goes to someone other than the author and can send the work back', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: '重要調査', review: true, ...W }]);
  const w = await take(core, a);
  assert.match(done(core, a, w.task, w.gen).state, /レビュー待ち/);
  assert.equal((await core.next({ participant: a })).kind, 'none', 'the author cannot review their own work');
  const r = await take(core, b);
  assert.equal(r.got.assignment.program.kind, 'review');
  refused(() => core.report({ participant: b, task: r.task, gen: r.gen, report_id: 'v0', kind: 'result', body: 'x' }), 'bad_input');
  core.report({ participant: b, task: r.task, gen: r.gen, report_id: 'v1', kind: 'result', verdict: 'rework', body: '出典がない' });
  const again = core.task(w.task);
  assert.equal(again.state, 'open'); assert.equal(again.gen, w.gen + 1); assert.match(again.handoff, /出典がない/);
});

test('a question parks the task; the human answer reopens it for the same assignee with the answer attached', async () => {
  const { core, notes } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const f = await take(core, a);
  core.report({ participant: a, task: f.task, gen: f.gen, report_id: 'q', kind: 'decision_needed', body: '有料APIを使ってよいか', options: ['はい', 'いいえ'] });
  assert.equal(core.task(f.task).state, 'parked');
  assert.ok(notes.some(n => n.kind === 'decision'));
  assert.ok(!notes.some(n => /有料API/.test(n.body)), 'notifications carry no content');
  const d = core.snapshot().decisions[0];
  core.answerDecision(d.id, 'いいえ', '無料枠のみ');
  const again = await take(core, a);
  assert.equal(again.task, f.task);
  assert.match(again.got.assignment.handoff, /無料枠のみ/);
});

test('another project\'s data cannot be read or claimed', async () => {
  const { core } = makeCore();
  const one = seed(core);
  const two = seed(core);
  const a = joinAs(core, one.root, 'a', 'c1');
  const b = joinAs(core, two.root, 'b', 'c2');
  const offer = await core.next({ participant: b });
  refused(() => core.get({ participant: a, ref: `goal:${two.goal}` }), 'not_found');
  refused(() => core.get({ participant: a, ref: `task:${offer.task}` }), 'not_found');
  refused(() => core.claim({ participant: a, task: offer.task, gen: offer.gen }), 'other_project');
  refused(() => core.plan({ participant: a, goal: two.goal, base_version: 1, ops: [{ op: 'add_evidence', text: 'x' }] }), 'other_project');
  assert.equal(core.get({ participant: a, ref: 'board' }).data.goals.length, 1);
});

test('sleep is not silence: leases get the gap back, and a restart reopens offers', async () => {
  const { core, advance } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const w = await take(core, a);
  advance(7 * 3600_000); core.tick(); // woke up after 7 hours
  assert.equal(core.task(w.task).state, 'claimed');
  assert.ok(core.all("SELECT 1 FROM events WHERE type='sleep_detected'").length === 1);
  done(core, a, w.task, w.gen); core.tick();
  const offer = await core.next({ participant: b });
  assert.equal(offer.kind, 'offer');
  core.recover();
  assert.equal(core.task(offer.task).state, 'open');
});

test('held wait: delivered when work appears, superseded by a newer wait, short answer on timeout', async () => {
  const { core } = makeCore({ holdInitial: 80, holdMin: 20 });
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const f = await take(core, a);
  const t0 = await core.next({ participant: b, wait_seconds: 30 });
  assert.deepEqual(Object.keys(t0).sort(), ['again', 'header', 'kind', 'quota_request'], 'a timed-out wait only adds the usage request when needed');
  assert.match(t0.quota_request, /quota.windows/);
  const w1 = core.next({ participant: b, wait_seconds: 30 });
  const w2 = core.next({ participant: b, wait_seconds: 30 });
  assert.equal((await w1).kind, 'superseded');
  core.plan({ participant: a, goal, base_version: 1, ops: [{ op: 'add_task', title: '新規', ...W }] });
  assert.equal((await w2).kind, 'offer');
  assert.equal(core.snapshot().projects[0].participants.find(p => p.id === b).state, 'active');
  done(core, a, f.task, f.gen);
});

test('capability level is measured, not assumed: L2 only after unattended cycles; a new app version resets it', async () => {
  const { core } = makeCore({ holdInitial: 2000 });
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const f = await take(core, a);
  const level = () => core.snapshot().clients.find(c => c.client === 'b').level;
  assert.equal(level(), 'L0');
  for (let i = 0; i < 3; i++) {
    const waiting = core.next({ participant: b, wait_seconds: 60 });
    core.plan({ participant: a, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'add_task', title: `t${i}`, ...W }] });
    const offer = await waiting;
    core.claim({ participant: b, task: offer.task, gen: offer.gen });
    done(core, b, offer.task, offer.gen);
    assert.equal(level(), i < 2 ? 'L1' : 'L2');
  }
  core.join({ root, label: 'b' }, { conn: 'c2', client: { name: 'b', version: '2.0' } });
  assert.equal(level(), 'L0');
  done(core, a, f.task, f.gen);
});

test('a reported usage limit pauses offers to that client until the reset time, then allows a try', async () => {
  const { core, advance } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  const f = await take(core, a);
  const reset = new Date(core.now() + 3600_000).toISOString();
  core.report({ participant: a, task: f.task, gen: f.gen, report_id: 'lim', kind: 'limit', body: '5時間枠', reset_at: reset });
  assert.equal(core.quotaView('a').state, 'limit_reported');
  assert.equal(core.task(f.task).state, 'open');
  assert.equal((await core.next({ participant: a })).kind, 'none');
  advance(5 * 60_000 + 1000); // preferred assignee is limited: after the grace period another app may take it
  assert.equal((await core.next({ participant: b })).kind, 'offer');
  advance(3600_000);
  assert.equal(core.quotaView('a').state, 'stale', 'reaching the reset time is not proof of recovery');
  assert.equal(core.limited('a'), false);
});

test('lost context: joining again restores held tasks; a resumed session invalidates its older copy', async () => {
  const { core } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const w = await take(core, a);
  const again = core.join({ root, label: 'a' }, { conn: 'c1', client: { name: 'a', version: '1.0' } });
  assert.equal(again.participant, a);
  assert.deepEqual(again.your_tasks.map(t => [t.task, t.gen]), [[w.task, w.gen]]);
  assert.equal((await core.next({ participant: a })).kind, 'resume');
  core.connClosed('c1'); core.connOpened('c9');
  const resumed = core.join({ root, label: 'a' }, { conn: 'c9', client: { name: 'a', version: '1.0' } });
  assert.equal(resumed.participant, a); assert.equal(resumed.resumed, true);
  assert.equal(resumed.your_tasks[0].gen, w.gen + 1);
  assert.equal(done(core, a, w.task, w.gen).accepted, false);
  assert.equal(done(core, a, w.task, w.gen + 1).accepted, true);
  // a second live conversation with the same name gets its own identity
  core.connOpened('c10');
  const twin = core.join({ root, label: 'a' }, { conn: 'c10', client: { name: 'a', version: '1.0' } });
  assert.notEqual(twin.participant, a);
});

test('revoking a participant sticks until a human allows it again', async () => {
  const { core } = makeCore();
  const { root } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const w = await take(core, a);
  core.revokeParticipant(a);
  refused(() => core.get({ participant: a, ref: 'board' }), 'revoked');
  refused(() => core.join({ root, label: 'a' }, { conn: 'c2', client: { name: 'a' } }), 'revoked');
  assert.equal(core.task(w.task).state, 'open');
});

test('paged reading and markdown export', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  await facilitate(core, a, goal, Array.from({ length: 12 }, (_, i) => ({ op: 'add_evidence', kind: 'fact', text: `根拠${i} ` + 'あ'.repeat(300) })));
  let cursor = 0, text = '', pages = 0;
  do { const r = core.get({ participant: a, ref: `evidence:${goal}`, limit: 1000, cursor }); text += r.partial_json_text; cursor = r.next_cursor; pages++; } while (cursor != null);
  assert.ok(pages > 3);
  assert.equal(JSON.parse(text).evidence.length, 12);
  assert.match(core.exportMarkdown(goal), /## 根拠・棄却理由[\s\S]*根拠11/);
});

test('work ready but nobody waiting: the human is told once that an app must be resumed', async () => {
  const { core, pass, notes } = makeCore();
  const { root, goal } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  await facilitate(core, a, goal, [{ op: 'add_task', title: '放置される仕事', ...W }]);
  assert.equal(core.offerableCount(core.goal(goal).project_id), 1);
  pass(7 * 60_000);
  assert.equal(notes.filter(n => n.kind === 'resume').length, 1);
  assert.equal(core.snapshot().projects[0].participants[0].state, 'needs_resume');
  const w = await take(core, a);
  assert.equal(w.offer.kind, 'offer');
  core.tick();
  assert.equal(core.stalled.size, 0);
});

test('a task reserved for a preferred assignee is not counted as offerable until the grace period ends', async () => {
  const { core, pass } = makeCore();
  const { root, goal, project } = seed(core);
  const a = joinAs(core, root, 'a', 'c1');
  const b = joinAs(core, root, 'b', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: 'bに頼みたい', prefer: 'b', ...W }]);
  assert.equal(core.offerableCount(project), 0);
  assert.equal((await core.next({ participant: a })).kind, 'none');
  assert.match((await core.next({ participant: a })).reason, /grace period|優先期間/i);
  assert.equal((await core.next({ participant: b })).kind, 'offer');
  pass(121_000); // b did not claim; later anyone may take it
  pass(5 * 60_000);
  assert.equal(core.offerableCount(project), 1);
  assert.equal((await core.next({ participant: a })).kind, 'offer');
});

test('offerable work is judged per app identity: a task that excludes an app does not justify starting that app', async () => {
  const { core } = makeCore();
  const { root, goal, project } = seed(core);
  const a = joinAs(core, root, 'claude-code', 'c1');
  joinAs(core, root, 'codex-mcp-client', 'c2');
  await facilitate(core, a, goal, [{ op: 'add_task', title: 'codex以外で', exclude: ['codex-mcp-client'], ...W }]);
  assert.equal(core.offerableCount(project), 1);
  assert.equal(core.offerableCount(project, 'codex-mcp-client'), 0);
  assert.equal(core.offerableCount(project, 'claude-code'), 1);
  core.setQuota('claude-code', { state: 'limit', reset_at: core.now() + 60_000 });
  assert.equal(core.offerableCount(project, 'claude-code'), 0);
});
