import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from '../src/workspace-tools.mjs';
import {validateProfile,canEditProject} from '../src/project-profile.mjs';
import {createProject,authorizeProject,workProject,projectStatus,exportProject,reconcileProject} from '../src/project-session.mjs';
const profile={schemaVersion:1,name:'Taskboard CLI',sourceFiles:['taskboard/count.py','checks/test_count.py','README.md'],writeRules:[{root:'taskboard',extensions:['.py']},{root:'checks',extensions:['.py']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
const ID='00000000-0000-4000-8000-000000000003';
async function fixture(backend,selectedProfile=profile){
 const base=await mkdtemp('/tmp/calcifer-generic-test-'),repo=join(base,'source'),stateDir=join(base,'state');
 await mkdir(join(repo,'taskboard'),{recursive:true});await mkdir(join(repo,'checks'));
 await writeFile(join(repo,'taskboard/count.py'),'VALUE=1\n');await writeFile(join(repo,'README.md'),'Immutable input\n');
 if(selectedProfile.sourceFiles.includes('taskboard/input.json'))await writeFile(join(repo,'taskboard/input.json'),'{"immutable":true}\n');
 await writeFile(join(repo,'checks/test_count.py'),'import unittest\nfrom taskboard.count import VALUE\nclass T(unittest.TestCase):\n def test_positive(self): self.assertGreater(VALUE,0)\n');
 const text='Rules for a generic fixture.',sources=[],context={text,sources,hash:digest({sources,text})};
 await createProject({repo,stateDir,profile:selectedProfile,backend,context});
 return {repo,stateDir};
}
test('profile scope is project-independent and rejects controls, traversal and unverified check kinds',()=>{
 const p=validateProfile(profile);assert.equal(canEditProject('taskboard/count.py',p),true);assert.equal(canEditProject('erasebot/file.py',p),false);assert.equal(canEditProject('taskboard/.env',p),false);assert.throws(()=>validateProfile({...profile,writeRules:[{root:'.',extensions:['.py']}]}),/SCOPE/);assert.throws(()=>validateProfile({...profile,sourceFiles:['../source.py']}),/SCOPE/);assert.throws(()=>validateProfile({...profile,check:{...profile.check,kind:'arbitrary-shell'}}),/UNSUPPORTED/);
});
test('core passes selected immutable inputs inside writable directories to the backend',async()=>{
 const f=await fixture('codex',{...profile,sourceFiles:[...profile.sourceFiles,'taskboard/input.json']});
 await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Offline immutable input scope test'});let seen;
 const result=await workProject({...f,task:'Leave immutable inputs unchanged'},{worker:async req=>{seen=req;return{status:'SUCCESS',conversation_id:ID,response:'Fixture only',requestedModel:req.model};}});
 assert.equal(result.status,'completed');assert.deepEqual(seen.readOnlyPaths,['README.md','taskboard/input.json']);
});
test('nested AGENTS.md is rejected as general source or edit and cannot enter a patch',async()=>{
 const markdown={...profile,writeRules:[...profile.writeRules,{root:'notes',extensions:['.md']}]};
 for(const path of ['AGENTS.md','notes/AGENTS.md','notes/deep/AGENTS.md']){
  assert.throws(()=>validateProfile({...markdown,sourceFiles:[...markdown.sourceFiles,path]}),/PROJECT_SOURCE_SCOPE_INVALID/);
  assert.equal(canEditProject(path,markdown),false,path);
 }
 const f=await fixture('codex',markdown),s=await projectStatus(f);
 await mkdir(join(s.workspaceDir,'notes/deep'),{recursive:true});await writeFile(join(s.workspaceDir,'notes/deep/AGENTS.md'),'Do not change controls.\n');
 assert.equal((await projectStatus(f)).code,'IMMUTABLE_PROJECT_FILE');
 await assert.rejects(exportProject(f),/IMMUTABLE_PROJECT_FILE/);
});
for(const backend of ['agy','codex'])test(`generic ${backend} workflow edits a non-Thor package, runs configured host tests, exports and preserves source`,async()=>{
 const f=await fixture(backend);const before=await projectStatus(f);assert.equal(before.backend,backend);assert.equal(before.projectName,'Taskboard CLI');
 await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Offline synthetic adapter test'});
 let seen;
 const r=await workProject({...f,task:'Set taskboard value to two'}, {worker:async req=>{seen=req;await writeFile(join(req.directory,'taskboard/count.py'),'VALUE=2\n');return{status:'SUCCESS',conversation_id:ID,response:'Changed taskboard value',actualModel:backend==='agy'?'gemini-4-argon-medium':null,requestedModel:req.model,modelEvidence:'fixture only'};}});
 assert.equal(r.status,'completed');assert.match(seen.prompt,/taskboard/);assert.doesNotMatch(seen.prompt,/erasebot|Thor/);assert.deepEqual(seen.writeRoots,['taskboard','checks']);
 assert.ok(r.checks[0].stderr.includes('Ran 1 test'));assert.equal(await readFile(join(f.repo,'taskboard/count.py'),'utf8'),'VALUE=1\n');
 const out=await exportProject(f);assert.match(await readFile(out.patchPath,'utf8'),/\+VALUE=2/);const s=await projectStatus(f);assert.equal(s.conversationId,ID);assert.equal(s.turnsUsed,1);
});
test('Codex unknown receipt cannot be cleared by changing backend/profile or reopening',async()=>{
 const f=await fixture('codex');await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Offline unknown fixture'});
 const r=await workProject({...f,task:'change'},{worker:async()=>{throw new Error('CODEX_RESULT_UNKNOWN');}});assert.equal(r.status,'unknown');assert.equal((await reconcileProject(f)).status,'unknown');
 await assert.rejects(authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'try again'}),/PENDING/);
 const path=join(f.stateDir,'project.json'),s=JSON.parse(await readFile(path,'utf8'));s.execution.backend='agy';await writeFile(path,JSON.stringify(s));await assert.rejects(projectStatus(f),/STATE_INVALID|EXECUTION/);
});

test('Codex recovery accepts only original completed native session; invalid stream stays pending',async()=>{
 const f=await fixture('codex');await authorizeProject({...f,maxTurns:1,maxMinutes:1,note:'Offline recovery fixture'});let evidenceDir;
 const terminal={status:'SUCCESS',conversation_id:ID,response:'Synthetic completion',requestedModel:'gpt-6.1-sol'};
 await workProject({...f,task:'fixture'}, {worker:async r=>{evidenceDir=r.evidenceDir;await writeFile(join(evidenceDir,'terminal.json'),JSON.stringify(terminal));await writeFile(join(evidenceDir,'process.json'),JSON.stringify({closed:true,exitCode:0,parseError:true}));await writeFile(join(evidenceDir,'session.json'),JSON.stringify({conversationId:ID,backend:'codex',requestedModel:r.model,init:{model:null}}));throw new Error('HOST_INTERRUPTED');}});
 assert.equal((await reconcileProject(f)).status,'unknown');
 await writeFile(join(evidenceDir,'process.json'),JSON.stringify({closed:true,exitCode:0,parseError:false}));
 const recovered=await reconcileProject(f);assert.equal(recovered.status,'ready');assert.equal(recovered.conversationId,ID);assert.equal(recovered.turnsUsed,1);
});
test('Codex native-protocol fixture completes and resumes through the backend registry and host checker',async()=>{
 const {selectedWorker,EXECUTIONS}=await import('../src/project-execution.mjs');const f=await fixture('codex');
 const executable=join(f.stateDir,'fixture-codex.mjs');
 await writeFile(executable,`#!/usr/bin/node
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex-cli ${EXECUTIONS.codex.version}');process.exit(0)}
if(args[0]==='login'){console.error('Logged in using ChatGPT');process.exit(0)}
if(args.includes('sandbox'))process.exit(0);
let input='';for await(const c of process.stdin)input+=c;
const resumed=args.includes('resume');
if(resumed&&!args.includes('${ID}'))process.exit(9);
const {writeFile}=await import('node:fs/promises');await writeFile('taskboard/count.py','VALUE='+ (resumed?3:2)+'\\n');
console.log(JSON.stringify({type:'thread.started',thread_id:'${ID}'}));
console.log(JSON.stringify({type:'turn.started'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Synthetic protocol fixture only'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
`,{mode:0o700});
 await authorizeProject({...f,maxTurns:2,maxMinutes:1,note:'Offline CLI protocol integration only'});
 const deps={worker:r=>selectedWorker('codex',{...r,executable})};
 assert.equal((await workProject({...f,task:'set two'},deps)).status,'completed');
 assert.equal((await workProject({...f,task:'set three'},deps)).status,'completed');
 const s=await projectStatus(f);assert.equal(s.conversationId,ID);assert.equal(s.turnsUsed,2);
 assert.equal(await readFile(join(s.workspaceDir,'taskboard/count.py'),'utf8'),'VALUE=3\n');
 assert.equal(await readFile(join(f.repo,'taskboard/count.py'),'utf8'),'VALUE=1\n');
 assert.match(await readFile((await exportProject(f)).patchPath,'utf8'),/\+VALUE=3/);
});
