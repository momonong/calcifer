import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {digest,hash} from '../src/workspace-tools.mjs';
import {buildPreparedInputContext,completionInstruction,checkPreparedCompletion} from '../src/prepared-inputs.mjs';
import {createProject,authorizeProject,workProject,projectStatus,revisePreparedProject} from '../src/project-session.mjs';
import {prepareProjectTask} from '../src/prepared-project.mjs';
const body='Confirmed equipment: SO-101. Planned demonstrations: 30–50.';
const snapshot={contents:{'spec.md':body},manifest:{files:[{path:'spec.md',hash:hash(body),bytes:Buffer.byteLength(body)}],hash:'snapshot-hash'}};
test('prepared input provides complete bounded text with hashes, never just file names',()=>{
 const b=buildPreparedInputContext(snapshot,['spec.md']);assert.ok(b.text.includes(body));assert.equal(b.files[0].hash,hash(body));assert.deepEqual(b.requiredSources,['spec.md']);
 assert.throws(()=>buildPreparedInputContext(snapshot,['missing.md']),/INPUT_MISSING/);
 const huge={contents:{'spec.md':'a'.repeat(524289)},manifest:snapshot.manifest};assert.throws(()=>buildPreparedInputContext(huge,['spec.md']),/INPUT_LIMIT/);
});
test('explicit incompleteness, missing input acknowledgement and missing report cannot pass completion',()=>{
 const b=buildPreparedInputContext(snapshot,['spec.md']);
 assert.equal(checkPreparedCompletion('No files can be read.',b).code,'COMPLETION_REPORT_INVALID');
 const report=o=>'CALCIFER_COMPLETION_JSON: '+JSON.stringify({status:'complete',inputContextHash:b.hash,sourcesReviewed:b.requiredSources,reason:'Done',...o});
 assert.equal(checkPreparedCompletion(report({status:'incomplete',reason:'Inputs unavailable'}),b).code,'WORKER_INCOMPLETE');
 assert.equal(checkPreparedCompletion(report({sourcesReviewed:[]}),b).status,'failed');
 assert.equal(checkPreparedCompletion(report({}),b).status,'passed');
 assert.match(completionInstruction(b),/CALCIFER_COMPLETION_JSON/);
});
async function setup(t){
 const root=await mkdtemp('/tmp/calcifer-input-fix-');t.after(()=>rm(root,{recursive:true,force:true}));const repo=join(root,'source'),stateDir=join(root,'state');await mkdir(join(repo,'checks'),{recursive:true});
 await writeFile(join(repo,'spec.md'),body);await writeFile(join(repo,'checks/test_docs.py'),"import unittest\nfrom pathlib import Path\nclass T(unittest.TestCase):\n def test_source(self): self.assertIn('SO-101',Path('docs/submission/proposal.md').read_text())\n");
 const profile={schemaVersion:1,name:'Prepared input test',sourceFiles:['spec.md','checks/test_docs.py'],writeRules:[{root:'docs/submission',extensions:['.md']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
 const routing={schemaVersion:1,planner:'plan',dataClass:'cloud-allowed',maxTasks:1,profiles:[{id:'plan',execution:{backend:'agy',model:'gemini-4-argon-high',version:'1.5.3',effort:'high'},capabilities:['plan'],enabled:true,available:true,maxCalls:1,resource:'included',expiresAt:null},{id:'worker',execution:{backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'},capabilities:['reasoning','implementation','routine'],enabled:true,available:true,maxCalls:5,resource:'existing-credits',expiresAt:null}],preferences:{reasoning:['worker'],implementation:['worker'],routine:['worker']}};
 const contextBase={sources:[],text:'Fixture rules.'};await createProject({stateDir,repo,profile,routing,context:{...contextBase,hash:digest(contextBase)}});
 const task='Use the confirmed source to write the proposal';await prepareProjectTask({stateDir,title:'Fixture',task,maxTurns:6,note:'Only injected test workers',documents:{source:'docs/submission/proposal.md',python:'/runtime/python',renderer:'/runtime/renderer',maxPages:10,maxBytes:20971520}});await authorizeProject({stateDir,maxTurns:6,maxMinutes:null,note:'Only injected test workers'});return {stateDir,task};
}
const terminal=(req,text,n)=>({status:'SUCCESS',conversation_id:req.conversationId??`00000000-0000-4000-8000-00000000000${n}`,requestedModel:req.model,response:text});
const plan=JSON.stringify({schemaVersion:1,tasks:[{id:'draft',kind:'reasoning',task:'Write from the provided source',preferredProfileId:'worker',reason:'Needs accurate source use',dependsOn:[],acceptance:['Confirmed equipment is used']} ]});
async function worker(req,{incomplete=false}={}){
 const packet=JSON.parse(req.prompt.match(/BEGIN_CALCIFER_INPUTS\n([^\n]+)\nEND_CALCIFER_INPUTS/)[1]);assert.equal(packet.files.find(x=>x.path==='spec.md').content,body);
 if(req.fileTools===false)return terminal(req,plan,1);
 if(!incomplete)await writeFile(join(req.directory,'docs/submission/proposal.md'),body);
 return terminal(req,'CALCIFER_COMPLETION_JSON: '+JSON.stringify({status:incomplete?'incomplete':'complete',inputContextHash:packet.hash,sourcesReviewed:packet.requiredSources,reason:incomplete?'Cannot read the required sources':'Used confirmed source'}),2);
}
test('prepared planner and worker receive file contents and completion is bound to the input receipt',async t=>{
 const f=await setup(t);const r=await workProject(f,{worker});assert.equal(r.status,'completed');const s=await projectStatus(f);assert.equal(s.turnsUsed,2);assert.ok(s.goal.results[0].completion.inputContextHash);assert.equal(s.goal.results[0].completion.status,'complete');
});
test('worker declaring incomplete stops once, preserves remaining budget and cannot be delivered as success',async t=>{
 const f=await setup(t);let calls=0;const r=await workProject(f,{worker:req=>{calls++;return worker(req,{incomplete:true});}});assert.equal(r.status,'failed');assert.equal(r.code,'WORKER_INCOMPLETE');assert.equal(calls,2);const s=await projectStatus(f);assert.equal(s.pending,null);assert.equal(s.turnsUsed,2);assert.equal(s.goal.results.length,0);
});
test('explicit revision preserves prior receipts and budget, resumes the same worker without planning again',async t=>{
 const f=await setup(t);await workProject(f,{worker});const before=await projectStatus(f);const file=join(f.stateDir,'tasks',before.goal.results[0].taskId,'result.json'),receipt=await readFile(file);
 await revisePreparedProject({...f,note:'Correct the source consistency issue found during acceptance.'});const reopened=await projectStatus(f);assert.equal(reopened.turnsUsed,2);assert.equal(reopened.maxTurns,6);assert.equal(reopened.goal.status,'failed');assert.equal(reopened.goal.results.length,0);assert.deepEqual(await readFile(file),receipt);
 let calls=0;const r=await workProject({...f,resume:true},{worker:req=>{calls++;assert.equal(req.model,'gpt-6-astra');assert.ok(req.conversationId);assert.match(req.prompt,/source consistency/);return worker(req);}});assert.equal(r.status,'completed');assert.equal(calls,1);assert.equal((await projectStatus(f)).turnsUsed,3);
});
test('revision refuses UNKNOWN and exhausted budget without changing the session',async t=>{
 for(const kind of ['unknown','exhausted']){
  const f=await setup(t);await workProject(f,{worker});const file=join(f.stateDir,'project.json'),s=JSON.parse(await readFile(file,'utf8'));
  if(kind==='unknown')s.pending={phase:'model',taskId:'original'};else s.budget.used=s.budget.maxTurns;
  await writeFile(file,JSON.stringify(s));const bytes=await readFile(file);
  await assert.rejects(revisePreparedProject({...f,note:'Concrete correction'}),kind==='unknown'?/PROJECT_PENDING/:/RESOURCE_LIMIT/);assert.deepEqual(await readFile(file),bytes);
 }
});
