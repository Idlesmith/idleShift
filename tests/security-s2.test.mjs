// S-2: Relay and service mutual HMAC authentication prevents pipe hijacking & token leakage.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { connectService } from '../src/relay.mjs';
import { runService } from '../src/service.mjs';
import { APP_ROOT, pipePath, serviceFile } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

test('S-2: fake pipe server mimicking IdleShift receives neither token nor tool calls, and relay returns error', async t => {
  const home = tmpDir('s2-fake');
  const secretToken = 'real-secret-token-should-never-be-sent-over-pipe';
  fs.writeFileSync(serviceFile(home), JSON.stringify({ pid: process.pid, port: 59999, token: secretToken }));

  const received = [];
  const sockets = new Set();
  const fakeServer = net.createServer(sock => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => {});
    readline.createInterface({ input: sock }).on('line', line => {
      received.push(line);
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m.method === 'hello') {
        // Mimic old IdleShift ok:true response (no valid HMAC proof)
        sock.write(JSON.stringify({ id: m.id, result: { ok: true, conn: 'fake-conn', version: '1.0' } }) + '\n');
      } else if (m.method === 'tool') {
        sock.write(JSON.stringify({ id: m.id, result: { result: { injected: 'EVIL_PAYLOAD' } } }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    fakeServer.once('error', reject);
    fakeServer.listen(pipePath(home), resolve);
  });
  t.after(() => { for (const s of sockets) s.destroy(); return new Promise(r => fakeServer.close(r)); });

  // 1. connectService must reject and must NEVER send secretToken or tool calls
  await assert.rejects(
    () => connectService(home, { autostart: false, timeoutMs: 600 }),
    err => {
      assert.match(err.message, /正規サーバーではありません|HMAC|認証/);
      assert.equal(err.message.includes(secretToken), false);
      return true;
    }
  );
  assert.ok(received.length >= 1, 'hello should have been sent');
  for (const raw of received) {
    assert.equal(raw.includes(secretToken), false, `token leaked to fake server: ${raw}`);
    const parsed = JSON.parse(raw);
    assert.notEqual(parsed.method, 'tool', 'tool call must never be sent to unverified server');
    assert.notEqual(parsed.method, 'hello_verify', 'hello_verify must never be sent before server proof verifies');
  }

  // 2. Real MCP relay process must return isError:true and never relay fake tool output
  const relay = spawn(process.execPath, [path.join(APP_ROOT, 'bin', 'idleshift.mjs'), 'mcp'], {
    env: { ...process.env, IDLESHIFT_HOME: home },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  t.after(() => relay.kill());

  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: relay.stdout }).on('line', line => {
    const m = JSON.parse(line);
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++seq;
    pending.set(id, resolve);
    relay.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's2-test', version: '1.0' } });
  const callRes = await rpc('tools/call', { name: 'status', arguments: { root: tmpDir('work') } });
  assert.equal(callRes.result.isError, true, 'MCP tool call to fake server must fail with isError:true');
  assert.equal(callRes.result.content[0].text.includes('EVIL_PAYLOAD'), false);
  assert.equal(callRes.result.content[0].text.includes(secretToken), false);
});

test('S-2: real service requires HMAC hello_verify and completes mutual auth cleanly', async t => {
  const home = tmpDir('s2-real');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  // Valid relay connects via mutual HMAC auth without sending raw token
  const link = await connectService(home, { autostart: false, timeoutMs: 2000 });
  t.after(() => link.close());
  const st = await link.request('tool', { name: 'status', args: { root: tmpDir('work') }, client: { name: 's2', version: '1.0' } });
  assert.equal(st.result.registered, false);

  // Direct client that only sends hello(nonce) without hello_verify cannot run tools
  const sock = net.connect(pipePath(home));
  t.after(() => sock.destroy());
  const answers = [];
  readline.createInterface({ input: sock }).on('line', l => answers.push(JSON.parse(l)));
  sock.write(JSON.stringify({ id: 1, method: 'hello', params: { nonce: '0123456789abcdef0123456789abcdef' } }) + '\n');
  sock.write(JSON.stringify({ id: 2, method: 'tool', params: { name: 'status', args: { root: tmpDir('work') } } }) + '\n');
  await new Promise(r => setTimeout(r, 150));
  assert.equal(answers[0].result.ok, true);
  assert.ok(answers[0].result.proof && answers[0].result.challenge);
  assert.equal(answers[1].error, 'not authenticated');
});
