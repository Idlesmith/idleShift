import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools.mjs';
import { makeCore, seed, joinAs, take, done } from './helpers.mjs';

test('MCP plan schema publishes tier, board and header expose trusted usage and task tier', async () => {
 const {core}=makeCore(); const {root,project,goal}=seed(core); const p=joinAs(core,root,'mcp-worker','c1');
 assert.match(TOOLS.find(t=>t.name==='plan').inputSchema.properties.ops.description,/tier/);
 const f=await take(core,p); done(core,p,f.task,f.gen);
 core.setProfile(project,'mcp-worker',{tier:'worker',limit_5h_claims:1});
 const h=core.header(core.one('SELECT * FROM participants WHERE id=?',p),'next'); assert.equal(h.your_tier,'worker');
 const board=core.boardView(project); const user=board.participants.find(x=>x.participant===p);
 assert.equal(user.tier,'worker'); assert.equal(user.offers_paused,true); assert.ok(user.until); assert.equal(user.used_5h,1);
 assert.equal(user.usage.used.claims_7d,1); assert.equal(user.usage.limits.limit_5h_claims,1); assert.equal(user.usage.remaining.claims_5h,0);
 const task=core.insertTask(core.goal(goal),{title:'test',role:'research',mode:'read_only',tier:'senior'});
 assert.equal(core.boardView(project).goals[0].tasks.find(t=>t.task===task).tier,'senior');
 assert.equal(core.get({participant:p,ref:`task:${task}`}).data.tier,'senior');
});

test('assignment reports tier and mandatory review as program facts and defaults remain compatible', async () => {
 const {core}=makeCore(); const {root,goal}=seed(core); const p=joinAs(core,root,'mcp','c1');
 const f=await take(core,p); assert.equal(f.got.assignment.program.tier,'any'); assert.equal(f.got.header.your_tier,undefined);
 const t=core.task(f.task); core.run("UPDATE tasks SET tier=?, senior_review=1, kind='work' WHERE id=?",'senior',t.id);
 const a=core.assignment(core.task(t.id),core.goal(goal),core.one('SELECT * FROM participants WHERE id=?',p));
 assert.equal(a.assignment.program.tier,'senior'); assert.equal(a.assignment.program.downgraded,true); assert.match(a.assignment.program.downgrade_note,/review|レビュー/i);
});

