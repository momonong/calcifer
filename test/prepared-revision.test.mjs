import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import * as sessions from '../src/project-session.mjs';
import * as prepared from '../src/prepared-project.mjs';
import {digest} from '../src/workspace-tools.mjs';
import {parseArgs} from '../src/calcifer-cli.mjs';

const CONVERSATIONS={plan:'00000000-0000-4000-8000-000000000001',implement:'00000000-0000-4000-8000-000000000002',document:'00000000-0000-4000-8000-000000000003'};
async function setup(t,{workerCalls=2,maxTurns=5}={}){
 const base=await mkdtemp('/tmp/calcifer-selected-revision-');t.after(()=>rm(base,{recursive:true,force:true}));
 const repo=join(base,'source'),stateDir=join(base,'state');await mkdir(join(repo,'checks'),{recursive:true});await mkdir(join(repo,'app'));
 await writeFile(join(repo,'app/value.py'),'VALUE = 1\n');
 await writeFile(join(repo,'checks/test_value.py'),"import unittest\nfrom app.value import VALUE\nclass Acceptance(unittest.TestCase):\n def test_value(self): self.assertEqual(VALUE,2)\n");
 const profile={schemaVersion:1,name:'Selected revision fixture',sourceFiles:['app/value.py','checks/test_value.py'],writeRules:[{root:'app',extensions:['.py']},{root:'docs',extensions:['.md']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
 const execution={backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'};
 const routing={schemaVersion:1,planner:'plan',dataClass:'cloud-allowed',maxTasks:2,profiles:[
  {id:'plan',execution:{backend:'agy',model:'gemini-4-argon-high',version:'1.5.3',effort:'high'},capabilities:['plan'],enabled:true,available:true,maxCalls:1,resource:'included',expiresAt:null},
  {id:'worker',execution,capabilities:['implementation'],enabled:true,available:true,maxCalls:workerCalls,resource:'existing-credits',expiresAt:null},
  {id:'docs',execution:{...execution,model:'gpt-6.1-terra',effort:'medium'},capabilities:['routine'],enabled:true,available:true,maxCalls:2,resource:'existing-credits',expiresAt:null}
 ],preferences:{implementation:['worker'],routine:['docs'],reasoning:['worker']}};
 const ctx={sources:[],text:'Synthetic fixture only; injected workers, no external models.'};
 await sessions.createProject({stateDir,repo,profile,routing,context:{...ctx,hash:digest(ctx)}});
 const task='Set VALUE to 2 and document its location.';
 await prepared.prepareProjectTask({stateDir,title:'Selected revision',task,maxTurns,note:'Offline tests only',documents:null});
 await sessions.authorizeProject({stateDir,maxTurns,note:'Offline tests only'});
 const calls=[];
 const worker=async req=>{
  const part=req.fileTools===false?'plan':req.model==='gpt-6.1-terra'?'document':'implement';
  const previous=calls.filter(c=>c.part===part);calls.push({part,conversationId:req.conversationId,model:req.model,effort:req.effort});
  assert.equal(req.conversationId,previous.length?CONVERSATIONS[part]:null);
  if(part==='plan')return {status:'SUCCESS',conversation_id:CONVERSATIONS.plan,requestedModel:req.model,response:JSON.stringify({schemaVersion:1,tasks:[
   {id:'implement',kind:'implementation',task:'Set VALUE to 2.',preferredProfileId:'worker',reason:'Implementation',dependsOn:[],acceptance:['VALUE equals 2']},
   {id:'document',kind:'routine',task:'Document VALUE.',preferredProfileId:'docs',reason:'Routine documentation',dependsOn:['implement'],acceptance:['Usage document exists']}
  ]})};
  const packet=JSON.parse(req.prompt.match(/BEGIN_CALCIFER_INPUTS\n([^\n]+)\nEND_CALCIFER_INPUTS/)[1]);
  if(part==='implement'){
   await writeFile(join(req.directory,'app/value.py'),'VALUE = 2\n');
   if(previous.length){assert.match(req.prompt,/Windows acceptance correction/);assert.equal(await readFile(join(req.directory,'docs/usage.md'),'utf8'),'VALUE is 2.\n');await writeFile(join(req.directory,'docs/correction.md'),'Windows acceptance corrected.\n');}
  }else await writeFile(join(req.directory,'docs/usage.md'),'VALUE is 2.\n');
  return {status:'SUCCESS',conversation_id:CONVERSATIONS[part],requestedModel:req.model,requestedEffort:req.effort,response:'CALCIFER_COMPLETION_JSON: '+JSON.stringify({status:'complete',inputContextHash:packet.hash,sourcesReviewed:packet.requiredSources,reason:'Scoped change done; host checks required.'})};
 };
 const result=await sessions.workProject({stateDir,task},{worker});assert.equal(result.status,'completed');
 return {stateDir,repo,worker,calls};
}

test('selected earlier revision restores original Astra conversation and preserves later Terra work',async t=>{
 const f=await setup(t),before=await sessions.projectStatus(f),original=before.goal.results[0],later=before.goal.results[1];
 const receiptPath=join(f.stateDir,'tasks',original.taskId,'result.json'),oldReceipt=await readFile(receiptPath),preparedBytes=await readFile(join(f.stateDir,'prepared-task.json'));
 const revised=await sessions.revisePreparedProject({...f,taskId:'implement',note:'Windows acceptance correction'});
 assert.equal(revised.turnsUsed,3);assert.equal(revised.goal.id,before.goal.id);assert.equal(revised.conversationId,CONVERSATIONS.implement);assert.equal(revised.model,'gpt-6-astra');
 assert.equal(revised.goal.resume.manifestHash,before.goal.finalManifestHash);assert.deepEqual(revised.goal.results,[later]);assert.equal(f.calls.length,3);
 const revisionFile=(await readdir(f.stateDir)).find(p=>p.startsWith('revision-'));
 const archive=JSON.parse(await readFile(join(f.stateDir,revisionFile),'utf8'));
 assert.equal(archive.lastTask.id,later.taskId);assert.equal(archive.selectedTask.id,original.taskId);assert.equal(archive.conversationId,CONVERSATIONS.implement);
 assert.equal((await sessions.resumeProjectGoal(f,{worker:f.worker})).status,'completed');
 const after=await sessions.projectStatus(f);assert.equal(after.turnsUsed,4);assert.equal(after.goal.id,before.goal.id);assert.equal(after.goal.results.length,2);
 assert.deepEqual(f.calls.map(c=>c.part),['plan','implement','document','implement']);assert.equal(f.calls.at(-1).effort,'high');
 assert.equal(await readFile(join(after.workspaceDir,'docs/correction.md'),'utf8'),'Windows acceptance corrected.\n');
 assert.deepEqual(await readFile(receiptPath),oldReceipt);assert.deepEqual(await readFile(join(f.stateDir,'prepared-task.json')),preparedBytes);
 assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE = 1\n');
});
test('one-call renewal can revise an accepted task without another planning call',async t=>{
 const f=await setup(t,{maxTurns:3}),before=await sessions.projectStatus(f);
 await sessions.authorizeProject({...f,maxTurns:1,note:'One explicit correction with the existing plan'});
 await sessions.revisePreparedProject({...f,taskId:'implement',note:'Windows acceptance correction'});
 const result=await sessions.resumeProjectGoal(f,{worker:f.worker});
 assert.equal(result.status,'completed');assert.equal(result.goal.id,before.goal.id);
 assert.deepEqual(f.calls.map(c=>c.part),['plan','implement','document','implement']);
 const after=await sessions.projectStatus(f);assert.equal(after.turnsUsed,1);assert.equal(after.maxTurns,1);
});
test('revision instructions survive repeated known pre-dispatch failures in the same conversation',async t=>{
 const f=await setup(t),before=await sessions.projectStatus(f);
 await sessions.revisePreparedProject({...f,taskId:'implement',note:'Windows acceptance correction'});
 for(let i=0;i<2;i++){
  const failed=await sessions.resumeProjectGoal(f,{worker:req=>{
   assert.equal(req.conversationId,CONVERSATIONS.implement);
   throw Object.assign(new Error('CODEX_PREFLIGHT_FAILED'),{dispatched:false});
  }});
  assert.equal(failed.status,'failed');assert.equal(failed.code,'CODEX_PREFLIGHT_FAILED');
  assert.equal((await sessions.projectStatus(f)).turnsUsed,before.turnsUsed);
 }
 const stopped=await sessions.projectStatus(f);
 assert.ok(stopped.goal.resume.checks.some(c=>c.stage==='acceptance-review'&&c.stderr==='Windows acceptance correction'),'the unsent human correction must remain in the checkpoint');
 const result=await sessions.resumeProjectGoal(f,{worker:async req=>{
  assert.match(req.prompt,/Windows acceptance correction/);
  assert.match(req.prompt,/CODEX_PREFLIGHT_FAILED/);
  return f.worker(req);
 }});
 assert.equal(result.status,'completed');assert.equal((await sessions.projectStatus(f)).turnsUsed,before.turnsUsed+1);
 assert.deepEqual(f.calls.map(c=>c.part),['plan','implement','document','implement']);
});

test('selected revision rejects invalid task, drift and pending work before state mutation',async t=>{
 for(const kind of ['missing','drift','pending']){
  const f=await setup(t),path=join(f.stateDir,'project.json');
  if(kind==='drift')await writeFile(join(f.stateDir,'workspace/docs/extra.md'),'Unreviewed change');
  if(kind==='pending'){const s=JSON.parse(await readFile(path,'utf8'));s.pending={phase:'model'};await writeFile(path,JSON.stringify(s));}
  const prior=await readFile(path);
  await assert.rejects(sessions.revisePreparedProject({...f,taskId:kind==='missing'?'missing':'implement',note:'Windows acceptance correction'}),new RegExp(kind==='missing'?'REVISION_TASK_MISMATCH':kind==='drift'?'GOAL_WORKSPACE_CHANGED':'PROJECT_PENDING'));
  assert.deepEqual(await readFile(path),prior);assert.equal(f.calls.length,3);
 }
});

test('selected revision rejects changed task or native session evidence and exhausted selected model',async t=>{
 for(const kind of ['task','model','conversation','missing-terminal','budget']){
  const f=await setup(t,{workerCalls:kind==='budget'?1:2}),s=await sessions.projectStatus(f),task=s.goal.results[0];
  const dir=join(f.stateDir,'tasks',task.taskId),terminalPath=join(dir,'attempt-1/accepted-terminal.json');
  if(kind==='task'){const p=join(dir,'result.json'),r=JSON.parse(await readFile(p,'utf8'));r.finalManifestHash='changed';await writeFile(p,JSON.stringify(r));}
  if(kind==='model'||kind==='conversation'){const r=JSON.parse(await readFile(terminalPath,'utf8'));if(kind==='model')r.requestedModel='gpt-6.1-terra';else r.conversation_id='invalid';await writeFile(terminalPath,JSON.stringify(r));}
  if(kind==='missing-terminal')await rm(terminalPath);
  const prior=await readFile(join(f.stateDir,'project.json'));
  await assert.rejects(sessions.revisePreparedProject({...f,taskId:'implement',note:'Windows acceptance correction'}),new RegExp(kind==='budget'?'NO_ELIGIBLE_PROFILE':'REVISION_EVIDENCE_INVALID'));
  assert.deepEqual(await readFile(join(f.stateDir,'project.json')),prior);assert.equal(f.calls.length,3);
 }
});

test('revise task selection is accepted only for revise and cannot be empty',()=>{
 assert.equal(parseArgs(['revise','--project','fixture','--task-id','implement','--note','Correction']).opts['--task-id'],'implement');
 assert.throws(()=>parseArgs(['status','--project','fixture','--task-id','implement']),/不接受/);
 assert.throws(()=>parseArgs(['revise','--project','fixture','--task-id',' ','--note','Correction']),/task-id/);
});
