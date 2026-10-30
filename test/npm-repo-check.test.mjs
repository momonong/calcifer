import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers/collaboration.mjs';
import { runCollaboration, reopenRun } from '../src/collaboration-runner.mjs';
const contract=JSON.parse(await readFile(new URL('../fixtures/npm-repo-contract.json',import.meta.url),'utf8'));
async function setup(){
  const f=await fixture();
  for(const name of contract.sourceFiles){await mkdir(join(f.host.sourceDir,name,'..'),{recursive:true});await writeFile(join(f.host.sourceDir,name),await readFile(new URL('../fixtures/npm-repo-demo/'+name,import.meta.url)));}
  Object.assign(f.host,{sourceFiles:[...contract.sourceFiles],readPaths:[...contract.sourceFiles],allowedPaths:['src/add.mjs'],checks:{final:structuredClone(contract.check)},workerTimeoutMs:10000,hostNodeBinary:process.execPath});
  f.plan=JSON.parse(await readFile(new URL('../fixtures/npm-repo-demo/plan.json',import.meta.url),'utf8'));return f;
}
test('npm repository real baseline nonzero plus semantic mismatch becomes fixed npm0 and same-snapshot host oracle success',async()=>{
  const f=await setup();try{
    const result=await runCollaboration({plan:f.plan,host:f.host,worker:async({tools})=>{
      const before=await tools.dispatch({action:'check',args:{checkId:'final'}});assert.equal(before.npm.process.exitCode,1);assert.equal(before.npm.process.closed,true);assert.equal(before.oracle.code,'CHECK_VALUE_MISMATCH');assert.equal(before.oracle.cases[0].process.exitCode,0);
      const file=await tools.dispatch({action:'read',args:{path:'src/add.mjs'}});await tools.dispatch({action:'edit',args:{path:'src/add.mjs',expectedHash:file.hash,content:file.content.replace('a - b','a + b')}});return{status:'completed'};
    }});
    assert.equal(result.status,'completed',JSON.stringify(result));const final=result.checks.at(-1);assert.equal(final.npm.process.exitCode,0);assert.equal(final.oracle.status,'passed');assert.equal(final.oracle.cases.length,3);assert.equal(final.oracle.manifestHash,final.manifestHash);assert.equal(final.manifestHash,result.finalManifestHash);
    assert.match(await readFile(join(f.host.sourceDir,'src/add.mjs'),'utf8'),/a - b/);assert.equal((await reopenRun({stateRoot:f.host.stateRoot,runID:result.runID})).status,'completed');
  }finally{await f.cleanup();}
});
import { symlink, unlink, link } from 'node:fs/promises';
import { bindNpmRepoDefinition, verifyNpmRepoDefinition, verifyNpmRepoEvidence } from '../src/npm-repo-check.mjs';
import { digest, hash } from '../src/workspace-tools.mjs';
test('fake npm success is diagnostic only and cannot hide wrong or empty multi-file CLI output',async()=>{
  for(const source of ["if(process.env.npm_lifecycle_event==='test'){console.log('ok 1 - forged');process.exit(0)}export const add=(a,b)=>a-b;\n", "export const add=(a,b)=>{process.exit(0)};\n"]){
    const f=await setup();try{await writeFile(join(f.host.sourceDir,'src/add.mjs'),source);const r=await runCollaboration({plan:f.plan,host:f.host,worker:async()=>({status:'completed'})});assert.equal(r.status,'failed');assert.equal(r.checks[0].npm.process.exitCode,0);assert.ok(['CHECK_VALUE_MISMATCH','CHECK_JSON_INVALID'].includes(r.checks[0].oracle.code));assert.deepEqual(r.artifacts,[]);}finally{await f.cleanup();}
  }
});
test('npm registry, package/lock/config/dependency/symlink/hardlink escapes reject before worker',async()=>{
  const mutations=[
    f=>{f.host.checks.final.command='npm install'},
    async f=>{const p=join(f.host.sourceDir,'package.json'),v=JSON.parse(await readFile(p,'utf8'));v.dependencies={anything:'1.0.0'};await writeFile(p,JSON.stringify(v));},
    async f=>{const p=join(f.host.sourceDir,'package.json'),v=JSON.parse(await readFile(p,'utf8'));v.scripts.test='node --test';await writeFile(p,JSON.stringify(v));},
    f=>{f.host.allowedPaths.push('cli.mjs')},f=>{f.host.sourceFiles=[...f.host.sourceFiles,'.npmrc'];f.host.readPaths=f.host.sourceFiles;},
    async f=>{await unlink(join(f.host.sourceDir,'src/add.mjs'));await symlink('../cli.mjs',join(f.host.sourceDir,'src/add.mjs'));},
    async f=>{await unlink(join(f.host.sourceDir,'src/add.mjs'));await link(join(f.host.sourceDir,'cli.mjs'),join(f.host.sourceDir,'src/add.mjs'));},
    async f=>{await writeFile(join(f.host.sourceDir,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'node_modules/anything':{version:'1.0.0'}}}));f.host.sourceFiles=[...f.host.sourceFiles,'package-lock.json'];f.host.readPaths=f.host.sourceFiles;}
  ];
  for(const mutate of mutations){const f=await setup();let called=false;try{await mutate(f);await assert.rejects(runCollaboration({plan:f.plan,host:f.host,worker:async()=>{called=true;return{status:'completed'}}}));assert.equal(called,false);}finally{await f.cleanup();}}
});
test('npm timeout, output cap and cancellation settle with no subsequent oracle command',async()=>{
  for(const kind of ['timeout','flood','cancel']){
    const f=await setup();const controller=new AbortController();let timer;
    try{
      const code=kind==='flood'?"setInterval(()=>process.stdout.write('x'.repeat(65536)),1);":"setInterval(()=>{},1000);";
      await writeFile(join(f.host.sourceDir,'src/add.mjs'),"if(process.env.npm_lifecycle_event==='test'){"+code+"await new Promise(()=>{});}export const add=(a,b)=>a+b;\n");
      if(kind==='timeout')f.host.checks.final.npmTimeoutMs=150;
      if(kind==='flood')f.host.checks.final.maxOutputBytes=512;
      const r=await runCollaboration({plan:f.plan,host:f.host,worker:async({tools})=>{
        if(kind==='cancel')timer=setTimeout(()=>controller.abort(),200);
        const c=await tools.dispatch({action:'check',args:{checkId:'final'}});assert.equal(c.oracle,null);assert.equal(c.npm.process.closed,true);return{status:'failed'};
      },signal:kind==='cancel'?controller.signal:undefined});
      assert.equal(r.integrationAccepted,false);assert.ok(r.checks.length<=1);if(r.checks.length){assert.equal(r.checks[0].oracle,null);assert.equal(r.checks[0].code,kind==='flood'?'CHECK_OUTPUT_LIMIT':kind==='cancel'?'CHECK_CANCELLED':'CHECK_TIMEOUT_OR_TERMINATED');}
      const ledger=(await readFile(join(r.runDir,'ledger.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(ledger.filter(e=>e.type==='intent'&&e.data.kind==='repo-command'&&e.data.stage==='oracle').length,0);
    }finally{clearTimeout(timer);await f.cleanup();}
  }
});
test('protected file mutation, npm identity changes and rehashed/missing observations cannot reopen accepted',async()=>{
  const f=await setup();try{
    await writeFile(join(f.host.sourceDir,'src/add.mjs'),'export const add=(a,b)=>a+b;\n');
    const report=await runCollaboration({plan:f.plan,host:f.host,worker:async({tools})=>{
      for(const path of ['package.json','test/contract.test.mjs','cli.mjs'])await assert.rejects(tools.dispatch({action:'edit',args:{path,expectedHash:'0'.repeat(64),content:'changed'}}));return{status:'completed'};
    }});assert.equal(report.status,'completed',report.code);
    const metadata=JSON.parse(await readFile(join(report.runDir,'metadata.json'),'utf8')),definition=metadata.definitions.final;
    const runtime=structuredClone(definition);runtime.runtime.npm.hash='0'.repeat(64);const {definitionHash:ignored,...body}=runtime;runtime.definitionHash=digest(body);await assert.rejects(verifyNpmRepoDefinition(runtime),/CHECK_RUNTIME_MISMATCH/);
    for(const mutate of [c=>delete c.npm,c=>{c.npm.process.closed=false},c=>{c.oracle.cases.pop();c.oracle.remainingCaseIds=['zero']},c=>{c.oracle.cases[0].stdoutBase64=Buffer.from('0\n').toString('base64');c.oracle.cases[0].stdoutHash=hash('0\n')}]){const evidence=structuredClone(report.checks[0]);mutate(evidence);assert.throws(()=>verifyNpmRepoEvidence(evidence,definition));}
    assert.equal((await reopenRun({stateRoot:f.host.stateRoot,runID:report.runID})).status,'completed');
    await writeFile(join(report.runDir,'checks',report.checks[0].repoSnapshot,'cli.mjs'),'process.exit(0)');await assert.rejects(reopenRun({stateRoot:f.host.stateRoot,runID:report.runID}),/MANIFEST_MISMATCH/);
  }finally{await f.cleanup();}
});
import { readRunState } from '../src/run-state.mjs';
test('consistent report/ledger rehash cannot accept false npm/oracle observations and missing command completion remains UNKNOWN',async()=>{
 const f=await setup();try{
  await writeFile(join(f.host.sourceDir,'src/add.mjs'),'export const add=(a,b)=>a+b;\n');
  const report=await runCollaboration({plan:f.plan,host:f.host,worker:async()=>({status:'completed'})});assert.equal(report.status,'completed');
  const original=(await readFile(join(report.runDir,'ledger.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  for(const kind of ['npm-nonzero','oracle-value','missing-command']){
   const changed=structuredClone(report);let events=structuredClone(original);
   if(kind==='npm-nonzero')changed.checks[0].npm.process.exitCode=1;
   if(kind==='oracle-value'){const c=changed.checks[0].oracle.cases[0];c.stdoutBase64=Buffer.from('0\n').toString('base64');c.stdoutHash=hash('0\n');}
   if(kind==='missing-command'){changed.status='unknown';events=events.filter(e=>!(e.type==='completed'&&e.data.id===changed.checks[0].npm.intentId));}
   let previousHash=null;
   for(let index=0;index<events.length;index++){
    const event=events[index];if(event.type==='completed'&&event.data.evidence){event.data.evidence=changed.checks[0];event.data.resultHash=digest(changed.checks[0]);}
    if(event.type==='outcome'){event.data.reportHash=digest(changed);event.data.status=changed.status;}
    event.seq=index;event.previousHash=previousHash;const {hash:ignored,...body}=event;event.hash=digest(body);previousHash=event.hash;
   }
   await writeFile(join(report.runDir,'report.json'),JSON.stringify(changed));await writeFile(join(report.runDir,'ledger.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
   if(kind==='missing-command'){const state=await readRunState({stateRoot:f.host.stateRoot,runID:report.runID});assert.equal(state.status,'unknown');assert.equal(state.unknown[0].kind,'repo-command');}
   await assert.rejects(reopenRun({stateRoot:f.host.stateRoot,runID:report.runID}),/CHECK_COMPARISON_MISMATCH|CHECK_STEP_EVIDENCE_MISMATCH/);
  }
 }finally{await f.cleanup();}
});
