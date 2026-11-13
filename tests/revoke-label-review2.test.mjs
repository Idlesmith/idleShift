import test from 'node:test';
import assert from 'node:assert/strict';
import { Refusal } from '../src/core.mjs';
import { makeCore, seed, joinAs } from './helpers.mjs';

const refused = (fn, code) => assert.throws(fn, e => e instanceof Refusal && e.code === code, `expected refusal ${code}`);

test('review #2: the revoked name stays blocked on any connection; other names are separate conversations', async () => {
  const { core } = makeCore();
  const { root } = seed(core);

  // 1. Participant joins on connection c1 with label 'worker-alpha'
  const p1 = joinAs(core, root, 'worker-alpha', 'c1');
  assert.ok(p1);

  // 2. Human revokes participant p1
  core.revokeParticipant(p1);

  // 3. get() with revoked participant id is refused
  refused(() => core.get({ participant: p1, ref: 'board' }), 'revoked');

  // 4. Joining again on the same connection with the same label is refused
  refused(() => core.join({ root, label: 'worker-alpha' }, { conn: 'c1', client: { name: 'worker-alpha' } }), 'revoked');

  // 5. Rule changed 2026-11-10 (human report): one MCP connection can carry several conversations
  //    (Antigravity shares one server process across windows), so a different name on the same
  //    connection is a separate conversation and is NOT blocked. The revoked name stays blocked (step 4).
  //    A conversation that renames itself to evade revocation cannot be told apart; documented in README.
  assert.notEqual(core.join({ root, label: 'worker-beta' }, { conn: 'c1', client: { name: 'worker-alpha' } }).participant, p1);

  // 6. Human re-allows the participant
  core.revokeParticipant(p1, false);

  // 7. Legitimate participant can now rejoin / resume on the connection
  const rejoined = core.join({ root, label: 'worker-alpha' }, { conn: 'c1', client: { name: 'worker-alpha' } });
  assert.equal(rejoined.registered, true);
  assert.equal(rejoined.participant, p1);
});

test('review #2: a new connection with a new label is a separate conversation', async () => {
  const { core } = makeCore();
  const { root } = seed(core);

  // 1. Participant joins on connection-1 with client 'app', label 'app'
  const p1 = core.join({ root, label: 'app' }, { conn: 'connection-1', client: { name: 'app', version: '1.0' } }).participant;
  core.connOpened('connection-1');

  // Another live participant p2 with same client 'app' but label 'app-helper'
  const p2 = core.join({ root, label: 'app-helper' }, { conn: 'connection-helper', client: { name: 'app', version: '1.0' } }).participant;
  core.connOpened('connection-helper');

  // 2. Human revokes p1
  core.revokeParticipant(p1);

  // 3. connection-1 closes, connection-2 opens
  core.connClosed('connection-1');
  core.connOpened('connection-2');

  // A new connection and label cannot be distinguished from a new conversation.
  const other = core.join({ root, label: 'renamed' }, { conn: 'connection-2', client: { name: 'app', version: '1.0' } });
  assert.notEqual(other.participant, p1);

  // 5. Meanwhile, the unrevoked participant p2 can reconnect on a new connection and resume
  core.connClosed('connection-helper');
  core.connOpened('connection-helper-2');
  const p2Resume = core.join({ root, label: 'app-helper' }, { conn: 'connection-helper-2', client: { name: 'app', version: '1.0' } });
  assert.equal(p2Resume.participant, p2);
  assert.equal(p2Resume.resumed, true);

  // 6. Human re-allows p1
  core.revokeParticipant(p1, false);

  // 7. Legitimate rejoin of p1 on connection-2 now succeeds
  const p1Resume = core.join({ root, label: 'app' }, { conn: 'connection-3', client: { name: 'app', version: '1.0' } });
  assert.equal(p1Resume.participant, p1);
  assert.equal(p1Resume.resumed, true);
});
