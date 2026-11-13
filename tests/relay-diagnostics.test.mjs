import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { connectService, cleanupStaleServiceFile, isPidAlive, formatAuthFailure } from '../src/relay.mjs';
import { runService, readService } from '../src/service.mjs';
import { APP_ROOT, pipePath, serviceFile } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

test('A-3 (1): auth failure includes service.json path, pid, and liveness without leaking token', async t => {
  const home = tmpDir('a3-auth');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  const secretToken = 'super-secret-wrong-token-1234567890';
  fs.writeFileSync(serviceFile(home), JSON.stringify({ pid: process.pid, port: svc.port, token: secretToken }));

  await assert.rejects(
    () => connectService(home, { autostart: false, timeoutMs: 1000 }),
    err => {
      assert.match(err.message, /認証に失敗しました/);
      assert.ok(err.message.includes(serviceFile(home)), `expected service.json path in: ${err.message}`);
      assert.ok(err.message.includes(`pid=${process.pid}`), `expected pid in: ${err.message}`);
      assert.match(err.message, /生存中/);
      assert.equal(err.message.includes(secretToken), false, 'token must never be in error message');
      assert.equal(err.message.includes(svc.token), false, 'service token must never be in error message');
      return true;
    }
  );

  // Dead pid in service.json while pipe is actually held by svc
  fs.writeFileSync(serviceFile(home), JSON.stringify({ pid: 999999, port: svc.port, token: secretToken }));
  await assert.rejects(
    () => connectService(home, { autostart: false, timeoutMs: 1000 }),
    err => {
      assert.match(err.message, /認証に失敗しました/);
      assert.ok(err.message.includes(serviceFile(home)));
      assert.ok(err.message.includes('pid=999999'));
      assert.match(err.message, /停止済み/);
      assert.match(err.message, /別のプロセス/);
      assert.equal(err.message.includes(secretToken), false);
      return true;
    }
  );
});

test('A-3 (2): stale service.json with dead pid is cleaned up', async () => {
  const home = tmpDir('a3-stale');
  const file = serviceFile(home);

  // Alive pid is NOT cleaned up
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port: 12345, token: 'abc' }));
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(cleanupStaleServiceFile(home), false);
  assert.equal(fs.existsSync(file), true);

  // Dead pid IS cleaned up by cleanupStaleServiceFile
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, port: 12345, token: 'abc' }));
  assert.equal(isPidAlive(999999), false);
  assert.equal(cleanupStaleServiceFile(home), true);
  assert.equal(fs.existsSync(file), false);

  // Corrupt service.json IS cleaned up
  fs.writeFileSync(file, '{not-json');
  assert.equal(cleanupStaleServiceFile(home), true);
  assert.equal(fs.existsSync(file), false);

  // connectService cleans up stale service.json when pipe connection fails
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, port: 12345, token: 'stale-token' }));
  await assert.rejects(() => connectService(home, { autostart: false, timeoutMs: 500 }));
  assert.equal(fs.existsSync(file), false);
});

test('A-3 (3): detects another process occupying the same pipe name', async t => {
  const home = tmpDir('a3-pipe');
  const pipe = pipePath(home);

  // Non-IdleShift server listening on the same pipe name
  const dummySockets = new Set();
  const dummy = net.createServer(sock => {
    dummySockets.add(sock);
    sock.on('close', () => dummySockets.delete(sock));
    sock.on('error', () => {});
    // Stays silent or closes without valid IdleShift hello response
  });
  await new Promise((resolve, reject) => {
    dummy.once('error', reject);
    dummy.listen(pipe, resolve);
  });
  t.after(() => { for (const s of dummySockets) s.destroy(); return new Promise(r => dummy.close(r)); });

  await assert.rejects(
    () => connectService(home, { autostart: false, timeoutMs: 400 }),
    err => {
      assert.match(err.message, /同じパイプ名/);
      assert.match(err.message, /別のプロセス/);
      return true;
    }
  );

  // runService also distinguishes another process on the pipe (PIPE_IN_USE) from live IdleShift (ALREADY_RUNNING)
  await assert.rejects(
    () => runService({ home, quiet: true, adaptersEnabled: false }),
    err => {
      assert.equal(err.code, 'PIPE_IN_USE');
      assert.match(err.message, /同じパイプ名/);
      assert.match(err.message, /別のプロセス/);
      return true;
    }
  );
});

test('A-3 (4): leftover legacy conclavity relay/pipe process causes no harm to idleshift', async t => {
  const home = tmpDir('a3-legacy');
  const tag = crypto.createHash('sha256').update(home.toLowerCase()).digest('hex').slice(0, 16);
  const legacyPipe = process.platform === 'win32' ? `\\\\.\\pipe\\conclavity-${tag}` : path.join(home, 'conclavity.sock');

  // 1. Legacy conclavity pipe server + dummy child relay process running
  const legacyServer = net.createServer(s => s.on('error', () => {}));
  await new Promise(resolve => legacyServer.listen(legacyPipe, resolve));
  t.after(() => new Promise(r => legacyServer.close(r)));

  const legacyChild = spawn(process.execPath, ['-e', 'process.stdin.resume(); setInterval(() => {}, 10000);'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => legacyChild.kill());

  // 2. Real idleshift service starts normally without conflict
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());
  assert.ok(readService(home)?.pid === process.pid);

  // 3. Unauthenticated / legacy client probing idleshift pipe is refused without harming service
  const probe = net.connect(pipePath(home));
  probe.write(JSON.stringify({ id: 1, method: 'hello', params: { token: 'legacy-token' } }) + '\n');
  await new Promise(r => setTimeout(r, 100));
  probe.destroy();

  // 4. Real idleshift relay connects and executes MCP tools normally
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

  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-app', version: '1.0' } });
  assert.equal(init.result.serverInfo.name, 'idleshift');

  const st = await rpc('tools/call', { name: 'status', arguments: { root: tmpDir('work') } });
  assert.equal(st.result.isError, false);
  assert.equal(JSON.parse(st.result.content[0].text).registered, false);
});

test('A-3 (5): auth failure and pipe conflict include actionable remedies', async t => {
  const home = tmpDir('a3-remedy');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  fs.writeFileSync(serviceFile(home), JSON.stringify({ pid: process.pid, port: svc.port, token: 'wrong-token' }));
  await assert.rejects(
    () => connectService(home, { autostart: false, timeoutMs: 800 }),
    err => {
      assert.match(err.message, /IdleShiftを再起動してください（IdleShift\.bat restart、または node bin\/idleshift\.mjs stop の後に起動）/);
      return true;
    }
  );

  // Pipe occupied by another process
  const home2 = tmpDir('a3-remedy-pipe');
  const pipe2 = pipePath(home2);
  const dummySockets = new Set();
  const dummy = net.createServer(s => {
    dummySockets.add(s);
    s.on('close', () => dummySockets.delete(s));
    s.on('error', () => {});
  });
  await new Promise((resolve, reject) => { dummy.once('error', reject); dummy.listen(pipe2, resolve); });
  t.after(() => { for (const s of dummySockets) s.destroy(); return new Promise(r => dummy.close(r)); });

  await assert.rejects(
    () => connectService(home2, { autostart: false, timeoutMs: 400 }),
    err => {
      assert.match(err.message, /そのプロセスを終了するか、PCを再起動してください/);
      assert.match(err.message, /Get-Process|tasklist/);
      return true;
    }
  );
  await assert.rejects(
    () => runService({ home: home2, quiet: true, adaptersEnabled: false }),
    err => {
      assert.equal(err.code, 'PIPE_IN_USE');
      assert.match(err.message, /そのプロセスを終了するか、PCを再起動してください/);
      assert.match(err.message, /Get-Process|tasklist/);
      return true;
    }
  );
});

test('A-3 (6): auth failure warns about split data-home for Packages\\Claude_ and other L1/L2 service.json', async t => {
  // Case A: service.json path is inside MSIX Packages\Claude_* redirection
  const base = tmpDir('a3-msix');
  const msixHome = path.join(base, 'Packages', 'Claude_test123', 'LocalCache', 'Local', 'IdleShift');
  fs.mkdirSync(msixHome, { recursive: true });
  const svc = await runService({ home: msixHome, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  fs.writeFileSync(serviceFile(msixHome), JSON.stringify({ pid: process.pid, port: svc.port, token: 'wrong-token' }));
  await assert.rejects(
    () => connectService(msixHome, { autostart: false, timeoutMs: 800 }),
    err => {
      assert.match(err.message, /このアプリと他のアプリでデータ置き場が分かれている可能性があります（docs\/data-home\.md）/);
      return true;
    }
  );

  // Case B: another service.json exists in L1 (%LOCALAPPDATA%\IdleShift) or L2 (%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local\IdleShift)
  const fakeLocalApp = tmpDir('a3-localapp');
  const l1Dir = path.join(fakeLocalApp, 'IdleShift');
  fs.mkdirSync(l1Dir, { recursive: true });
  fs.writeFileSync(path.join(l1Dir, 'service.json'), JSON.stringify({ pid: 1234, token: 'other' }));

  const msgL1 = formatAuthFailure({ file: serviceFile(tmpDir('other-home')), exists: true, pid: process.pid, alive: true }, '\\\\.\\pipe\\test', '認証に失敗しました', { localAppData: fakeLocalApp });
  assert.match(msgL1, /このアプリと他のアプリでデータ置き場が分かれている可能性があります（docs\/data-home\.md）/);

  // Case C: L2 only
  fs.rmSync(l1Dir, { recursive: true, force: true });
  const l2Dir = path.join(fakeLocalApp, 'Packages', 'Claude_abc', 'LocalCache', 'Local', 'IdleShift');
  fs.mkdirSync(l2Dir, { recursive: true });
  fs.writeFileSync(path.join(l2Dir, 'service.json'), JSON.stringify({ pid: 5678, token: 'other2' }));

  const msgL2 = formatAuthFailure({ file: serviceFile(tmpDir('other-home2')), exists: true, pid: process.pid, alive: true }, '\\\\.\\pipe\\test', '認証に失敗しました', { localAppData: fakeLocalApp });
  assert.match(msgL2, /このアプリと他のアプリでデータ置き場が分かれている可能性があります（docs\/data-home\.md）/);
});
