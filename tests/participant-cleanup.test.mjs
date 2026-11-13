import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCore, seed } from './helpers.mjs';

test('revocation is scoped to the name (label); other names on the same connection are separate conversations; client blocks are explicit', () => {
 const {core}=makeCore(); const {root,project}=seed(core);
 const join=(label,conn)=>core.join({root,label},{conn,client:{name:'app'}});
 const p=join('one','c1').participant; core.revokeParticipant(p);
 assert.notEqual(join('other','c1').participant, p, 'another name on a shared connection is another conversation');
 assert.throws(()=>join('one','c2'), e=>e.code==='revoked');
 assert.ok(join('other','c2').participant);
 core.setClientJoinBlocked(project,'app',true);
 assert.throws(()=>join('third','c3'), e=>e.code==='client_blocked');
 core.setClientJoinBlocked(project,'app',false);
 assert.ok(join('third','c3').participant);
});

test('removing an idle participant retains history and permits a fresh identity', () => {
 const {core,advance}=makeCore(); const {root,project}=seed(core);
 const join=(conn)=>core.join({root,label:'one'},{conn,client:{name:'app'}});
 const old=join('c1').participant; advance(200000);
 assert.equal(core.snapshot().projects[0].participants.find(p=>p.id===old).state,'needs_resume');
 core.removeParticipant(old);
 assert.ok(!core.snapshot().projects[0].participants.some(p=>p.id===old));
 assert.ok(core.one('SELECT id FROM participants WHERE id=?',old));
 assert.throws(()=>core.get({participant:old,ref:'board'}),e=>e.code==='unknown_participant');
 assert.notEqual(join('c2').participant,old);
});

test('a participant holding a task cannot be removed', async () => {
 const {core}=makeCore(); const {root}=seed(core);
 const p=core.join({root,label:'busy'},{conn:'busy',client:{name:'app'}}).participant;
 const offer=await core.next({participant:p}); core.claim({participant:p,task:offer.task,gen:offer.gen});
 assert.throws(()=>core.removeParticipant(p), e=>e.code==='participant_busy');
 assert.ok(core.snapshot().projects[0].participants.some(x=>x.id===p));
});

test('deleting a revoked participant frees its name for a fresh identity', () => {
 const {core}=makeCore(); const {root}=seed(core);
 const join=(conn)=>core.join({root,label:'one'},{conn,client:{name:'app'}});
 const old=join('c1').participant; core.revokeParticipant(old); core.removeParticipant(old);
 assert.notEqual(join('c1').participant,old);
 assert.notEqual(join('c2').participant,old);
});

test('several conversations behind one shared MCP connection get separate identities and do not supersede each other', async () => {
 const {core}=makeCore({ holdInitial: 5000 }); const {root}=seed(core);
 core.connOpened('shared');
 const flash=core.join({root,label:'agy-flash'},{conn:'shared',client:{name:'antigravity-client'}}).participant;
 const argon=core.join({root,label:'agy-argon'},{conn:'shared',client:{name:'antigravity-client'}}).participant;
 assert.notEqual(argon, flash);
 assert.equal(core.join({root,label:'agy-flash'},{conn:'shared',client:{name:'antigravity-client'}}).participant, flash, 'rejoining by name returns the same identity');
 const first = await core.next({participant:flash});
 assert.equal(first.kind,'offer');
 const w = core.next({participant:argon, wait_seconds:5});
 const w2 = core.next({participant:flash, wait_seconds:5});
 core.cancelWait(argon); core.cancelWait(flash);
 void w; void w2;
 core.revokeParticipant(argon);
 assert.equal(core.join({root,label:'agy-flash'},{conn:'shared',client:{name:'antigravity-client'}}).participant, flash, 'revoking one conversation does not lock out the other on the same connection');
 assert.throws(()=>core.join({root,label:'agy-argon'},{conn:'shared',client:{name:'antigravity-client'}}), e=>e.code==='revoked');
});
