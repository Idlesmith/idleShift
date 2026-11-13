import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from '../src/db.mjs';
import { Core } from '../src/core.mjs';

// Temporary folders are removed when the test process exits, so repeated runs
// do not pile up idleshift-* folders in %TEMP%. Set IDLESHIFT_KEEP_TMP=1 to keep them.
const created = [];
process.on('exit', () => {
  if (process.env.IDLESHIFT_KEEP_TMP === '1') return;
  for (const d of created) try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked: left for the OS */ }
});
export const tmpDir = name => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `idleshift-${name}-`)); created.push(d); return d; };

export function makeCore(timing = {}) {
  const clock = { t: Date.parse('2026-11-10T00:00:00Z') };
  const core = new Core(openDb(':memory:'), { now: () => clock.t, timing });
  core.on('error_log', e => { throw e; });
  const notes = [];
  core.on('notify', n => notes.push(n));
  const advance = ms => { clock.t += ms; };
  // Time passing while the service keeps ticking (unlike a jump, which looks like PC sleep).
  const pass = ms => { for (let left = ms; left > 0; left -= 30_000) { clock.t += Math.min(30_000, left); core.tick(); } };
  return { core, clock, advance, pass, notes };
}

// A project with one registered folder and one active goal.
export function seed(core, { delegation, budgets } = {}) {
  const root = tmpDir('root');
  const project = core.createProject({ name: 'テスト' }).id;
  core.addRoot(project, root);
  const goal = core.createGoal(project, { title: '検証ゴール', outcome: '成果', done_evidence: '証拠', delegation, budgets }).id;
  core.tick();
  return { root, project, goal };
}

export const joinAs = (core, root, name, conn) => {
  core.connOpened(conn);
  return core.join({ root, label: name }, { conn, client: { name, version: '1.0' } }).participant;
};

// Take the next offer and claim it.
export async function take(core, participant) {
  const offer = await core.next({ participant });
  if (offer.kind !== 'offer') return { offer };
  const got = core.claim({ participant, task: offer.task, gen: offer.gen });
  return { offer, got, task: offer.task, gen: offer.gen };
}

let rid = 0;
export const done = (core, participant, task, gen, extra = {}) => core.report({ participant, task, gen, report_id: `r${++rid}`, kind: 'result', body: 'ok', ...extra });

// Finish the opening facilitator task with a plan.
export async function facilitate(core, participant, goal, ops) {
  const f = await take(core, participant);
  const planned = ops ? core.plan({ participant, goal, base_version: core.goal(goal).plan_version, ops }) : null;
  done(core, participant, f.task, f.gen);
  core.tick();
  return { f, planned };
}
