import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkMergeConflict, checkLegacyMergeConflict, executeMerge, hasGitIdentity } from '../src/git.mjs';

test('merge without configured identity uses a temporary identity', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'empty-config'); fs.writeFileSync(config, '');
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL, oldSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => { if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal; if (oldSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = oldSystem; });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init');
  fs.writeFileSync(path.join(dir, 'base'), 'base'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base');
  git('checkout', '-b', 'feature'); fs.writeFileSync(path.join(dir, 'feature'), 'feature'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'feature');
  assert.equal(checkMergeConflict(dir, 'HEAD~1', 'feature').ok, true);
  git('checkout', '-'); fs.writeFileSync(path.join(dir, 'main'), 'main'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'main');
  assert.equal(hasGitIdentity(dir), false);
  assert.equal(checkMergeConflict(dir, 'HEAD', 'feature').ok, true);
  assert.equal(checkLegacyMergeConflict(dir, 'HEAD', 'feature').ok, true);
  assert.equal(executeMerge({ repoRoot: dir, branch: 'feature', taskId: 'T-1' }).ok, true);
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'IdleShift <idleshift@localhost>');
  assert.equal(hasGitIdentity(dir), false);
});


test('legacy merge preview detects content conflicts', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init'); fs.writeFileSync(path.join(dir, 'f'), 'base\n'); git('add', '.'); git('commit', '-m', 'base');
  git('checkout', '-b', 'feature'); fs.writeFileSync(path.join(dir, 'f'), 'feature\n'); git('commit', '-am', 'feature');
  git('checkout', '-'); fs.writeFileSync(path.join(dir, 'f'), 'main\n'); git('commit', '-am', 'main');
  assert.equal(checkLegacyMergeConflict(dir, 'HEAD', 'feature').conflict, true);
  assert.equal(checkLegacyMergeConflict(dir, 'HEAD', 'missing'), null);
});
import { openDb } from '../src/db.mjs';
import { Core } from '../src/core.mjs';
import { joinAs, facilitate } from './helpers.mjs';

test('claim warns when Git identity is missing', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idleshift-claim-identity-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
  const config = path.join(tmp, 'empty'); fs.writeFileSync(config, '');
  const oldGlobal = process.env.GIT_CONFIG_GLOBAL, oldSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = config; process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => { if (oldGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = oldGlobal; if (oldSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = oldSystem; });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: repo, stdio: 'pipe' });
  git('init'); fs.writeFileSync(path.join(repo, 'file'), 'x'); git('add', '.'); git('commit', '-m', 'base');
  const core = new Core(openDb(':memory:'), { home: path.join(tmp, 'home') });
  const project = core.createProject({ name: 'identity' }).id; core.addRoot(project, repo);
  const goal = core.createGoal(project, { title: 'identity', delegation: { write_files: 'allow', research: 'allow' } }).id;
  core.tick(); const participant = joinAs(core, repo, 'identity-worker', 'identity-client');
  await facilitate(core, participant, goal, [{ op: 'add_task', title: 'write', body: 'test', role: 'implement', mode: 'writes', tier: 'any' }]);
  const offer = await core.next({ participant, wait_seconds: 0 });
  const rules = core.claim({ participant, task: offer.task, gen: offer.gen }).assignment.program.workspace.rules;
  assert.ok(rules.some(rule => rule.includes('user.email=idleshift@localhost')));
});
