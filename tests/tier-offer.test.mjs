// T-57: task tiers, tier-aware offering, fallback and human usage limits.
// Profiles and the project policy are written straight into the tables here:
// the human-facing setters belong to another task (docs/tiers-contract.md §5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, done, facilitate } from './helpers.mjs';

const MIN = 60_000;
const R = { role: 'research', mode: 'read_only' };

function setProfile(core, project, label, tier, limits = {}) {
  core.run(`INSERT INTO participant_profiles(project_id,label,tier,limit_5h_claims,limit_5h_minutes,limit_7d_claims,limit_7d_minutes,updated_at) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,label) DO UPDATE SET tier=excluded.tier, limit_5h_claims=excluded.limit_5h_claims, limit_5h_minutes=excluded.limit_5h_minutes, limit_7d_claims=excluded.limit_7d_claims, limit_7d_minutes=excluded.limit_7d_minutes`,
    project, label, tier, limits.limit_5h_claims ?? null, limits.limit_5h_minutes ?? null, limits.limit_7d_claims ?? null, limits.limit_7d_minutes ?? null, core.now());
}
const setPolicy = (core, project, policy) => core.run('UPDATE projects SET tier_policy=? WHERE id=?', JSON.stringify(policy), project);
const peek = async (core, participant) => { const r = await core.next({ participant }); return r?.kind === 'offer' ? r.task : r.kind; };
const tierOf = (core, id) => core.task(id).tier;

// Project whose opening facilitator has been finished by `boss` with the given tasks.
async function setup(tasks, { timing, names = ['boss'] } = {}) {
  const state = makeCore(timing);
  const seeded = seed(state.core);
  const ids = {};
  for (const n of names) ids[n] = joinAs(state.core, seeded.root, n, `conn-${n}`);
  const { planned } = await facilitate(state.core, ids[names[0]], seeded.goal, tasks.map(t => ({ op: 'add_task', ...R, ...t })));
  return { ...state, ...seeded, ids, created: planned.created.map(c => c.task) };
}

// ---------- requirement 2: task tier ----------
test('tier: add_task stores the tier, defaults to any, and refuses an unknown value', async () => {
  const { core, goal, ids, created } = await setup([{ title: 'a' }, { title: 'b', tier: 'senior' }, { title: 'c', tier: 'worker' }, { title: 'd', tier: 'planner' }, { title: 'e', tier: 'any' }]);
  assert.deepEqual(created.map(id => tierOf(core, id)), ['any', 'senior', 'worker', 'planner', 'any']);
  const v = core.goal(goal).plan_version;
  assert.throws(() => core.plan({ participant: ids.boss, goal, base_version: v, ops: [{ op: 'add_task', title: 'x', ...R, tier: 'boss' }] }), e => e.code === 'bad_input');
  assert.equal(core.goal(goal).plan_version, v, 'a refused plan changes nothing');
  assert.equal(tierOf(core, core.addHumanTask(goal, { title: '人のタスク', tier: 'worker' }).id), 'worker');
  assert.throws(() => core.addHumanTask(goal, { title: '人のタスク', tier: 'x' }), e => e.code === 'bad_input');
});

// ---------- compatibility: nothing configured ----------
test('tier: with no tier, limit or policy set the hand-out is unchanged', async () => {
  const { core, ids, created } = await setup([{ title: '1' }, { title: '2' }, { title: '3' }], { names: ['boss', 'b'] });
  assert.equal(core.one("SELECT tier FROM tasks WHERE kind='facilitator'").tier, 'any');
  assert.equal(core.one('SELECT COUNT(*) c FROM tasks WHERE senior_review=1').c, 0);
  // Oldest first, to whoever asks; the second concurrent slot goes to the next task.
  assert.equal(await peek(core, ids.b), created[0]);
  assert.equal(await peek(core, ids.b), created[0], 'a repeated next shows the same offer');
  assert.equal(await peek(core, ids.boss), created[1]);
  const none = await core.next({ participant: joinAs(core, core.one('SELECT path_display d FROM roots').d, 'c', 'conn-c') });
  assert.equal(none.kind, 'none');
  assert.equal(none.limited_until, undefined);
});

test('tier: a participant without a tier can take a task of every tier', async () => {
  const { core, ids, created } = await setup([{ title: 'p', tier: 'planner' }, { title: 's', tier: 'senior' }, { title: 'w', tier: 'worker' }], { names: ['boss'] });
  for (const id of created) {
    const got = await take(core, ids.boss);
    assert.equal(got.task, id);
    done(core, ids.boss, got.task, got.gen);
    assert.equal(core.task(id).state, 'accepted');
    assert.equal(core.task(id).senior_review, 0);
  }
});

// ---------- requirement 3: default rule ----------
test('tier: a lower tier never takes a higher task by default; a higher tier may take a lower one', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }, { title: 'w', tier: 'worker' }], { names: ['boss', 'wk', 'sn'] });
  setProfile(core, project, 'boss', 'planner'); setProfile(core, project, 'wk', 'worker'); setProfile(core, project, 'sn', 'senior');
  const [s, w] = created;
  assert.equal(await peek(core, ids.wk), w, 'the worker skips the older senior task');
  pass(121_000); // the worker lets its offer lapse
  pass(24 * 60 * MIN);
  core.run("UPDATE tasks SET state='cancelled' WHERE id=?", w);
  assert.equal(await peek(core, ids.wk), 'none', 'no downgrade without a policy, however long the task waits');
  assert.equal(await peek(core, ids.sn), s);
});

test('tier: a higher tier takes lower work at once when nobody of that tier exists', async () => {
  const { core, project, ids, created } = await setup([{ title: 'w', tier: 'worker' }], { names: ['boss', 'sn'] });
  setProfile(core, project, 'boss', 'planner'); setProfile(core, project, 'sn', 'senior');
  assert.equal(await peek(core, ids.sn), created[0]);
});

test('tier: the exact tier is preferred; a higher tier takes over only after the grace period with no such participant waiting', async () => {
  // The second task only keeps the goal busy (no new facilitator); neither of the two may take it.
  const { core, project, goal, ids, created, pass, advance } = await setup([{ title: 'w', tier: 'worker' }, { title: 'hold', exclude: ['sn', 'wk'] }], { names: ['boss', 'sn', 'wk'] });
  setProfile(core, project, 'sn', 'senior'); setProfile(core, project, 'wk', 'worker');
  const [w] = created;
  assert.equal(await peek(core, ids.sn), 'none', 'inside the grace period the senior leaves worker work alone');
  const ws = core.next({ participant: ids.sn, wait_seconds: 5 });
  advance(10);
  const first = await core.next({ participant: ids.wk, wait_seconds: 5 });
  assert.equal(first.task, w);
  core.claim({ participant: ids.wk, task: w, gen: first.gen });
  done(core, ids.wk, w, first.gen);

  // Both wait, the senior for longer, and the task is past the grace period: still the worker's.
  const ww = core.next({ participant: ids.wk, wait_seconds: 5 });
  const w2 = core.addHumanTask(goal, { title: 'w2', tier: 'worker', ...R }).id;
  core.run('UPDATE tasks SET opened_at=opened_at-? WHERE id=?', 10 * MIN, w2);
  core.settle();
  assert.equal((await ww).task, w2);
  assert.equal(core.waiters.has(ids.sn), true);
  // The worker neither claims nor waits: now the senior may take it.
  pass(121_000);
  assert.equal((await ws).task, w2);
});

test('tier: among several open tasks a participant is offered the one of its own tier first', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 'w', tier: 'worker' }, { title: 'any' }, { title: 's', tier: 'senior' }], { names: ['boss', 'sn'] });
  setProfile(core, project, 'sn', 'senior');
  pass(6 * MIN);
  assert.equal(await peek(core, ids.sn), created[2]);
});

test('tier: a participant without a tier yields a tiered task to a waiting participant of that tier', async () => {
  const { core, project, ids, created } = await setup([{ title: 's', tier: 'senior' }], { names: ['boss', 'free', 'sn'] });
  setProfile(core, project, 'sn', 'senior');
  assert.equal(await peek(core, ids.free), 'none');
  assert.equal(await peek(core, ids.sn), created[0]);
});

// ---------- requirement 2: facilitator ----------
test('tier: the facilitator task is a planner task while a planner participant exists, and falls back to anyone after the grace period', async () => {
  const state = makeCore();
  const { core, pass } = state;
  const { root, project, goal } = seed(core);
  const pl = joinAs(core, root, 'pl', 'c1'), wk = joinAs(core, root, 'wk', 'c2');
  setProfile(core, project, 'pl', 'planner'); setProfile(core, project, 'wk', 'worker');
  // The opening facilitator was created before any tier existed.
  await facilitate(core, pl, goal);
  core.settle();
  const f2 = core.one("SELECT * FROM tasks WHERE kind='facilitator' AND state='open'");
  assert.equal(f2.tier, 'planner');
  assert.equal(await peek(core, wk), 'none', 'the worker does not take it while the planner may still come');
  assert.equal(await peek(core, pl), f2.id);
  pass(121_000);
  pass(6 * MIN);
  assert.equal(await peek(core, wk), f2.id, 'a missing planner must not stop the goal');
  const got = core.claim({ participant: wk, task: f2.id, gen: f2.gen });
  assert.equal(got.assignment.program.kind, 'facilitator');
  assert.equal(core.task(f2.id).senior_review, 0, 'the facilitator fallback is not a downgrade');

  // Without a planner the facilitator stays an ordinary task.
  core.revokeParticipant(pl);
  done(core, wk, f2.id, f2.gen);
  core.settle();
  assert.equal(core.one("SELECT tier FROM tasks WHERE kind='facilitator' AND state='open'").tier, 'any');
});

// ---------- requirement 3: downgrade policy ----------
test('tier: with a downgrade policy the next lower tier takes a waiting task and a senior review becomes mandatory', async () => {
  const { core, project, root, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }, { title: 'p', tier: 'planner' }], { names: ['boss', 'wk', 'sn'] });
  setProfile(core, project, 'boss', 'planner'); setProfile(core, project, 'wk', 'worker'); setProfile(core, project, 'sn', 'senior');
  setPolicy(core, project, { downgrade_after_minutes: 10 });
  const [s, p] = created;
  core.run("UPDATE tasks SET exclude=? WHERE id=?", JSON.stringify(['sn', 'boss']), p); // keep the planner task out of the way
  pass(9 * MIN);
  assert.equal(await peek(core, ids.wk), 'none', 'not before the configured time');
  pass(2 * MIN);
  // A senior who is waiting keeps the task in its own tier.
  const ws = core.next({ participant: ids.sn, wait_seconds: 5 });
  assert.equal((await ws).task, s);
  pass(121_000);
  assert.equal(await peek(core, ids.wk), s);
  assert.equal(core.task(p).state, 'open', 'a worker is two tiers below a planner task: never downgraded that far');
  const got = core.claim({ participant: ids.wk, task: s, gen: core.task(s).gen });
  assert.equal(core.task(s).senior_review, 1);
  assert.equal(core.task(s).review, 0, 'the plan did not ask for a review');
  const rep = done(core, ids.wk, s, got.assignment.program.gen);
  assert.match(rep.state, /reported/);
  assert.equal(core.task(s).state, 'reported');
  const review = core.one("SELECT * FROM tasks WHERE parent_id=? AND kind='review'", s);
  assert.equal(review.tier, 'senior');
  assert.deepEqual(JSON.parse(review.exclude), [ids.wk.toLowerCase()], 'the author is excluded from the review');

  // No senior to review: the review is never handed to the worker tier, however long it waits.
  const wk2 = joinAs(core, root, 'wk2', 'conn-wk2');
  setProfile(core, project, 'wk2', 'worker');
  pass(3 * 60 * MIN);
  assert.equal(await peek(core, wk2), 'none');
  assert.equal(await peek(core, ids.wk), 'none');
  const r = await take(core, ids.sn);
  assert.equal(r.task, review.id);
  core.report({ participant: ids.sn, task: review.id, gen: r.gen, report_id: 'rv', kind: 'result', verdict: 'accept', body: 'ok' });
  assert.equal(core.task(s).state, 'accepted');
});

test('tier: a task claimed by its own tier after an earlier downgrade is not forced into review', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }], { names: ['boss', 'wk', 'sn'] });
  setProfile(core, project, 'wk', 'worker'); setProfile(core, project, 'sn', 'senior');
  setPolicy(core, project, { downgrade_after_minutes: 1 });
  const [s] = created;
  pass(2 * MIN);
  const first = await take(core, ids.wk);
  assert.equal(core.task(s).senior_review, 1);
  core.report({ participant: ids.wk, task: s, gen: first.gen, report_id: 'd1', kind: 'decline', body: '無理' });
  const second = await take(core, ids.sn);
  assert.equal(second.task, s);
  assert.equal(core.task(s).senior_review, 0);
  done(core, ids.sn, s, second.gen);
  assert.equal(core.task(s).state, 'accepted');
});

// ---------- requirement 4 (offering side): usage limits ----------
test('limit: a participant at its human-set limit is not offered work; the task goes to another; the block ends with the window', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: '1' }, { title: '2' }, { title: '3' }], { names: ['boss', 'a', 'b'] });
  setProfile(core, project, 'a', null, { limit_5h_claims: 1 });
  const one = await take(core, ids.a);
  assert.equal(one.task, created[0]);
  assert.equal((await core.next({ participant: ids.a })).kind, 'resume', 'work in hand is never stopped by the limit');
  done(core, ids.a, one.task, one.gen);
  const none = await core.next({ participant: ids.a });
  assert.equal(none.kind, 'none');
  assert.match(none.reason, /usage limit|人が設定した使用量の上限/i);
  assert.equal(none.limited_until, new Date(core.usageBlock(project, 'a').until).toISOString());
  const waiting = core.next({ participant: ids.a, wait_seconds: 5 });
  core.settle();
  assert.equal(core.waiters.has(ids.a), true, 'a waiting participant over its limit is skipped');
  core.cancelWait(ids.a); void waiting;
  assert.equal(await peek(core, ids.b), created[1]);
  pass(121_000);
  pass(5 * 60 * MIN);
  assert.equal(await peek(core, ids.a), created[1]);
});

test('limit: an offer already made is withdrawn when the limit or the tier changes before the claim', async () => {
  const { core, project, ids, created } = await setup([{ title: '1', tier: 'senior' }], { names: ['boss', 'a', 'b'] });
  const [t] = created;
  // limit reached after the offer (a human lowered it)
  let offer = await core.next({ participant: ids.a });
  core.run('INSERT INTO usage_log(project_id,label,participant,task_id,gen,claimed_at,ended_at,outcome) VALUES(?,?,?,?,?,?,?,?)', project, 'a', ids.a, 'T-0', 1, core.now(), core.now(), 'result');
  setProfile(core, project, 'a', null, { limit_5h_claims: 1 });
  assert.throws(() => core.claim({ participant: ids.a, task: t, gen: offer.gen }), e => e.code === 'usage_limit');
  assert.equal(core.task(t).state, 'open');
  assert.equal(core.task(t).offered_to, null);
  assert.equal(core.one('SELECT COUNT(*) c FROM usage_log WHERE task_id=?', t).c, 0);

  // same through next: the stale offer is not shown again
  setProfile(core, project, 'a', null);
  offer = await core.next({ participant: ids.a });
  assert.equal(offer.task, t);
  setProfile(core, project, 'a', null, { limit_5h_claims: 1 });
  assert.equal((await core.next({ participant: ids.a })).kind, 'none');
  assert.equal(core.task(t).state, 'open');

  // tier lowered after the offer
  offer = await core.next({ participant: ids.b });
  assert.equal(offer.task, t);
  setProfile(core, project, 'b', 'worker');
  assert.throws(() => core.claim({ participant: ids.b, task: t, gen: offer.gen }), e => e.code === 'tier_mismatch');
  assert.equal(core.task(t).state, 'open');
  assert.equal(await peek(core, ids.b), 'none');
});

test('tier: lowering tier or raising downgrade_after_minutes after an offer withdraws it when downgrade time/waiting conditions are not met', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }], { names: ['boss', 'sn', 'wk'] });
  const [s] = created;
  core.setProfile(project, 'sn', { tier: 'senior' });
  core.setProfile(project, 'wk', { tier: 'worker' });
  core.setTierPolicy(project, { downgrade_after_minutes: 10 });

  // 1. Offered while senior; human changes participant to worker at 0 min (downgrade needs 10 min)
  let offer = await core.next({ participant: ids.sn });
  assert.equal(offer.task, s);
  core.setProfile(project, 'sn', { tier: 'worker' });
  assert.throws(() => core.claim({ participant: ids.sn, task: s, gen: offer.gen }), e => e.code === 'tier_mismatch');
  assert.equal(core.task(s).state, 'open');

  // 2. After 10 min, offered to worker; human extends downgrade_after_minutes to 20 min before claim
  pass(10 * MIN);
  offer = await core.next({ participant: ids.wk });
  assert.equal(offer.task, s);
  core.setTierPolicy(project, { downgrade_after_minutes: 20 });
  assert.equal((await core.next({ participant: ids.wk })).kind, 'none');
  assert.equal(core.task(s).state, 'open');
});

test('tier: plan accept cannot bypass mandatory senior review when the caller is a worker', async () => {
  const { core, project, goal, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }], { names: ['boss', 'wk1', 'wk2', 'sn'] });
  const [s] = created;
  core.setProfile(project, 'boss', { tier: 'planner' });
  core.setProfile(project, 'wk1', { tier: 'worker' });
  core.setProfile(project, 'wk2', { tier: 'worker' });
  core.setProfile(project, 'sn', { tier: 'senior' });
  core.setTierPolicy(project, { downgrade_after_minutes: 1 });

  pass(2 * MIN);
  const first = await take(core, ids.wk1);
  assert.equal(first.task, s);
  assert.equal(core.task(s).senior_review, 1);
  done(core, ids.wk1, s, first.gen);
  assert.equal(core.task(s).state, 'reported');

  const v = core.goal(goal).plan_version;
  // Another worker cannot directly accept a downgraded senior_review task via plan
  assert.throws(
    () => core.plan({ participant: ids.wk2, goal, base_version: v, ops: [{ op: 'accept', task: s, reason: 'looks ok' }] }),
    e => e.code === 'tier_mismatch'
  );
  assert.equal(core.task(s).state, 'reported');

  // A senior (or planner / untiered) can accept it via plan
  const applied = core.plan({ participant: ids.sn, goal, base_version: v, ops: [{ op: 'accept', task: s, reason: 'senior verified' }] });
  assert.equal(applied.applied, true);
  assert.equal(core.task(s).state, 'accepted');
});

test('tier: a review task for a downgraded work is never downgraded to another worker and applyReview rejects a worker reviewer', async () => {
  const { core, project, ids, created, pass } = await setup([{ title: 's', tier: 'senior' }], { names: ['boss', 'wk1', 'wk2', 'sn'] });
  const [s] = created;
  core.setProfile(project, 'boss', { tier: 'planner' });
  core.setProfile(project, 'wk1', { tier: 'worker' });
  core.setProfile(project, 'wk2', { tier: 'worker' });
  core.setProfile(project, 'sn', { tier: 'senior' });
  core.setTierPolicy(project, { downgrade_after_minutes: 1 });

  pass(2 * MIN);
  const first = await take(core, ids.wk1);
  assert.equal(first.task, s);
  done(core, ids.wk1, s, first.gen);
  const rv = core.one("SELECT * FROM tasks WHERE parent_id=? AND kind='review'", s);
  assert.equal(rv.tier, 'senior');

  // Even after waiting past downgrade_after_minutes, another worker (wk2) cannot receive the review task
  pass(60 * MIN);
  assert.equal(await peek(core, ids.wk2), 'none');
  assert.equal(core.tierGate(rv, core.one('SELECT * FROM participants WHERE id=?', ids.wk2)), 'no');

  // If a senior claims the review and is later demoted to worker before reporting, applyReview refuses the worker's review
  const rClaim = await take(core, ids.sn);
  assert.equal(rClaim.task, rv.id);
  core.setProfile(project, 'sn', { tier: 'worker' });
  assert.throws(
    () => core.report({ participant: ids.sn, task: rv.id, gen: rClaim.gen, report_id: 'demoted-rv', kind: 'result', verdict: 'accept', body: 'ok' }),
    e => e.code === 'tier_mismatch'
  );
  assert.equal(core.task(s).state, 'reported');

  // Restoring senior (or untiered) allows the review to succeed
  core.setProfile(project, 'sn', { tier: null });
  core.report({ participant: ids.sn, task: rv.id, gen: rClaim.gen, report_id: 'untiered-rv', kind: 'result', verdict: 'accept', body: 'ok' });
  assert.equal(core.task(s).state, 'accepted');
});

test('limit: when every planner is at its limit the facilitator goes to someone else after the grace period', async () => {
  const state = makeCore();
  const { core, pass } = state;
  const { root, project, goal } = seed(core);
  const pl = joinAs(core, root, 'pl', 'c1'), sn = joinAs(core, root, 'sn', 'c2');
  setProfile(core, project, 'pl', 'planner', { limit_7d_claims: 1 }); setProfile(core, project, 'sn', 'senior');
  await facilitate(core, pl, goal);
  core.settle();
  const f2 = core.one("SELECT * FROM tasks WHERE kind='facilitator' AND state='open'");
  assert.equal(f2.tier, 'planner');
  const wp = core.next({ participant: pl, wait_seconds: 5 });
  assert.equal(await peek(core, sn), 'none');
  pass(6 * MIN);
  assert.equal(await peek(core, sn), f2.id, 'a planner that waits but is over its limit does not hold the task');
  core.cancelWait(pl); void wp;
});

test('limit/tier: offerableCount (adapter start decision) follows the same rules', async () => {
  const { core, project, root, created } = await setup([{ title: 's', tier: 'senior' }, { title: 'a' }], { names: ['boss'] });
  joinAs(core, root, 'codex', 'conn-codex');
  assert.equal(core.offerableCount(project, 'codex'), 2);
  assert.equal(core.offerableCount(project), 2);
  setProfile(core, project, 'codex', 'worker');
  assert.equal(core.offerableCount(project, 'codex'), 1, 'the senior task is not for a worker');
  core.run('INSERT INTO usage_log(project_id,label,participant,task_id,gen,claimed_at) VALUES(?,?,?,?,?,?)', project, 'codex', 'P-x', created[0], 9, core.now());
  setProfile(core, project, 'codex', 'worker', { limit_5h_claims: 1 });
  assert.equal(core.offerableCount(project, 'codex'), 0);
  assert.equal(core.offerableCount(project), 2, 'the project-wide count is unchanged');
});
