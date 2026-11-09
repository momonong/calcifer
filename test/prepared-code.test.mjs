import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import * as sessions from '../src/project-session.mjs';
import * as prepared from '../src/prepared-project.mjs';
import {digest} from '../src/workspace-tools.mjs';
import {main} from '../src/calcifer-cli.mjs';

async function setup(t){
 const base=await mkdtemp('/tmp/calcifer-prepared-code-');t.after(()=>rm(base,{recursive:true,force:true}));
 const repo=join(base,'source'),stateDir=join(base,'state');await mkdir(join(repo,'checks'),{recursive:true});await mkdir(join(repo,'app'));
 await writeFile(join(repo,'app/value.py'),'VALUE = 1\n');await writeFile(join(repo,'spec.md'),'Set VALUE to 2 and deliver usage instructions.');
 await writeFile(join(repo,'checks/test_value.py'),"import unittest\nfrom app.value import VALUE\nfrom pathlib import Path\nclass Acceptance(unittest.TestCase):\n def test_result(self): self.assertEqual(VALUE,2)\n def test_usage(self): self.assertIn('VALUE',Path('docs/usage.md').read_text())\n");
 const profile={schemaVersion:1,name:'Non-Thor coding fixture',sourceFiles:['app/value.py','spec.md','checks/test_value.py'],writeRules:[{root:'app',extensions:['.py']},{root:'docs',extensions:['.md']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
 const routing={schemaVersion:1,planner:'plan',dataClass:'cloud-allowed',maxTasks:1,profiles:[{id:'plan',execution:{backend:'agy',model:'gemini-4-argon-high',version:'1.5.3',effort:'high'},capabilities:['plan'],enabled:true,available:true,maxCalls:1,resource:'included',expiresAt:null},{id:'worker',execution:{backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'},capabilities:['reasoning','implementation','routine'],enabled:true,available:true,maxCalls:4,resource:'existing-credits',expiresAt:null}],preferences:{reasoning:['worker'],implementation:['worker'],routine:['worker']}};
 const ctx={sources:[],text:'Synthetic fixture only. No real models.'};await sessions.createProject({stateDir,repo,profile,routing,context:{...ctx,hash:digest(ctx)}});
 const options={stateDir,title:'Coding fixture',task:'Set VALUE to 2 and write docs/usage.md.',maxTurns:5,note:'Offline injected worker only',documents:null};
 await prepared.prepareProjectTask(options);return {...options,repo};
}
function worker({incomplete=false,failOnce=false,unknown=false}={}){
 let packet,calls=0,workCalls=0,conversation;
 const fn=async req=>{
  calls++;const match=req.prompt.match(/BEGIN_CALCIFER_INPUTS\n([^\n]+)\nEND_CALCIFER_INPUTS/);if(match){
   packet=JSON.parse(match[1]);
   // A completed-goal revision receives the current accepted workspace, while
   // an internal failed-attempt correction reuses the original input packet.
   assert.equal(packet.files.find(f=>f.path==='app/value.py').content,`VALUE = ${workCalls>0&&!failOnce?2:1}\n`);
  }
  if(req.fileTools===false)return {status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',requestedModel:req.model,response:JSON.stringify({schemaVersion:1,tasks:[{id:'implement',kind:'implementation',task:'Implement the requested code and usage.',preferredProfileId:'worker',reason:'A single scoped implementation.',dependsOn:[],acceptance:['VALUE equals 2','Usage exists']}]})};
  workCalls++;if(unknown)throw new Error('RESULT_UNKNOWN');
  if(workCalls>1)assert.equal(req.conversationId,conversation);conversation=req.conversationId??'00000000-0000-4000-8000-000000000002';
  if(!incomplete){await writeFile(join(req.directory,'app/value.py'),`VALUE = ${failOnce&&workCalls===1?1:2}\n`);await writeFile(join(req.directory,'docs/usage.md'),workCalls>1?'VALUE is 2. Its definition is in app/value.py.':'VALUE is 2.');}
  return {status:'SUCCESS',conversation_id:conversation,requestedModel:req.model,response:'CALCIFER_COMPLETION_JSON: '+JSON.stringify({status:incomplete?'incomplete':'complete',inputContextHash:packet.hash,sourcesReviewed:packet.requiredSources,reason:incomplete?'Cannot finish the requested result':'Code and usage written; host validation remains.'})};
 };
 fn.counts=()=>({calls,workCalls});return fn;
}
function cli(f,w){
 let out='',err='';const api={...sessions,...prepared,workProject:p=>sessions.workProject(p,{worker:w}),resumeProjectGoal:p=>sessions.resumeProjectGoal(p,{worker:w}),deliverProjectDocuments:()=>{throw new Error('UNEXPECTED_DOCUMENT_RENDER');}};
 return {run:args=>main([...args,'--state',f.stateDir],{api,process:new EventEmitter(),stdin:{isTTY:false},stdout:{write:x=>out+=x},stderr:{write:x=>err+=x}}),text:()=>out+err};
}
test('coding preparation remains unapproved and source-bound without requiring PDF configuration',async t=>{
 const f=await setup(t),s=await sessions.projectStatus(f);assert.equal(s.maxTurns,null);assert.equal((await prepared.readPreparedTask(f)).documents,null);
});
test('start produces a real verified code patch; delivery again never calls models or spends budget',async t=>{
 const f=await setup(t),w=worker(),c=cli(f,w);assert.equal(await c.run(['start','--yes']),0,c.text());
 assert.equal(w.counts().calls,2);assert.match(c.text(),/\.patch/);assert.doesNotMatch(c.text(),/PDF|Word|UNEXPECTED_DOCUMENT/);
 const s=await sessions.projectStatus(f);assert.equal(s.goal.status,'completed');assert.equal(s.turnsUsed,2);assert.ok(s.goal.results[0].completion.inputContextHash);
 const patch=await sessions.exportProject(f);assert.match(await readFile(patch.patchPath,'utf8'),/\+VALUE = 2/);assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE = 1\n');
 assert.equal(await c.run(['start']),0);assert.equal(w.counts().calls,2);assert.equal((await sessions.projectStatus(f)).turnsUsed,2);
});
test('coding source incompleteness is not converted into a successful patch or an automatic retry',async t=>{
 const f=await setup(t),w=worker({incomplete:true}),c=cli(f,w);assert.equal(await c.run(['start','--yes']),1);assert.equal(w.counts().calls,2);assert.match(c.text(),/WORKER_INCOMPLETE/);
 await assert.rejects(sessions.exportProject(f),/GOAL_INCOMPLETE/);
});
test('known coding failure is corrected in the original worker conversation and consumes exactly one more call',async t=>{
 const f=await setup(t),w=worker({failOnce:true}),c=cli(f,w);assert.equal(await c.run(['start','--yes']),0,c.text());assert.equal(w.counts().calls,3);assert.equal(w.counts().workCalls,2);assert.equal((await sessions.projectStatus(f)).turnsUsed,3);
});
test('unknown coding result cannot be restarted, redelivered or reauthorized',async t=>{
 const f=await setup(t),w=worker({unknown:true}),c=cli(f,w);assert.equal(await c.run(['start','--yes']),1);assert.equal(await c.run(['start','--yes']),1);assert.equal(await c.run(['deliver']),1);assert.equal(w.counts().calls,2);
 await assert.rejects(sessions.authorizeProject({...f,maxTurns:5,note:'No bypass'}),/PROJECT_PENDING/);
});
test('machine start completes the real host pipeline and returns the verified patch as JSONL',async t=>{
 const f=await setup(t),w=worker();let out='',err='';
 const api={...sessions,...prepared,workProject:p=>sessions.workProject(p,{worker:w}),resumeProjectGoal:p=>sessions.resumeProjectGoal(p,{worker:w})};
 const h={api,stdin:{isTTY:false},stdout:{write:x=>out+=x},stderr:{write:x=>err+=x},process:new EventEmitter()};
 assert.equal(await main(['--start','--state',f.stateDir,'--yes','--jsonl'],h),0,err);
 const lines=out.trim().split('\n').map(x=>JSON.parse(x)),result=lines.at(-1);
 assert.equal(result.type,'result');assert.equal(result.command,'start');assert.equal(result.ok,true);assert.match(result.data.patchPath,/\.patch$/);assert.equal(result.data.checks.every(c=>c.status==='passed'),true);
 assert.equal(lines.filter(x=>x.type==='result').length,1);assert.ok(lines.some(x=>x.event==='dispatch'));assert.equal(w.counts().calls,2);
 assert.equal((await sessions.projectStatus(f)).goal.status,'completed');assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE = 1\n');
});
test('CLI revision resumes the same worker, preserves previous delivery and spends no planner call',async t=>{
 const f=await setup(t),w=worker(),c=cli(f,w);assert.equal(await c.run(['--start','--yes']),0,c.text());
 const before=await sessions.projectStatus(f),oldTaskId=before.goal.results[0].taskId,oldResult=join(f.stateDir,'tasks',oldTaskId,'result.json'),oldBytes=await readFile(oldResult),exported=await sessions.exportProject(f),patchBytes=await readFile(exported.patchPath);
 const noteFile=join(f.stateDir,'acceptance-review.md');await writeFile(noteFile,'Clarify VALUE in the existing usage document; retain the frozen acceptance.');
 assert.equal(await c.run(['--revise','--note-file',noteFile,'--json']),0,c.text());
 const reopened=await sessions.projectStatus(f);assert.equal(reopened.turnsUsed,2);assert.equal(reopened.goal.id,before.goal.id);assert.equal(reopened.goal.status,'failed');assert.equal(w.counts().calls,2);
 assert.deepEqual(await readFile(oldResult),oldBytes);assert.deepEqual(await readFile(exported.patchPath),patchBytes);
 assert.equal(await c.run(['--start','--jsonl']),0,c.text());assert.equal(w.counts().calls,3);assert.equal(w.counts().workCalls,2);
 const after=await sessions.projectStatus(f);assert.equal(after.goal.status,'completed');assert.equal(after.turnsUsed,3);assert.equal(after.maxTurns,5);assert.equal(after.goal.id,before.goal.id);
 assert.match(await readFile(join(after.workspaceDir,'docs/usage.md'),'utf8'),/definition is in app\/value.py/);
 assert.deepEqual(await readFile(oldResult),oldBytes);assert.deepEqual(await readFile(exported.patchPath),patchBytes);assert.equal(await readFile(join(f.repo,'app/value.py'),'utf8'),'VALUE = 1\n');
});
