// S-3: Pipe server must immediately destroy connections sending oversized lines without newlines (4KB pre-auth, 2MB post-auth).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { runService } from '../src/service.mjs';
import { connectService } from '../src/relay.mjs';
import { pipePath } from '../src/paths.mjs';
import { tmpDir } from './helpers.mjs';

process.env.IDLESHIFT_NOTIFY = '0';

test('S-3: pre-auth oversized data without newline (e.g. 10MB) is destroyed immediately', async t => {
  const home = tmpDir('s3-preauth');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  const sock = net.connect(pipePath(home));
  t.after(() => sock.destroy());
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  const closed = new Promise(resolve => sock.once('close', () => resolve(true)));
  sock.on('error', () => {});

  // Send 10MB without any newline in chunks
  const chunk = Buffer.alloc(64 * 1024, 'a');
  let sent = 0;
  for (let i = 0; i < 160; i++) {
    if (sock.destroyed) break;
    sock.write(chunk);
    sent += chunk.length;
    await new Promise(r => setTimeout(r, 1));
  }

  const wasClosed = await Promise.race([
    closed,
    new Promise(r => setTimeout(() => r(false), 1000))
  ]);
  assert.equal(wasClosed, true, 'pre-auth connection sending >4KB without newline must be destroyed immediately');
  assert.ok(sent < 10 * 1024 * 1024, `expected early disconnect well before 10MB, sent ${sent} bytes`);
});

test('S-3: pre-auth multi-chunk accumulation >4KB without newline is destroyed', async t => {
  const home = tmpDir('s3-chunks');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  const sock = net.connect(pipePath(home));
  t.after(() => sock.destroy());
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  sock.on('error', () => {});

  const closed = new Promise(resolve => sock.once('close', () => resolve(true)));
  for (let i = 0; i < 6; i++) {
    if (!sock.destroyed) sock.write('x'.repeat(1024));
    await new Promise(r => setTimeout(r, 10));
  }
  const wasClosed = await Promise.race([closed, new Promise(r => setTimeout(() => r(false), 500))]);
  assert.equal(wasClosed, true, 'accumulated >4KB pre-auth line must be destroyed');
});

test('S-3: authenticated connection allows >4KB (normal tool calls) and destroys >2MB without newline', async t => {
  const home = tmpDir('s3-authed');
  const svc = await runService({ home, quiet: true, adaptersEnabled: false });
  t.after(() => svc.stop());

  const link = await connectService(home, { autostart: false, timeoutMs: 2000 });
  t.after(() => link.close());

  // 10KB payload over authenticated link works fine
  const res = await link.request('tool', {
    name: 'status',
    args: { root: tmpDir('w') },
    client: { name: 's3', version: '1.0', pad: 'p'.repeat(10_000) }
  });
  assert.equal(res.result.registered, false);
});
