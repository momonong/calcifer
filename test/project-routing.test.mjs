import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from '../src/workspace-tools.mjs';
import {createProject,authorizeProject,workProject,projectStatus,exportProject,reconcileProject} from '../src/project-session.mjs';
import {validateRouting} from '../src/project-routing.mjs';
import * as sessions from '../src/project-session.mjs';

const argon={backend:'agy',model:'gemini-4-argon-high',version:'1.5.3',effort:'high'};
const astra={backend:'codex',model:'gpt-6-astra',version:'0.166.0-alpha.6',effort:'high'};
const terra={backend:'codex',model:'gpt-6.1-terra',version:'0.166.0-alpha.6',effort:'medium'};
const routing={schemaVersion:1,planner:'argon',dataClass:'cloud-allowed',maxTasks:4,profiles:[
 {id:'argon',execution:argon,capabilities:['plan','reasoning','implementation'],enabled:true,available:true,maxCalls:1,resource:'included',expiresAt:null},
 {id:'astra',execution:astra,capabilities:['reasoning','implementation','routine'],enabled:true,available:true,maxCalls:4,resource:'existing-credits',expiresAt:null},
 {id:'terra',execution:terra,capabilities:['routine'],enabled:true,available:true,maxCalls:2,resource:'existing-credits',expiresAt:null},
],preferences:{reasoning:['astra','argon'],implementation:['astra','argon'],routine:['terra','astra']}};
const profile={schemaVersion:1,name:'Unrelated Python project',sourceFiles:['app/value.py','tests/test_value.py'],writeRules:[{root:'app',extensions:['.py']},{root:'tests',extensions:['.py']}],check:{kind:'python-unittest',testDir:'tests',timeoutMs:10000}};
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003'];
const task=(id='implement',kind='reasoning',preferredProfileId='astra',dependsOn=[])=>({id,kind,task:'Set app value to two and preserve regression.',preferredProfileId,reason:'Contracts require careful implementation; existing Codex credits are available.',dependsOn,acceptance:['Value equals two and regression passes.']});
const response=tasks=>JSON.stringify({schemaVersion:1,tasks});
async function setup(config=routing,maxTurns=2,maxMinutes=1){
 const base=await mkdtemp('/tmp/calcifer-route-test-'),repo=join(base,'source'),stateDir=join(base,'state');
 await mkdir(join(repo,'app'),{recursive:true});await mkdir(join(repo,'tests'));
 await writeFile(join(repo,'app/value.py'),'VALUE=1\n');
 await writeFile(join(repo,'tests/test_value.py'),'import unittest\nfrom app.value import VALUE\nclass T(unittest.TestCase):\n def test_positive(self):self.assertGreater(VALUE,0)\n');
 const text='Frozen project rules.',sources=[],context={text,sources,hash:digest({sources,text})};
 await createProject({stateDir,repo,profile,context,routing:config});
 await authorizeProject({stateDir,maxTurns,maxMinutes,note:'Offline routing acceptance only'});
 return {repo,stateDir};
}
const terminal=(req,response,id)=>({status:'SUCCESS',conversation_id:id,response,requestedModel:req.model,actualModel:req.model});

test('goal routes read-only Argon planning to Astra implementation with one shared budget and isolated source',async()=>{
 const f=await setup();let calls=0;
 const r=await workProject({...f,task:'Set app value to two'}, {worker:async req=>{
  calls++;
  if(calls===1){assert.equal(req.model,'gemini-4-argon-high');assert.equal(req.fileTools,false);assert.deepEqual(req.writeRoots,[]);return terminal(req,response([task()]),ids[0]);}
  assert.equal(req.model,'gpt-6-astra');assert.equal(req.effort,'high');assert.equal(req.conversationId,null);assert.match(req.prompt,/Set app value to two/);
  await writeFile(join(req.directory,'app/value.py'),'VALUE=2\n');return terminal(req,'Implemented',ids[1]);
 }});
 assert.equal(r.status,'completed');assert.equal(calls,2);
 const s=await projectStatus(f);assert.equal(s.turnsUsed,2);assert.equal(s.goal.status,'completed');assert.equal(s.goal.assignments[0].profileId,'astra');
 assert.equal(s.goal.results.length,1);assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE=1\n');
 assert.match(await readFile((await exportProject(f)).patchPath,'utf8'),/\+VALUE=2/);
});
test('routine task selects Terra rather than tying every Codex task to Astra or Sol',async()=>{
 const f=await setup();let calls=0;
 await workProject({...f,task:'Routine change'},{worker:async req=>{calls++;if(calls===1)return terminal(req,response([task('routine','routine','terra')]),ids[0]);assert.equal(req.model,'gpt-6.1-terra');return terminal(req,'Done',ids[1]);}});
 assert.equal((await projectStatus(f)).goal.assignments[0].profileId,'terra');
});
test('planner cannot expand data routing, dispatch unauthorized models, or bypass per-profile caps',async()=>{
 const f=await setup({...routing,profiles:routing.profiles.map(p=>p.id==='astra'?{...p,available:false}:p)});let calls=0;
 const r=await workProject({...f,task:'Complex change'},{worker:async req=>{calls++;return terminal(req,response([task()]),ids[0]);}});
 assert.equal(r.status,'failed');assert.equal(r.code,'NO_ELIGIBLE_PROFILE');assert.equal(calls,1);
 await assert.rejects(exportProject(f),/GOAL_INCOMPLETE/);
 const privateRun=await setup({...routing,dataClass:'local-only'});
 await assert.rejects(workProject({...privateRun,task:'Private change'},{worker:async()=>assert.fail('must not send local-only data')}),/NO_ELIGIBLE_PROFILE/);
});
test('malformed or over-budget plan stops after the planner without weakening completion',async()=>{
 for(const body of ['not json',response([task('one'),task('two','reasoning','astra',['one'])])]){
  const f=await setup();let calls=0;
  const r=await workProject({...f,task:'Change'},{worker:async req=>{calls++;return terminal(req,body,ids[0]);}});
  assert.equal(r.status,'failed');assert.match(r.code,/PLAN/);assert.equal(calls,1);await assert.rejects(exportProject(f),/GOAL_INCOMPLETE/);
 }
});
test('UNKNOWN planner survives reopen and cannot be sent to a different model',async()=>{
 const f=await setup();let calls=0;
 assert.equal((await workProject({...f,task:'Change'},{worker:async()=>{calls++;throw new Error('RESULT_UNKNOWN');}})).status,'unknown');
 assert.equal((await reconcileProject(f)).status,'unknown');
 await assert.rejects(workProject({...f,task:'Change'},{worker:async()=>{calls++;}}),/PENDING/);assert.equal(calls,1);
 await assert.rejects(authorizeProject({...f,maxTurns:2,maxMinutes:1,note:'new'}),/PENDING/);
});
test('recovered planner result is consumed once, without another planning call or wrong session resume',async()=>{
 const f=await setup();let evidence;
 await workProject({...f,task:'Change'},{worker:async req=>{evidence=req.evidenceDir;await writeFile(join(evidence,'terminal.json'),JSON.stringify(terminal(req,response([task()]),ids[0])));await writeFile(join(evidence,'process.json'),JSON.stringify({closed:true,exitCode:0}));await writeFile(join(evidence,'session.json'),JSON.stringify({conversationId:ids[0],init:{model:req.model}}));throw new Error('HOST_INTERRUPTED');}});
 await reconcileProject(f);let calls=0;
 const result=await workProject({...f,task:'Change'},{worker:async req=>{calls++;assert.equal(req.model,'gpt-6-astra');assert.equal(req.conversationId,null);return terminal(req,'Done',ids[1]);}});
 assert.equal(result.status,'completed');assert.equal(calls,1);assert.equal((await projectStatus(f)).turnsUsed,2);
});
test('routing config edits invalidate authorization before any dispatch',async()=>{
 const f=await setup(),path=join(f.stateDir,'project.json'),s=JSON.parse(await readFile(path,'utf8'));
 assert.ok(s.routing,'routing must persist');s.routing.profiles[1].execution.model='gpt-6.1-sol';s.routingHash=digest(s.routing);await writeFile(path,JSON.stringify(s));
 await assert.rejects(workProject({...f,task:'Change'},{worker:async()=>assert.fail('must not dispatch changed policy')}),/SCOPE_CHANGED/);
});
test('completed goal evidence is invalidated when its workspace has changed',async()=>{
 const f=await setup();let n=0;const worker=async req=>terminal(req,++n===1?response([task()]):'Done',ids[n-1]);
 await workProject({...f,task:'Change'},{worker});const s=await projectStatus(f);
 await writeFile(join(s.workspaceDir,'app/value.py'),'VALUE=999\n');
 await assert.rejects(workProject({...f,task:'Change'},{worker}),/GOAL_WORKSPACE_CHANGED/);assert.equal(n,2);
});
test('profile IDs cannot collide with inherited object properties and corrupt per-profile counts',()=>{
 const bad=structuredClone(routing);bad.profiles[1].id='constructor';bad.preferences.reasoning=['constructor'];bad.preferences.implementation=['constructor'];bad.preferences.routine=['constructor'];
 assert.throws(()=>validateRouting(bad),/ROUTING_PROFILE_INVALID/);
});
test('multiple assigned models see predecessor edits and integrate once in dependency order',async()=>{
 const f=await setup(routing,3);let n=0;
 const result=await workProject({...f,task:'Change value in two stages'},{worker:async req=>{
  n++;if(n===1)return terminal(req,response([task('reason'),task('format','routine','terra',['reason'])]),ids[0]);
  assert.equal(req.conversationId,null);
  assert.equal(await readFile(join(req.directory,'app/value.py'),'utf8'),n===2?'VALUE=1\n':'VALUE=2\n');
  await writeFile(join(req.directory,'app/value.py'),`VALUE=${n}\n`);return terminal(req,`Step ${n-1}`,ids[n-1]);
 }});
 assert.equal(result.status,'completed');assert.equal(n,3);const s=await projectStatus(f);
 assert.deepEqual(s.goal.results.map(r=>r.execution.model),['gpt-6-astra','gpt-6.1-terra']);
 assert.equal((await workProject({...f,task:'Change value in two stages'},{worker:()=>assert.fail('completed goal must not be dispatched again')})).code,'GOAL_EVIDENCE_REUSED');
 assert.match(await readFile((await exportProject(f)).patchPath,'utf8'),/\+VALUE=3/);
});
async function interruptedReceipt(req,body,id){
 await writeFile(join(req.evidenceDir,'terminal.json'),JSON.stringify(terminal(req,body,id)));
 await writeFile(join(req.evidenceDir,'process.json'),JSON.stringify({closed:true,exitCode:0}));
 await writeFile(join(req.evidenceDir,'session.json'),JSON.stringify({conversationId:id,backend:req.model.startsWith('gpt')?'codex':undefined,requestedModel:req.model,init:{model:req.model}}));
 throw new Error('HOST_INTERRUPTED');
}
test('review R1: recovered empty planner terminal is parsed as invalid and never replayed',async()=>{
 const config=structuredClone(routing);config.profiles[0].maxCalls=2;const f=await setup(config,4);
 await workProject({...f,task:'Empty plan'},{worker:req=>interruptedReceipt(req,'',ids[0])});await reconcileProject(f);let calls=0;
 const r=await workProject({...f,task:'Empty plan'},{worker:async req=>{calls++;return terminal(req,response([task()]),ids[1]);}});
 assert.equal(calls,0);assert.equal(r.status,'failed');assert.equal(r.code,'GOAL_PLAN_INVALID');assert.equal((await projectStatus(f)).turnsUsed,1);
});
test('review R2: recovered final worker cannot complete a goal after accepted workspace drifts',async()=>{
 const f=await setup();let n=0;
 await workProject({...f,task:'Change'},{worker:req=>++n===1?terminal(req,response([task()]),ids[0]):interruptedReceipt(req,'Done',ids[1])});
 await reconcileProject(f);const s=await projectStatus(f);await writeFile(join(s.workspaceDir,'app/value.py'),'VALUE = syntax error\n');
 await assert.rejects(workProject({...f,task:'Change'},{worker:()=>assert.fail('never replay accepted worker')}),/GOAL_WORKSPACE_CHANGED/);
 assert.notEqual((await projectStatus(f)).goal.status,'completed');
});
test('review R3: new explicit budget resumes known failed worker with its original session and concrete checks',async()=>{
 const f=await setup();let n=0;
 const first=await workProject({...f,task:'Change'},{worker:async req=>{if(++n===1)return terminal(req,response([task()]),ids[0]);await writeFile(join(req.directory,'app/value.py'),'VALUE = syntax error\n');return terminal(req,'Needs correction',ids[1]);}});
 assert.equal(first.status,'failed');assert.equal(first.code,'RESOURCE_LIMIT');
 await authorizeProject({...f,maxTurns:2,maxMinutes:1,note:'Explicit new correction phase'});let calls=0;
 const result=await workProject({...f,task:'Change'},{worker:async req=>{calls++;assert.equal(req.model,'gpt-6-astra');assert.equal(req.conversationId,ids[1]);assert.match(req.prompt,/SyntaxError/);await writeFile(join(req.directory,'app/value.py'),'VALUE=2\n');return terminal(req,'Corrected',ids[1]);}});
 assert.equal(result.status,'completed');assert.equal(calls,1);assert.equal((await projectStatus(f)).turnsUsed,1);
});
async function stopBetweenTasks(){
 const f=await setup(routing,3);let calls=0;
 const result=await workProject({...f,task:'Change value in two stages'},{worker:async req=>{
  calls++;
  if(calls===1)return terminal(req,response([task('reason'),task('format','routine','terra',['reason'])]),ids[0]);
  await writeFile(join(req.directory,'app/value.py'),calls===2?'VALUE = syntax error\n':'VALUE=2\n');
  return terminal(req,calls===2?'Needs correction':'First task corrected',ids[1]);
 }});
 assert.equal(result.status,'failed');assert.equal(result.code,'RESOURCE_LIMIT');assert.equal(calls,3);
 assert.deepEqual(result.goal.results.map(r=>r.planTaskId),['reason']);
 return f;
}
for(const entry of ['work','resume'])test(`new budget continues between-task resource stop via ${entry} without replaying accepted work`,async()=>{
 const f=await stopBetweenTasks();const before=await projectStatus(f);
 const never={worker:()=>assert.fail('exhausted budget must not dispatch')};
 assert.equal((await workProject({...f,task:'Change value in two stages'},never)).code,'RESOURCE_LIMIT');
 const exhausted=await sessions.resumeProjectGoal(f,never).catch(error=>({status:'failed',code:error.message}));
 assert.equal(exhausted.status,'failed');assert.equal(exhausted.code,'RESOURCE_LIMIT');
 await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Explicit remaining-task authorization'});let calls=0;
 const deps={worker:async req=>{
  calls++;assert.equal(req.model,'gpt-6.1-terra');assert.equal(req.conversationId,null);
  assert.equal(await readFile(join(req.directory,'app/value.py'),'utf8'),'VALUE=2\n');
  await writeFile(join(req.directory,'app/value.py'),'VALUE=3\n');return terminal(req,'Second task complete',ids[2]);
 }};
 const result=entry==='work'?await workProject({...f,task:'Change value in two stages'},deps):await sessions.resumeProjectGoal(f,deps);
 assert.equal(result.status,'completed');assert.equal(calls,1);
 assert.deepEqual(result.goal.results.map(r=>r.planTaskId),['reason','format']);
 assert.deepEqual(result.goal.results[0],before.goal.results[0]);
 assert.equal((await projectStatus(f)).turnsUsed,1);
 assert.match(await readFile((await exportProject(f)).patchPath,'utf8'),/\+VALUE=3/);
});
test('between-task budget renewal still rejects changed accepted workspace before dispatch',async()=>{
 const f=await stopBetweenTasks();const s=await projectStatus(f);
 await writeFile(join(s.workspaceDir,'app/value.py'),'VALUE=999\n');
 await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Explicit remaining-task authorization'});
 await assert.rejects(sessions.resumeProjectGoal(f,{worker:()=>assert.fail('changed workspace must not dispatch')}),/GOAL_WORKSPACE_CHANGED/);
 assert.equal((await projectStatus(f)).turnsUsed,0);
});
test('explicit goal abandonment preserves receipts and edits but never clears UNKNOWN',async()=>{
 assert.equal(typeof sessions.abandonProjectGoal,'function');
 const f=await setup();await workProject({...f,task:'Bad plan'},{worker:async req=>terminal(req,'invalid',ids[0])});
 const abandoned=await sessions.abandonProjectGoal({...f,note:'Human explicitly replaces invalid plan'});
 assert.equal(abandoned.goal,null);assert.equal(abandoned.turnsUsed,1);
 const pending=await setup();await workProject({...pending,task:'Unknown'},{worker:async()=>{throw new Error('RESULT_UNKNOWN');}});
 await assert.rejects(sessions.abandonProjectGoal({...pending,note:'cannot erase unknown'}),/PENDING/);
});
test('recovered successful correction replaces the failed checkpoint without replaying its model',async()=>{
 const f=await setup();let n=0;
 await workProject({...f,task:'Change'},{worker:async req=>{if(++n===1)return terminal(req,response([task()]),ids[0]);await writeFile(join(req.directory,'app/value.py'),'VALUE = bad syntax\n');return terminal(req,'Needs correction',ids[1]);}});
 await authorizeProject({...f,maxTurns:2,maxMinutes:1,note:'Explicit correction phase'});
 await workProject({...f,task:'Change'},{worker:async req=>{await writeFile(join(req.directory,'app/value.py'),'VALUE=2\n');return interruptedReceipt(req,'Corrected',ids[1]);}});
 await reconcileProject(f);
 const r=await workProject({...f,task:'Change'},{worker:()=>assert.fail('never resend successful correction')});
 assert.equal(r.status,'completed');assert.equal((await projectStatus(f)).turnsUsed,1);
});


test('goal without a deadline completes after elapsed days and keeps resource and file scope limits',async t=>{
 const f=await setup(routing,2,null);let calls=0;const now=Date.now;
 const {gateTool}=await import('../src/project-tool-gate.mjs');
 await assert.rejects(authorizeProject({...f,maxTurns:3,note:'Cannot silently reset active allowance'}),/AUTHORIZATION_ALREADY_ACTIVE/);
 const result=await workProject({...f,task:'Set app value to two without a deadline'},{worker:async req=>{
  calls++;assert.equal(req.timeoutMs,null);
  if(calls===1){t.mock.method(Date,'now',()=>now()+2*86400000);return terminal(req,response([task()]),ids[0]);}
  const config=JSON.parse(await readFile(join(f.stateDir,'gate.json'),'utf8'));
  const input=path=>({workspacePaths:[req.directory],toolCall:{name:'write_to_file',args:{TargetFile:join(req.directory,path)}}});
  assert.equal((await gateTool(input('app/value.py'),config)).decision,'allow');
  assert.equal((await gateTool(input('AGENTS.md'),config)).decision,'deny');
  await writeFile(join(req.directory,'app/value.py'),'VALUE=2\n');return terminal(req,'Implemented',ids[1]);
 }});
 assert.equal(result.status,'completed');assert.equal(calls,2);
 const s=await projectStatus(f);assert.equal(s.deadlineAt,null);assert.equal(s.maxMinutes,null);assert.equal(s.maxTurns,2);assert.equal(s.turnsUsed,2);
 assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE=1\n');
 await assert.rejects(workProject({...f,task:'Another goal'},{worker:()=>assert.fail('no new calls authorized')}),/RESOURCE_LIMIT/);
});
test('opt-in finite deadline exceeds the old per-call cap but stops later dispatch after expiry',async t=>{
 const f=await setup(routing,2,60);let calls=0;const now=Date.now;
 const result=await workProject({...f,task:'Bounded research'},{worker:async req=>{
  calls++;assert.ok(req.timeoutMs>1200000&&req.timeoutMs<=3600000);
  t.mock.method(Date,'now',()=>now()+2*3600000);return terminal(req,response([task()]),ids[0]);
 }});
 assert.equal(result.status,'failed');assert.equal(result.code,'RESOURCE_LIMIT');
 assert.equal(calls,1);const s=await projectStatus(f);assert.equal(s.maxMinutes,60);assert.ok(s.deadlineAt);assert.equal(s.turnsUsed,1);
});
