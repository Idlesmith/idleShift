// A-5: folder registration refuses relative, missing and file paths; the
// write refusal points to ask_permission, not ask_human.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Refusal } from '../src/core.mjs';
import { makeCore, seed, joinAs, take, tmpDir } from './helpers.mjs';

const refusedWith = (fn, code, re) => assert.throws(fn, e => e instanceof Refusal && e.code === code && re.test(e.message), `expected ${code} ${re}`);

test('addRoot refuses a drive-relative path (lost separators), a missing folder and a file', () => {
  const { core } = makeCore();
  const p = core.createProject({ name: 'p' }).id;
  if (process.platform === 'win32') refusedWith(() => core.addRoot(p, 'C:AI_HUBconclavity'), 'bad_input', /absolute path|絶対パス/i);
  refusedWith(() => core.addRoot(p, 'relative/folder'), 'bad_input', /absolute path|絶対パス/i);
  const base = tmpDir('a5');
  refusedWith(() => core.addRoot(p, path.join(base, 'missing')), 'bad_input', /not found|見つかりません/i);
  const file = path.join(base, 'f.txt'); fs.writeFileSync(file, 'x');
  refusedWith(() => core.addRoot(p, file), 'bad_input', /not a folder|ファイル/i);
  assert.equal(core.addRoot(p, base).ok, true);
});

test('a writes task in a goal without write delegation is refused with ask_permission guidance', async () => {
  const { core } = makeCore();
  const { root, goal } = seed(core);
  const P = joinAs(core, root, 'a', 'c1');
  await take(core, P);
  refusedWith(() => core.plan({ participant: P, goal, base_version: core.goal(goal).plan_version, ops: [{ op: 'add_task', title: 't', body: 'b', role: 'implement', mode: 'writes' }] }), 'not_delegated', /(?:ask_permission|not allowed|許可されていません)/i);
});

test('renameProject changes the display name and keeps the id; the GUI offers it', () => {
  const { core } = makeCore();
  const p = core.createProject({ name: '旧名' }).id;
  core.renameProject(p, '  新名  ');
  assert.equal(core.project(p).name, '新名');
  assert.equal(core.project(p).id, p);
  const gui = fs.readFileSync(path.join(import.meta.dirname, '..', 'gui', 'app.js'), 'utf8');
  assert.match(gui, /api\('renameProject'/);
});
