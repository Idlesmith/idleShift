import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Refusal } from '../src/core.mjs';
import { runService } from '../src/service.mjs';
import { makeCore, seed, joinAs, tmpDir } from './helpers.mjs';

function request(port, { method = 'GET', pathName = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('#1: participant ID cannot be used from another live connection', async () => {
  const { core } = makeCore();
  const { root } = seed(core);
  const p1 = joinAs(core, root, 'agent1', 'c1');
  core.connOpened('c2');

  assert.throws(
    () => core.get({ participant: p1, ref: 'board' }, { conn: 'c2' }),
    e => e instanceof Refusal && e.code === 'not_yours'
  );
  await assert.rejects(
    () => core.next({ participant: p1 }, { conn: 'c2' }),
    e => e instanceof Refusal && e.code === 'not_yours'
  );
});

test('#3: malformed HTTP request URL returns 400 without crashing the service', async t => {
  const home = tmpDir('review3-home');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  const res = await request(svc.port, {
    method: 'GET',
    pathName: '//[',
    headers: { host: `127.0.0.1:${svc.port}` }
  });
  assert.equal(res.status, 400);

  // Service is still alive and responds to normal requests
  const health = await request(svc.port, {
    method: 'GET',
    pathName: '/',
    headers: { host: `127.0.0.1:${svc.port}` }
  });
  assert.equal(health.status, 200);
});

test('#12: setAdapters preserves valid model names such as gpt-5-mini', () => {
  const { core } = makeCore();
  const { project } = seed(core);

  core.setAdapters(project, {
    codex: { enabled: true, access: 'read', model: 'gpt-5-mini' },
    claude: { enabled: true, access: 'write', model: 'claude-3-7-sonnet' }
  });

  const saved = JSON.parse(core.project(project).adapters);
  assert.equal(saved.codex.model, 'gpt-5-mini');
  assert.equal(saved.claude.model, 'claude-3-7-sonnet');
});
