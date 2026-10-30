import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, readdir, lstat, unlink, link, symlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fixture } from './helpers/collaboration.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { digest } from '../src/workspace-tools.mjs';
import { runCollaboration } from '../src/collaboration-runner.mjs';
const cwd=new URL('../',import.meta.url);
async function saved(changes={'note.txt':['old\n','new\n']}){
 const f=await fixture();const paths=Object.keys(changes);
 for(const[path,[before]]of Object.entries(changes)){await mkdir(dirname(join(f.host.sourceDir,path)),{recursive:true});await writeFile(join(f.host.sourceDir,path),before);}
 Object.assign(f.host,{sourceFiles:paths,readPaths:paths,allowedPaths:paths,checks:{final:{kind:'mock',definition:'trusted synthetic export input',evaluate:async()=>true}},workerTimeoutMs:2000});
 f.plan.tasks=[{id:'edit',instruction:'Synthetic content edits',dependsOn:[],requiredCapabilities:['edit'],writePaths:paths,checkIds:[]}];
 f.report=await runCollaboration({plan:f.plan,host:f.host,worker:async({tools})=>{for(const[path,[before,after]]of Object.entries(changes)){if(before===after)continue;const file=await tools.dispatch({action:'read',args:{path}});await tools.dispatch({action:'edit',args:{path,expectedHash:file.hash,content:after}});}return{status:'completed'};}});
 assert.equal(f.report.status,'completed');return f;
}
const blob=text=>createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0'+text).digest('hex');
const expectedPatch=(path,before,after)=>`diff --git a/${path} b/${path}\nindex ${blob(before)}..${blob(after)} 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}+${after}`;
async function treeDigest(root){const files=[];const walk=async(dir,prefix='')=>{for(const name of(await readdir(dir)).sort()){const path=join(dir,name),info=await lstat(path);if(info.isDirectory())await walk(path,prefix+name+'/');else files.push([prefix+name,info.mode,info.nlink,digest((await readFile(path)).toString('base64'))]);}};await walk(root);return digest(files);}
test('fixed Git backend emits standard byte-preserving patch and no-change output; CLI stdout is patch only',async()=>{
 const f=await saved();try{
  const child=spawnSync(process.execPath,['src/artifact-diff-cli.mjs','--state-root',f.host.stateRoot,'--run-id',f.report.runID],{cwd,encoding:'buffer',timeout:10000});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr?.toString());assert.match(child.stdout.toString(),/^diff --git a\/note.txt b\/note.txt\n/);assert.equal(JSON.parse(child.stderr).changedFiles,1);
  assert.equal(child.stdout.toString(),expectedPatch('note.txt','old\n','new\n'));
  const table={'nested/space \"quote\" 中文.txt':['\uFEFFold\r\n','\uFEFFnew\r\n'],'eof.txt':['old','new\n'],'empty.txt':['','filled'],'erase.txt':['old\n','']};
  const bytes=await saved(table),empty=await saved({'note.txt':['same\n','same\n']});
  try{
    const {exportArtifactDiff}=await import('../src/artifact-diff.mjs');let scratch;
    const before=await treeDigest(f.root);
    const result=await exportArtifactDiff({stateRoot:bytes.host.stateRoot,runID:bytes.report.runID},{spawnGit:(file,args,options)=>{scratch=options.cwd;return spawn(file,args,options);}});
    const text=result.patch.toString();assert.ok(text.includes('\\ No newline at end of file'));assert.ok(result.patch.includes(Buffer.from('\uFEFFnew\r\n')));assert.ok(!text.includes(scratch)&&!text.includes('a/a/')&&!text.includes('b/b/'));
    const target=join(bytes.root,'apply-check');await mkdir(target);
    for(const[path,[content]]of Object.entries(table)){await mkdir(dirname(join(target,path)),{recursive:true});await writeFile(join(target,path),content);}
    const checked=spawnSync('/usr/bin/git',['apply','--check','--whitespace=nowarn','-'],{cwd:target,input:result.patch,env:{PATH:'/usr/bin:/bin',LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
    assert.equal(checked.error,undefined);assert.equal(checked.status,0,checked.stderr?.toString());
    for(const[path,[content]]of Object.entries(table))assert.deepEqual(await readFile(join(target,path)),Buffer.from(content));
    await assert.rejects(lstat(scratch),{code:'ENOENT'});
    const noChange=await exportArtifactDiff({stateRoot:empty.host.stateRoot,runID:empty.report.runID});assert.equal(noChange.patch.length,0);assert.equal(noChange.receipt.changedFiles,0);
    assert.equal(await treeDigest(f.root),before);
  }finally{await bytes.cleanup();await empty.cleanup();}

 }finally{await f.cleanup();}
});
test('incomplete, unauthorised or mismatching saved artifacts reject before backend with empty CLI stdout',async()=>{
 const f=await saved({'one.txt':['one\n','changed\n'],'two.txt':['two\n','changed too\n']}),{exportArtifactDiff}=await import('../src/artifact-diff.mjs');let called=0;
 const spawnGit=()=>{called++;throw new Error('backend must not run');};
 try{
  const report=structuredClone(f.report),meta=JSON.parse(await readFile(join(report.runDir,'metadata.json'),'utf8')),ledger=(await readFile(join(report.runDir,'ledger.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const persist=async(r,m,events)=>{let previous=null;for(let index=0;index<events.length;index++){const e=events[index];if(e.type==='start')e.data.metadataHash=digest(m);if(e.type==='outcome'){e.data.status=r.status;e.data.reportHash=digest(r);}e.seq=index;e.previousHash=previous;const{hash:ignored,...body}=e;e.hash=digest(body);previous=e.hash;}await writeFile(join(report.runDir,'metadata.json'),JSON.stringify(m));await writeFile(join(report.runDir,'report.json'),JSON.stringify(r));await writeFile(join(report.runDir,'ledger.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');};
  const cases=[
    r=>r.artifacts.pop(),r=>r.artifacts.push(r.artifacts[0]),r=>r.artifacts.reverse(),r=>r.artifacts[0].content='forged',r=>r.artifacts[0].afterHash='0'.repeat(64),r=>r.artifacts[0].extra=true,
    r=>r.artifacts[0].path='../escape.txt',r=>r.initialManifestHash='0'.repeat(64),r=>r.integrationAccepted=false,
    (r,m)=>m.allowedPaths=[],(r,m)=>m.initialManifest.hash='0'.repeat(64),
    ...['failed','cancelled','unknown'].map(status=>r=>{r.status=status;r.integrationAccepted=false;}),
    (r,m,e)=>e.splice(e.findIndex(event=>event.type==='outcome'),1)
  ];
  for(const change of cases){const r=structuredClone(report),m=structuredClone(meta),e=structuredClone(ledger);change(r,m,e);await persist(r,m,e);await assert.rejects(exportArtifactDiff({stateRoot:f.host.stateRoot,runID:r.runID},{spawnGit}));}
  const bad=spawnSync(process.execPath,['src/artifact-diff-cli.mjs','--state-root',f.host.stateRoot,'--run-id',report.runID],{cwd,encoding:'buffer'});assert.equal(bad.status,1);assert.equal(bad.stdout.length,0);assert.equal(JSON.parse(bad.stderr).status,'rejected');
  await persist(report,meta,ledger);
  const path=join(report.runDir,'initial','one.txt');await unlink(path);await link(join(f.host.sourceDir,'one.txt'),path);await assert.rejects(exportArtifactDiff({stateRoot:f.host.stateRoot,runID:report.runID},{spawnGit}),/HARDLINK/);await unlink(path);await symlink(join(f.host.sourceDir,'one.txt'),path);await assert.rejects(exportArtifactDiff({stateRoot:f.host.stateRoot,runID:report.runID},{spawnGit}),/SYMLINK/);
  assert.equal(called,0);
  const gitPath=await saved({'.git/entry.txt':['old\n','new\n']});try{await assert.rejects(exportArtifactDiff({stateRoot:gitPath.host.stateRoot,runID:gitPath.report.runID},{spawnGit}),/METADATA_PATH/);}finally{await gitPath.cleanup();}
  assert.equal(called,0);
 }finally{await f.cleanup();}
});
function fakeProcess({code=1,signal=null,stdout=expectedPatch('note.txt','old\n','new\n'),stderr='',error,delay=0,exitOnly=false}={}){
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
 queueMicrotask(()=>{if(error)child.emit('error',Object.assign(new Error('synthetic'),{code:error}));child.stdout.write(stdout);child.stderr.write(stderr);child.emit('exit',code,signal);if(!exitOnly)setTimeout(()=>{child.stdout.end();child.stderr.end();child.emit('close',code,signal);},delay);});return child;
}
test('backend fixed argv/environment, result bounds and true close govern output and owned scratch cleanup',async()=>{
 const f=await saved(),empty=await saved({'note.txt':['same\n','same\n']}),{exportArtifactDiff}=await import('../src/artifact-diff.mjs');
 try{
  const original=await treeDigest(f.root),old=process.env.GIT_EXTERNAL_DIFF;process.env.GIT_EXTERNAL_DIFF='/synthetic-must-not-inherit';
  try{
   let scratch;
   const good=await exportArtifactDiff({stateRoot:f.host.stateRoot,runID:f.report.runID},{spawnGit:(file,args,options)=>{
    assert.equal(file,'/usr/bin/git');assert.deepEqual(args,['--no-pager','-c','core.quotePath=true','-c','core.attributesFile=/dev/null','-c','core.autocrlf=false','diff','--no-index','--no-ext-diff','--no-textconv','--no-renames','--no-color','--text','--unified=3','--no-prefix','--diff-algorithm=myers','--no-indent-heuristic','--full-index','--','a','b']);
    assert.equal(options.env.GIT_EXTERNAL_DIFF,undefined);assert.equal(options.env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(options.env.GIT_ATTR_NOSYSTEM,'1');assert.deepEqual(Object.keys(options.env).sort(),['GIT_ATTR_NOSYSTEM','GIT_CEILING_DIRECTORIES','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_SYSTEM','GIT_OPTIONAL_LOCKS','HOME','LANG','PATH']);assert.equal(options.detached,true);assert.deepEqual(options.stdio,['ignore','pipe','pipe']);scratch=options.cwd;return fakeProcess();
   }});assert.equal(good.patch.toString(),expectedPatch('note.txt','old\n','new\n'));await assert.rejects(lstat(scratch),{code:'ENOENT'});
  }finally{if(old===undefined)delete process.env.GIT_EXTERNAL_DIFF;else process.env.GIT_EXTERNAL_DIFF=old;}
  for(const [value,pattern]of [[{code:0,stdout:''},/RESULT_MISMATCH/],[{code:2,stdout:'partial'},/GIT_FAILED/],[{signal:'SIGKILL'},/GIT_FAILED/],[{error:'ENOENT',code:128},/SPAWN_FAILED/],[{stdout:Buffer.alloc(1048577)},/OUTPUT_LIMIT/],[{stderr:Buffer.alloc(8193)},/OUTPUT_LIMIT/],[{delay:2100},/TIMEOUT/]]){
   let scratch;await assert.rejects(exportArtifactDiff({stateRoot:f.host.stateRoot,runID:f.report.runID},{spawnGit:(file,args,options)=>{scratch=options.cwd;return fakeProcess(value);}}),pattern);await assert.rejects(lstat(scratch),{code:'ENOENT'});
  }
  const zero=await exportArtifactDiff({stateRoot:empty.host.stateRoot,runID:empty.report.runID},{spawnGit:()=>fakeProcess({code:0,stdout:''})});assert.equal(zero.patch.length,0);
  let hanging,scratch;await assert.rejects(exportArtifactDiff({stateRoot:f.host.stateRoot,runID:f.report.runID},{spawnGit:(file,args,options)=>{scratch=options.cwd;hanging=fakeProcess({exitOnly:true});return hanging;}}),/SETTLEMENT_UNKNOWN/);
  assert.equal((await lstat(scratch)).mode&0o777,0o700);hanging.stdout.end();hanging.stderr.end();hanging.emit('close',1,null);await rm(scratch,{recursive:true,force:true});
  assert.equal(await treeDigest(f.root),original);
 }finally{await f.cleanup();await empty.cleanup();}
});
