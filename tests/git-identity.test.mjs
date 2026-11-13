import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkMergeConflict, executeMerge, hasGitIdentity } from '../src/git.mjs';

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
  git('checkout', '-'); fs.writeFileSync(path.join(dir, 'main'), 'main'); git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'main');
  assert.equal(hasGitIdentity(dir), false);
  assert.equal(checkMergeConflict(dir, 'HEAD', 'feature').ok, true);
  assert.equal(executeMerge({ repoRoot: dir, branch: 'feature', taskId: 'T-1' }).ok, true);
  assert.equal(git('log', '-1', '--format=%an <%ae>'), 'IdleShift <idleshift@localhost>');
  assert.equal(hasGitIdentity(dir), false);
});
