import test from 'node:test';
import assert from 'node:assert/strict';
import {runService} from '../src/service.mjs';
import {tmpDir} from './helpers.mjs';
process.env.IDLESHIFT_NOTIFY='0';

test('authenticated GUI API archives and restores, and deletion preserves history', async t => {
 const svc=await runService({home:tmpDir('archive-api'),quiet:true,adaptersEnabled:false}); t.after(()=>svc.stop());
 const api=async (method,params={},token=svc.token)=>{ const r=await fetch(`http://127.0.0.1:${svc.port}/api/call`,{method:'POST',headers:{'content-type':'application/json','x-idleshift-token':token},body:JSON.stringify({method,params})}); return {status:r.status,...await r.json()}; };
 const project=(await api('createProject',{name:'history'})).result.id;
 const goal=(await api('createGoal',{project,goal:{title:'keep'}})).result.id;
 assert.equal((await api('deleteProject',{project,confirm:'history'},'bad')).status,401);
 assert.equal((await api('setProjectArchived',{project,archived:true},'bad')).status,401);
 const rejected=await api('deleteProject',{project,confirm:'history'});
 assert.equal(rejected.ok,false); assert.equal(rejected.code,'project_not_empty');
 assert.equal(svc.ctx.core.goal(goal).id,goal);
 assert.equal((await api('setProjectArchived',{project,archived:'true'})).ok,false);
 assert.equal((await api('setProjectArchived',{project,archived:true})).ok,true);
 assert.equal((await api('state')).result.projects.find(x=>x.id===project).archived,true);
 assert.equal((await api('setProjectArchived',{project,archived:false})).ok,true);
 assert.equal((await api('state')).result.projects.find(x=>x.id===project).archived,false);
 const empty=(await api('createProject',{name:'empty'})).result.id;
 assert.equal((await api('deleteProject',{project:empty,confirm:'wrong'})).ok,false);
 assert.equal((await api('deleteProject',{project:empty,confirm:'empty'})).ok,true);
 assert.ok(!(await api('state')).result.projects.some(x=>x.id===empty));
});
