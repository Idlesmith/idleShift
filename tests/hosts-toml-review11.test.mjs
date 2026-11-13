import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hostChange, splitToml } from '../src/hosts.mjs';
import { tmpDir } from './helpers.mjs';

function config(text) {
  const fake = tmpDir('toml-review11');
  const env = { USERPROFILE: fake, CODEX_HOME: path.join(fake, '.codex'), IDLESHIFT_HOME: path.join(fake, 'data') };
  const file = path.join(env.CODEX_HOME, 'config.toml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { file, options: { env, home: env.IDLESHIFT_HOME } };
}

for (const header of [
  '[mcp_servers.idleshift] # existing server',
  '[mcp_servers."idleshift"]',
  "['mcp_servers' . 'idleshift'] # quoted keys",
  '[ "mcp_servers" . "idlesh\\u0069ft" ]',
]) {
  test(`#11: update/remove recognizes TOML header ${header}`, () => {
    const before = 'model = "example"\n\n';
    const after = '[mcp_servers.other]\ncommand = "keep"\n';
    const { file, options } = config(before + header + '\ncommand = "old-command"\n[mcp_servers.idleshift.env] # environment\nOLD = "old-env"\n' + after);
    hostChange('codex', true, options);
    const updated = fs.readFileSync(file, 'utf8');
    assert.equal(updated.includes('old-command'), false);
    assert.equal(updated.includes('old-env'), false);
    assert.ok(updated.startsWith(before));
    assert.ok(updated.includes(after));
    assert.equal((updated.match(/\[mcp_servers\.idleshift\]/g) || []).length, 1);
    hostChange('codex', true, options);
    assert.equal(fs.readFileSync(file, 'utf8'), updated, 'repeat registration is idempotent');
    hostChange('codex', false, options);
    const removed = fs.readFileSync(file, 'utf8');
    assert.equal(splitToml(removed).block, '');
    assert.equal(removed.trim(), (before + after).trim());
  });
}

for (const source of [
  'description = """\n[mcp_servers.idleshift]\nthis is string content\n"""\n',
  "description = '''\n[mcp_servers.idleshift]\nthis is string content\n'''\n",
  'mcp_servers.idleshift.command = "old"\n',
  'mcp_servers = { idleshift = { command = "old" } }\n',
  '[mcp_servers]\n"idleshift" = { command = "old" }\n',
  '[[mcp_servers.idleshift]]\ncommand = "old"\n',
  'args = [\n"first",\n"second",\n]\n',
  '[mcp_servers."idleshift]\ncommand = "old"\n',
]) {
  test(`#11: unsupported TOML is refused without changing bytes: ${source.split('\n')[0]}`, () => {
    const { file, options } = config(source);
    for (const register of [true, false]) {
      assert.throws(() => hostChange('codex', register, options), /TOML/);
      assert.equal(fs.readFileSync(file, 'utf8'), source);
      assert.equal(fs.existsSync(path.join(options.home, 'host-backups')), false);
    }
  });
}

test('#11: header-looking text and delimiters inside single-line strings/comments remain untouched', () => {
  const source = '# """ comment\nvalue = "[mcp_servers.idleshift] # not a header"\narray = ["[", "]", "#"] # trailing comment\n["mcp_servers"."idleshift-other"] # unrelated\ncommand = "keep"\n';
  const { file, options } = config(source);
  hostChange('codex', true, options);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith(source));
  hostChange('codex', false, options);
  assert.equal(fs.readFileSync(file, 'utf8').trim(), source.trim());
});
