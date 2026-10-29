import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers/collaboration.mjs';
import { runCollaboration, reopenRun } from '../src/collaboration-runner.mjs';
const prefix = "import{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));";
const program = expression => prefix + `console.log(JSON.stringify(${expression}));\n`;
async function setup(content = program('input.a-input.b')) {
  const f = await fixture(); await writeFile(join(f.host.sourceDir,'entry.mjs'),content);
  Object.assign(f.host,{sourceFiles:['entry.mjs'],readPaths:['entry.mjs'],allowedPaths:['entry.mjs'],workerTimeoutMs:10000,hostNodeBinary:process.execPath});
  f.host.checks.final={kind:'node-json-cli',entryPath:'entry.mjs',cases:[{id:'positive',input:{a:2,b:3},expected:5},{id:'signed',input:{a:-4,b:7},expected:3},{id:'zero',input:{a:0,b:-6},expected:-6}]};
  f.plan.tasks=[{id:'fix',instruction:'Fix sum',dependsOn:[],requiredCapabilities:['edit','verify'],writePaths:['entry.mjs'],checkIds:['final']}];
  return f;
}
test('JSON CLI reproduces semantic bug, fixes all fixed cases and reopens without changing original source', async()=>{
  const f=await setup(); let baseline;
  try {
    const report=await runCollaboration({plan:f.plan,host:f.host,worker:async({tools})=>{
      baseline=await tools.dispatch({action:'check',args:{checkId:'final'}});
      assert.equal(baseline.code,'CHECK_VALUE_MISMATCH'); assert.equal(baseline.cases[0].process.exitCode,0);
      assert.equal(baseline.cases[0].comparison,false); assert.deepEqual(baseline.remainingCaseIds,['signed','zero']);
      const file=await tools.dispatch({action:'read',args:{path:'entry.mjs'}});
      await tools.dispatch({action:'edit',args:{path:'entry.mjs',expectedHash:file.hash,content:program('input.a+input.b')}});return{status:'completed'};
    }});
    assert.equal(report.status,'completed',JSON.stringify(report));
    const final=report.checks.at(-1); assert.equal(final.kind,'node-json-cli'); assert.equal(final.cases.length,3);
    assert.ok(final.cases.every(item=>item.comparison&&item.process.closed)); assert.equal(final.manifestHash,report.finalManifestHash);
    assert.equal(report.artifacts[0].content,program('input.a+input.b'));
    assert.equal(await readFile(join(f.host.sourceDir,'entry.mjs'),'utf8'),program('input.a-input.b'));
    assert.equal((await reopenRun({stateRoot:f.host.stateRoot,runID:report.runID})).status,'completed');
  } finally{await f.cleanup();}
});
test('host JSON CLI definitions reject unknown fields, invalid domain and scope before dispatch',async()=>{
  for(const mutate of [d=>d.extra=true,d=>d.entryPath='../escape.mjs',d=>d.entryPath='missing.mjs',d=>d.cases[0].expected=-0,d=>d.cases[0].input=1.5,d=>d.cases.push(d.cases[0]),d=>d.cases[0].oracle='model',d=>d.cases[0].expected='x'.repeat(8193)]){
    const f=await setup();let dispatched=false;try{mutate(f.host.checks.final);await assert.rejects(runCollaboration({plan:f.plan,host:f.host,worker:()=>{dispatched=true;return{status:'completed'};}}));assert.equal(dispatched,false);}finally{await f.cleanup();}
  }
  const f=await setup();try{await unlink(join(f.host.sourceDir,'entry.mjs'));await symlink('note.txt',join(f.host.sourceDir,'entry.mjs'));await assert.rejects(runCollaboration({plan:f.plan,host:f.host,worker:()=>assert.fail('worker dispatched')}),/SYMLINK/);}finally{await f.cleanup();}
});

import { bindJsonCliDefinition, runNodeJsonCliCheck, verifyJsonCliEvidence, verifyJsonCliDefinition } from '../src/json-cli-check.mjs';
import { snapshotContents, hash, digest } from '../src/workspace-tools.mjs';
async function adapter(content,{cases=[{id:'one',input:{a:2,b:3},expected:5}],caseTimeoutMs=500,timeoutMs=2000,maxOutputBytes=8192,signal}={}){
  const f=await setup(content);
  try{
    const definition=await bindJsonCliDefinition({kind:'node-json-cli',entryPath:'entry.mjs',cases,caseTimeoutMs,timeoutMs,maxOutputBytes},{sourceFiles:['entry.mjs'],readPaths:['entry.mjs']},process.execPath);
    const result=await runNodeJsonCliCheck({entryFile:join(f.host.sourceDir,'entry.mjs'),definition,sourceManifest:snapshotContents({'entry.mjs':content}).manifest,signal});
    return {result,definition};
  }finally{await f.cleanup();}
}
test('stdout is complete strict JSON observable data, never child success or test-event authority',async()=>{
  const cases=[
    ['', 'CHECK_JSON_INVALID'],["console.log('{\"passed\":true}');",'CHECK_VALUE_MISMATCH'],
    ["console.log('TAP version 13\\nok 1 - host-check');",'CHECK_JSON_INVALID'],
    ["process.stdout.write(Buffer.from([255,15,116,101,115,116]));",'CHECK_UTF8_INVALID'],
    ["process.stdout.write('{');",'CHECK_JSON_INVALID'],["console.log('5\\n5');",'CHECK_JSON_INVALID'],
    ["console.log('5\\ntrailing log');",'CHECK_JSON_INVALID'],["console.log('5');process.exitCode=1;",'CHECK_NONZERO_EXIT'],
    ["console.log('1.5');",'CHECK_JSON_DOMAIN'],["console.log('-0');",'CHECK_JSON_DOMAIN'],
    ["console.log('9007199254740992');",'CHECK_JSON_DOMAIN'],["console.log(JSON.stringify('x'.repeat(8193)));",'CHECK_OUTPUT_LIMIT']
  ];
  for(const [source,code]of cases){const {result}=await adapter(source);assert.equal(result.status,'failed',source);assert.equal(result.code,code,source);assert.equal(result.cases[0].process.closed,true);}
  const constant=await adapter('console.log(5)',{cases:[{id:'one',input:1,expected:5},{id:'two',input:2,expected:6}]});
  assert.equal(constant.result.cases[0].status,'passed');assert.equal(constant.result.code,'CHECK_VALUE_MISMATCH');
  const duplicate=await adapter("console.log(' {\"x\":1,\"x\":2}  ')",{cases:[{id:'duplicate',input:null,expected:{x:2}}]});assert.equal(duplicate.result.status,'passed');
});
test('timeout, retained output pipes, stdout/stderr floods and cancellation close before any next case',async()=>{
  const cases=[{id:'first',input:1,expected:5},{id:'never',input:2,expected:6}];
  for(const source of ["console.log(5);setInterval(()=>{},1000);", "import{spawn}from'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});console.log(5);setInterval(()=>{},1000);"]){
    const {result}=await adapter(source,{cases,caseTimeoutMs:150,timeoutMs:500});
    assert.equal(result.code,'CHECK_TIMEOUT_OR_TERMINATED');assert.equal(result.cases[0].process.closed,true);assert.equal(result.cases.length,1);assert.deepEqual(result.remainingCaseIds,['never']);
  }
  for(const stream of ['stdout','stderr']){const {result}=await adapter(`setInterval(()=>process.${stream}.write('x'.repeat(65536)),1)`,{cases,maxOutputBytes:256});assert.equal(result.code,'CHECK_OUTPUT_LIMIT');assert.equal(result.cases.length,1);assert.ok(Buffer.from(result.cases[0].stdoutBase64,'base64').length+Buffer.from(result.cases[0].stderrBase64,'base64').length<=256);assert.equal(result.cases[0].process.closed,true);}
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150);
  try{const {result}=await adapter('console.log(5);setInterval(()=>{},1000)',{cases,signal:controller.signal});assert.equal(result.code,'CHECK_CANCELLED');assert.ok(result.cases.every(item=>item.process.closed));assert.ok(result.remainingCaseIds.includes('never'));}finally{clearTimeout(timer);}
});
test('isolated entry is readonly and host oracle plus other source files are absent',async()=>{
  const source="import{writeFileSync,readFileSync,readdirSync}from'node:fs';let ro=false,absent=false,other=false;try{writeFileSync('/workspace/entry.mjs','bad')}catch(e){ro=e.code==='EROFS'}try{readFileSync('/input/snapshot.json')}catch(e){absent=e.code==='ENOENT'}try{readFileSync('/workspace/note.txt')}catch(e){other=e.code==='ENOENT'}console.log(JSON.stringify({ro,absent,other,files:readdirSync('/workspace')}))";
  const {result}=await adapter(source,{cases:[{id:'scope',input:{},expected:{ro:true,absent:true,other:true,files:['entry.mjs']}}]});assert.equal(result.status,'passed',JSON.stringify(result));
});
test('semantic reopen verifier rejects fabricated passed flags, missing cases and source/definition/protocol/runtime changes',async()=>{
  const {result,definition}=await adapter('console.log(5)',{cases:[{id:'first',input:1,expected:5},{id:'second',input:2,expected:5}]});
  assert.equal(verifyJsonCliEvidence(result,definition),true);
  for(const mutate of [r=>{r.cases.pop();r.remainingCaseIds=['second'];},r=>{r.cases[0].stdoutBase64=Buffer.from('0\n').toString('base64');r.cases[0].stdoutHash=hash('0\n');},r=>r.entryHash='0'.repeat(64),r=>r.definitionHash='0'.repeat(64),r=>r.protocol.version++,r=>r.runtime.hash='0'.repeat(64),r=>r.cases[0].process.closed=false]){const changed=structuredClone(result);mutate(changed);assert.throws(()=>verifyJsonCliEvidence(changed,definition));}
  const changed=structuredClone(definition);changed.cases[0].expected=0;await assert.rejects(verifyJsonCliDefinition(changed),/DEFINITION/);
});
test('host oracle is copied before worker mutation and saved entry tampering cannot reopen accepted',async()=>{
  const f=await setup(program('input.a+input.b'));try{
    const report=await runCollaboration({plan:f.plan,host:f.host,worker:()=>{f.host.checks.final.cases[0].expected=0;return{status:'completed'};}});
    assert.equal(report.status,'completed');const check=report.checks.at(-1);
    assert.equal((await reopenRun({stateRoot:f.host.stateRoot,runID:report.runID})).status,'completed');
    await writeFile(join(report.runDir,'checks',check.entryFile),'console.log(0)');
    await assert.rejects(reopenRun({stateRoot:f.host.stateRoot,runID:report.runID}),/CHECK_ENTRY_MISMATCH/);
  }finally{await f.cleanup();}
});
test('readonly reopen recomputes semantics even when report and ledger hashes are consistently rewritten',async()=>{
  const f=await setup(program('input.a+input.b'));try{
    const report=await runCollaboration({plan:f.plan,host:f.host,worker:async()=>({status:'completed'})});assert.equal(report.status,'completed');
    const original=JSON.parse(await readFile(join(report.runDir,'ledger.jsonl'),'utf8').then(text=>'['+text.trim().split('\n').join(',')+']'));
    for(const mutate of [r=>{r.checks[0].cases[0].stdoutBase64=Buffer.from('0\n').toString('base64');r.checks[0].cases[0].stdoutHash=hash('0\n');},r=>{r.checks[0].cases.pop();r.checks[0].remainingCaseIds=['zero'];},r=>r.checks[0].protocol.version++]){
      const changed=structuredClone(report);mutate(changed);const events=structuredClone(original);let previousHash=null;
      for(const event of events){
        if(event.type==='completed'&&event.data.evidence){event.data.evidence=changed.checks[0];event.data.resultHash=digest(changed.checks[0]);}
        if(event.type==='outcome')event.data.reportHash=digest(changed);
        event.previousHash=previousHash;const {hash:ignored,...body}=event;event.hash=digest(body);previousHash=event.hash;
      }
      await writeFile(join(report.runDir,'report.json'),JSON.stringify(changed));await writeFile(join(report.runDir,'ledger.jsonl'),events.map(event=>JSON.stringify(event)).join('\n')+'\n');
      await assert.rejects(reopenRun({stateRoot:f.host.stateRoot,runID:report.runID}),/CHECK_COMPARISON_MISMATCH|CHECK_EVIDENCE_MISMATCH/);
    }
  }finally{await f.cleanup();}
});
