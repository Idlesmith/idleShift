// S-4: Same connection joining under a different label cannot self-review, claim, or accept/rework its own work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed, joinAs, take, facilitate } from './helpers.mjs';

test('S-4: same conn with different label cannot receive, claim, or accept/rework own review', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);

  // p1 joins on conn 'shared-conn' with label 'win-1'
  const p1 = joinAs(core, root, 'win-1', 'shared-conn');
  await facilitate(core, p1, goal, [
    { op: 'add_task', title: 'reviewed-work', body: 'do work', role: 'research', mode: 'read_only', review: true }
  ]);

  const w = await take(core, p1);
  core.report({ participant: p1, task: w.task, gen: w.gen, report_id: 'w-done', kind: 'result', body: 'ok' }, { conn: 'shared-conn' });
  core.tick();

  // p2 joins on the SAME conn 'shared-conn' with a different label 'win-2'
  const p2 = joinAs(core, root, 'win-2', 'shared-conn');
  assert.notEqual(p2, p1);

  // 1. p2 must NOT be offered the review task for p1's work
  const o2 = await core.next({ participant: p2, wait_seconds: 0 }, { conn: 'shared-conn' });
  assert.equal(o2.kind, 'none', 'same-conn alias must not be offered own review task');

  // 2. p2 must NOT be able to accept or rework p1's work via plan()
  assert.throws(
    () => core.plan({
      participant: p2,
      goal,
      base_version: core.goal(goal).plan_version,
      ops: [{ op: 'accept', task: w.task, reason: 'self-approve via alias' }]
    }, { conn: 'shared-conn' }),
    e => e.code === 'self_review'
  );
  assert.throws(
    () => core.plan({
      participant: p2,
      goal,
      base_version: core.goal(goal).plan_version,
      ops: [{ op: 'rework', task: w.task, reason: 'self-rework via alias' }]
    }, { conn: 'shared-conn' }),
    e => e.code === 'self_review'
  );

  // 3. A different conn ('other-conn') CAN still review and accept the work
  const p3 = joinAs(core, root, 'reviewer', 'other-conn');
  const rev = await take(core, p3);
  assert.equal(rev.offer.kind, 'offer');
  assert.equal(rev.offer.task_kind, 'review');
  const repRev = core.report({
    participant: p3, task: rev.task, gen: rev.gen, report_id: 'rev-ok',
    kind: 'result', verdict: 'accept', body: 'looks good'
  }, { conn: 'other-conn' });
  assert.equal(repRev.accepted, true);
  assert.equal(core.task(w.task).state, 'accepted');
});

test('S-4: direct claim of review task by same-conn participant is refused even if offered earlier', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);

  const p1 = joinAs(core, root, 'win-1', 'c1');
  const p2 = joinAs(core, root, 'win-2', 'c2');
  await facilitate(core, p1, goal, [
    { op: 'add_task', title: 'work-2', body: 'b', role: 'research', mode: 'read_only', review: true }
  ]);

  const w = await take(core, p1);
  core.report({ participant: p1, task: w.task, gen: w.gen, report_id: 'w2-done', kind: 'result', body: 'ok' }, { conn: 'c1' });
  core.tick();

  // p2 (on c2) gets the review offer
  const offer2 = await core.next({ participant: p2, wait_seconds: 0 }, { conn: 'c2' });
  assert.equal(offer2.kind, 'offer');

  // Now p2 reconnects on c1 (same conn as p1) before claiming -> claim must be refused as self_review
  core.connClosed('c2');
  core.join({ root, label: 'win-2' }, { conn: 'c1', client: { name: 'app', version: '1.0' } });
  assert.throws(
    () => core.claim({ participant: p2, task: offer2.task, gen: offer2.gen }, { conn: 'c1' }),
    e => e.code === 'self_review'
  );
});
