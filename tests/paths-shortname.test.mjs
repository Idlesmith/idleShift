// A missing sub-folder of an 8.3 short path (e.g. C:\Users\RUNNER~1\... on CI)
// must normalize to the same key as its long form, or root lookup misses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { normalizeRoot } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

function shortName(p) {
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true }).trim();
    return out && out.toLowerCase() !== p.toLowerCase() ? out : null;
  } catch { return null; }
}

test('normalizeRoot: a missing child of an 8.3 short path matches its long form', t => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const long = path.join(tmpDir('a-long-folder-name-for-short-path'), 'another-long-folder-name');
  fs.mkdirSync(long);
  const short = shortName(long);
  if (!short) return t.skip('8.3 short names are not available on this volume');
  assert.equal(normalizeRoot(short), normalizeRoot(long));
  assert.equal(normalizeRoot(path.join(short, 'missing', 'deeper')), normalizeRoot(path.join(long, 'missing', 'deeper')));
});

test('normalizeRoot: a path that does not exist at all is still normalized', () => {
  const p = path.join(tmpDir('norm-missing'), 'x', 'y');
  const n = normalizeRoot(p);
  assert.ok(n.endsWith(process.platform === 'win32' ? '\\x\\y' : '/x/y'));
});
