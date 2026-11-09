import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {main,parseArgs} from '../src/calcifer-cli.mjs';
import {createProject} from '../src/project-session.mjs';
import {readProjectSnapshot} from '../src/project-workspace.mjs';
import {digest,hash} from '../src/workspace-tools.mjs';

const status={projectId:'00000000-0000-4000-8000-000000000001',projectName:'Sample',status:'ready',backend:'codex',execution:{backend:'codex',model:'gpt-6-astra',effort:'high'},model:'gpt-6-astra',workspaceDir:'/state/workspace',maxTurns:8,turnsUsed:2,maxMinutes:null,pending:null,goal:{id:'g',status:'completed',assignments:[]},lastChecks:{status:'passed',manifestHash:'h',checks:[{status:'passed',stderr:'Ran 42 tests in 0.2s\nOK'}]},workspaceManifestHash:'h',changedFiles:[{path:'app/value.py'}],files:['app/value.py']};
function harness(extra={}) {
 let out='',err='';const proc=new EventEmitter();
 return {home:'/home/test',stdin:{isTTY:false},stdout:{isTTY:false,write:s=>out+=s},stderr:{write:s=>err+=s},process:proc,api:{lookupProject:async()=>null,projectStatus:async()=>structuredClone(status),...extra},result:()=>({out,err}),proc};
}
const result=h=>JSON.parse(h.result().out);

test('action flags alias subcommands; projectless list and machine entry do not select interactively',()=>{
 for(const action of ['status','start','resume','recover','test','diff','export','deliver','files','result'])assert.equal(parseArgs([`--${action}`,'--project','p','--json']).command,action);
 assert.equal(parseArgs(['--list','--json']).command,'list');
 assert.equal(parseArgs(['--json']).command,'list');
 assert.equal(parseArgs(['--project','p','--json']).command,'status');
 assert.equal(parseArgs(['--work','A concrete change','--project','p']).task,'A concrete change');
 for(const args of [['--status','--resume','--project','p'],['work','task','--status','--project','p'],['--status','--project','p','--json','--jsonl']])assert.throws(()=>parseArgs(args));
});
test('JSON status is one object, preserves real state and omits raw request/auth text',async()=>{
 const h=harness({projectStatus:async()=>({...status,pending:{taskId:'request-1',phase:'model'},status:'unknown',authorization:'PRIVATE_AUTH_NOTE',lastTask:{task:'PRIVATE_PROMPT',response:'token=DO_NOT_PRINT'},lastResponse:'token=DO_NOT_PRINT'})});
 assert.equal(await main(['--status','--project','p','--json'],h),0);
 const r=result(h);assert.equal(r.schemaVersion,1);assert.equal(r.type,'result');assert.equal(r.command,'status');assert.equal(r.ok,true);
 assert.equal(r.data.status,'unknown');assert.equal(r.data.pending.taskId,'request-1');assert.deepEqual(r.nextActions,['recover']);
 assert.equal(r.data.turnsUsed,2);assert.equal(r.data.maxTurns,8);
 assert.doesNotMatch(h.result().out,/PRIVATE_PROMPT|PRIVATE_AUTH_NOTE|DO_NOT_PRINT/);
});
test('JSON parse errors, help and version are machine-readable without loading host APIs',async()=>{
 const h=harness();assert.equal(await main(['--status','--project','p','--surprise','--json'],h),2);
 assert.equal(result(h).error.code,'CLI_USAGE');assert.equal(result(h).ok,false);
 for(const action of ['--help','--version']){const v=harness();assert.equal(await main([action,'--json'],v),0);assert.equal(result(v).ok,true);}
});
test('JSONL status and start do not emit raw task bodies; quoted credentials are redacted',async()=>{
 const h=harness({projectStatus:async()=>({...status,lastTask:{task:'PRIVATE_TASK_BODY'},lastResponse:'Diagnostic {"token":"SYNTHETIC_CREDENTIAL_VALUE","api_key": "ANOTHER_SYNTHETIC_VALUE"}'})});
 assert.equal(await main(['--status','--project','p','--jsonl'],h),0);
 assert.doesNotMatch(h.result().out,/PRIVATE_TASK_BODY|SYNTHETIC_CREDENTIAL_VALUE|ANOTHER_SYNTHETIC_VALUE/);
 const s=harness({readPreparedTask:async()=>({title:'Prepared',task:'PRIVATE_PREPARED_TASK_BODY',maxTurns:8,note:'phase'}),projectStatus:async()=>({...status,maxTurns:null,goal:null}),authorizeProject:()=>assert.fail('not approved')});
 assert.equal(await main(['--start','--project','p','--jsonl'],s),2);assert.doesNotMatch(s.result().out,/PRIVATE_PREPARED_TASK_BODY/);
});
test('list reports unreadable projects and never prompts on a TTY in JSON mode',async()=>{
 const h=harness({discoverProjects:async()=>[{project:'p',stateDir:'/state',projectId:status.projectId},{project:'broken',error:'REGISTRY_STATE_MISSING'}]});
 h.stdin.isTTY=true;h.stdout.isTTY=true;h.createInterface=()=>assert.fail('machine mode must not prompt');
 assert.equal(await main(['--list','--json'],h),0);
 assert.equal(result(h).data.projects.length,2);assert.equal(result(h).data.projects[1].error.code,'REGISTRY_STATE_MISSING');
});
test('machine authorization requires explicit yes even on TTY',async()=>{
 let calls=0;const h=harness({authorizeProject:async()=>{calls++;return status;}});h.stdin.isTTY=true;h.stdout.isTTY=true;h.createInterface=()=>assert.fail('no interactive approval');
 assert.equal(await main(['--authorize','--project','p','--turns','8','--note','Explicit phase','--json'],h),2);
 assert.equal(calls,0);assert.equal(result(h).error.code,'CONFIRMATION_REQUIRED');
});
test('work takes an exact bounded UTF-8 task file and separates JSONL progress from final result',async t=>{
 const dir=await mkdtemp('/tmp/calcifer-command-task-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'task.md');const task='Implement the requested change.\nDo not lower acceptance.\n';await writeFile(file,task);
 let calls=0;const h=harness({workProject:async p=>{calls++;assert.equal(p.task,task);p.onEvent({event:'route',taskId:'implement',profileId:'astra',execution:status.execution,raw:'SECRET_NATIVE_EVENT'});p.onEvent({event:'dispatch',model:'gpt-6-astra',used:3,max:8,raw:'SECRET_NATIVE_EVENT'});p.onEvent({type:'unknown',raw:'SECRET_NATIVE_EVENT'});return {status:'completed',response:'Done',checks:[{status:'passed'}]};}});
 assert.equal(await main(['--work','--task-file',file,'--project','p','--jsonl'],h),0);assert.equal(calls,1);
 const lines=h.result().out.trim().split('\n').map(x=>JSON.parse(x));assert.equal(lines.at(-1).type,'result');assert.equal(lines.filter(x=>x.type==='result').length,1);
 assert.ok(lines.some(x=>x.type==='event'&&x.event==='route'));assert.ok(lines.some(x=>x.type==='event'&&x.event==='dispatch'));
 assert.equal(lines.at(-1).data.status,'completed');assert.doesNotMatch(h.result().out,/SECRET_NATIVE_EVENT/);
 await symlink(file,join(dir,'link.md'));
 for(const input of [join(dir,'link.md'),join(dir,'large.md')]){if(input.endsWith('large.md'))await writeFile(input,'x'.repeat(50001));const b=harness({workProject:()=>assert.fail('invalid input never dispatches')});assert.equal(await main(['--work','--task-file',input,'--project','p','--json'],b),1);}
 assert.throws(()=>parseArgs(['--work','extra text','--task-file',file,'--project','p']));
});
test('prepare freezes a coding task through existing API without authorizing or dispatching',async t=>{
 const dir=await mkdtemp('/tmp/calcifer-command-prepare-');t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'task.md');await writeFile(path,'Implement and verify the feature.');let received;
 const h=harness({prepareProjectTask:async p=>{received=p;return {...p,hash:'prepared-hash'};},authorizeProject:()=>assert.fail('prepare is not approval'),workProject:()=>assert.fail('prepare is not dispatch')});
 assert.equal(await main(['--prepare','--state','/state','--task-file',path,'--title','Feature','--turns','8','--note','Bounded data and models','--json'],h),0);
 assert.equal(received.documents,null);assert.equal(received.maxTurns,8);assert.equal(received.task,'Implement and verify the feature.');assert.equal(result(h).data.hash,'prepared-hash');
});
test('revise records an exact bounded correction without dispatch or budget reset',async t=>{
 const dir=await mkdtemp('/tmp/calcifer-command-revise-');t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'review.md'),note='Correct the specific unsupported claim.\nPreserve all original acceptance.';await writeFile(file,note);let received;
 const h=harness({revisePreparedProject:async p=>{received=p;return {...status,goal:{id:'g',status:'failed'}};},authorizeProject:()=>assert.fail('no new budget'),workProject:()=>assert.fail('record only')});
 assert.equal(await main(['--revise','--state','/state','--note-file',file,'--json'],h),0);assert.deepEqual(received,{stateDir:'/state',note});assert.equal(result(h).data.turnsUsed,2);assert.equal(result(h).data.goal.status,'failed');
 for(const args of [[],['--note',''],['--note','   ','--note-file',file],['--note','text','--note-file',file],['--note-file','relative.md']])assert.throws(()=>parseArgs(['--revise','--state','/state',...args]));
 const failure=harness({revisePreparedProject:async()=>{throw new Error('PROJECT_PENDING');}});assert.equal(await main(['--revise','--state','/state','--note','Concrete change','--json'],failure),1);assert.equal(result(failure).error.code,'PROJECT_PENDING');assert.deepEqual(result(failure).nextActions,['recover']);
});
test('failed tests and UNKNOWN work keep failure codes and never export or retry',async()=>{
 let calls=0;const h=harness({workProject:async()=>{calls++;return {status:'unknown',code:'RESULT_UNKNOWN'};},exportProject:()=>assert.fail('do not export')});
 assert.equal(await main(['--work','Task','--project','p','--json'],h),1);assert.equal(calls,1);assert.equal(result(h).error.code,'RESULT_UNKNOWN');assert.deepEqual(result(h).nextActions,['recover']);
 const f=harness({testProject:async()=>({status:'failed',checks:[{stage:'project',status:'failed',stderr:'AssertionError: expected result'}]})});
 assert.equal(await main(['--test','--project','p','--json'],f),1);assert.equal(result(f).data.checks[0].status,'failed');assert.match(result(f).data.checks[0].stderr,/AssertionError/);
});
test('cancellation emits structured state and aborts the same request only once',async()=>{
 let calls=0;const h=harness({workProject:async p=>{calls++;h.proc.emit('SIGINT');assert.equal(p.signal.aborted,true);return {status:'unknown',code:'RESULT_UNKNOWN'};}});
 assert.equal(await main(['--work','Task','--project','p','--jsonl'],h),1);assert.equal(calls,1);
 const lines=h.result().out.trim().split('\n').map(x=>JSON.parse(x));assert.ok(lines.some(x=>x.event==='cancel_requested'));assert.equal(lines.at(-1).error.code,'RESULT_UNKNOWN');assert.equal(h.proc.listenerCount('SIGINT'),0);
});
test('files, diff and export return structured artifacts, not prose parsing',async()=>{
 const h=harness();assert.equal(await main(['--files','--state','/state','--json'],h),0);assert.deepEqual(result(h).data.files,['app/value.py']);
 const d=harness({projectDiff:async()=>'+VALUE=2\n'});assert.equal(await main(['--diff','--state','/state','--json'],d),0);assert.equal(result(d).data.diff,'+VALUE=2\n');
 const e=harness({exportProject:async()=>({patchPath:'/state/exports/one.patch',patchHash:'h',checks:[{status:'passed'}],sourceMatches:true})});assert.equal(await main(['--export','--state','/state','--json'],e),0);assert.equal(result(e).data.patchPath,'/state/exports/one.patch');
});
test('files distinguishes unreadable workspace from an empty or previously failed task',async()=>{
 const bad=harness({projectStatus:async()=>({...status,status:'failed',code:'SYMLINK_REJECTED',workspaceError:'SYMLINK_REJECTED',workspaceManifestHash:undefined,files:[],changedFiles:[]})});
 assert.equal(await main(['--files','--state','/state','--json'],bad),1);assert.equal(result(bad).error.code,'SYMLINK_REJECTED');assert.equal(result(bad).data.workspaceError,'SYMLINK_REJECTED');
 const prior=harness({projectStatus:async()=>({...status,status:'failed',code:'CHECKS_FAILED',workspaceError:null})});
 assert.equal(await main(['--files','--state','/state','--json'],prior),0);assert.deepEqual(result(prior).data.files,['app/value.py']);
});

async function saved(t){
 const dir=await mkdtemp('/tmp/calcifer-result-');t.after(()=>rm(dir,{recursive:true,force:true}));const repo=join(dir,'source'),stateDir=join(dir,'state');await mkdir(join(repo,'app'),{recursive:true});await mkdir(join(repo,'checks'));
 await writeFile(join(repo,'app/value.py'),'VALUE=1\n');await writeFile(join(repo,'checks/test_value.py'),'import unittest\n');
 const profile={schemaVersion:1,name:'Result fixture',sourceFiles:['app/value.py','checks/test_value.py'],writeRules:[{root:'app',extensions:['.py']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:1000}};
 const ctx={sources:[],text:'Offline fixture, no model.'};await createProject({stateDir,repo,profile,backend:'codex',model:'gpt-6-astra',effort:'high',context:{...ctx,hash:digest(ctx)}});
 const snapshot=await readProjectSnapshot(join(stateDir,'workspace'));const path=join(stateDir,'project.json');const s=JSON.parse(await readFile(path,'utf8'));s.goal={id:'goal-1',status:'completed',finalManifestHash:snapshot.manifest.hash};s.lastChecks={status:'passed',manifestHash:snapshot.manifest.hash,checks:[{status:'passed'}]};await writeFile(path,JSON.stringify(s));
 const patchPath=join(stateDir,'exports','fixture.patch'),patch='diff --git a/app/value.py b/app/value.py\n';await writeFile(patchPath,patch);await writeFile(patchPath+'.receipt.json',JSON.stringify({schemaVersion:1,patchPath,patchHash:hash(patch),finalManifestHash:snapshot.manifest.hash,changedFiles:1}));
 return {stateDir,path,patchPath,s};
}
async function query(stateDir){let out='',err='';const code=await main(['--result','--state',stateDir,'--json'],{stdout:{write:x=>out+=x},stderr:{write:x=>err+=x},stdin:{isTTY:false},process:new EventEmitter()});assert.equal(code,0,err);return JSON.parse(out);}
test('result verifies saved patch and current checks without mutating state or dispatching',async t=>{
 const f=await saved(t),before=await readFile(f.path);const r=await query(f.stateDir);
 assert.equal(r.data.artifacts.patches[0].verified,true);assert.equal(r.data.artifacts.patches[0].current,true);assert.equal(r.data.checksCurrent,true);assert.equal(r.data.humanAccepted,'unknown');assert.equal(r.data.integrationStatus,'unknown');
 assert.deepEqual(await readFile(f.path),before);await query(f.stateDir);assert.deepEqual(await readFile(f.path),before);
});
test('result distinguishes modified workspace from valid historical artifact bytes',async t=>{
 const f=await saved(t);await writeFile(join(f.stateDir,'workspace/app/value.py'),'VALUE=3\n');const r=await query(f.stateDir);
 assert.equal(r.data.artifacts.patches[0].verified,true);assert.equal(r.data.artifacts.patches[0].current,false);assert.equal(r.data.checksCurrent,false);
});
test('result rejects damaged patches and outside/symlink delivery pointers',async t=>{
 const f=await saved(t);await writeFile(f.patchPath,'damaged');await writeFile(join(f.stateDir,'latest-delivery.json'),JSON.stringify({directory:'/etc',status:'draft'}));let r=await query(f.stateDir);
 assert.equal(r.data.artifacts.patches[0].verified,false);assert.equal(r.data.artifacts.documents,null);assert.ok(r.data.artifacts.warnings.length);
 await rm(join(f.stateDir,'latest-delivery.json'));await rm(f.patchPath);await symlink('/etc/hostname',f.patchPath);r=await query(f.stateDir);assert.equal(r.data.artifacts.patches[0].verified,false);
});
test('a saved delivery pointer with missing artifacts yields an explicit diagnostic',async t=>{
 const f=await saved(t);await writeFile(join(f.stateDir,'latest-delivery.json'),JSON.stringify({directory:join(f.stateDir,'deliveries','missing'),status:'draft'}));
 const r=await query(f.stateDir);assert.ok(r.data.artifacts.warnings.some(w=>w.kind==='documents'&&w.code==='ARTIFACT_MISSING'));
});
