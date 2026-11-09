import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgyWorker, AGY_SETTINGS } from '../src/agy-worker.mjs';

async function fake(body){
  const base=await mkdtemp('/tmp/calcifer-agy-test-'),directory=join(base,'workspace'),evidenceDir=join(base,'evidence');
  await mkdir(directory);await mkdir(evidenceDir);
  const executable=join(base,'agy.mjs');
  await writeFile(executable,"#!/usr/bin/node\nif(process.argv.includes('--version')){console.log('fixture');process.exit(0)}\n"+body,{mode:0o700});
  return {directory,evidenceDir,executable,model:'gemini-4-argon-medium',expectedVersion:'fixture',prompt:'fixture only',timeoutMs:1500};
}
test('agy adapter retains UTF-8 across chunks and pins credits and tool permissions',async()=>{
  const r=await fake(`
    let input='';for await(const chunk of process.stdin)input+=chunk;
    const args=process.argv.slice(2), settings=JSON.parse(args[args.indexOf('--settings')+1]);
    if(settings.useG1Credits!==false||!settings.permissions.deny.includes('command(*)')||args.includes('--dangerously-skip-permissions'))process.exit(3);
    const text=JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',response:'襯材'}})+'\\n';
    const bytes=Buffer.from(text), offset=bytes.indexOf(Buffer.from('襯'))+1;
    process.stdout.write(bytes.subarray(0,offset));await new Promise(r=>setTimeout(r,40));process.stdout.write(bytes.subarray(offset));
  `);
  const result=await runAgyWorker(r);assert.equal(result.response,'襯材');assert.equal(result.process.closed,true);
  assert.equal(JSON.parse(await readFile(join(r.evidenceDir,'process.json'),'utf8')).exitCode,0);
});
test('agy exit zero without terminal result is UNKNOWN, not accepted',async()=>{
  const r=await fake("process.stdout.write(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000001',init:{}})+'\\n');");
  await assert.rejects(runAgyWorker(r),/AGY_RESULT_UNKNOWN/);
  assert.equal(JSON.parse(await readFile(join(r.evidenceDir,'session.json'),'utf8')).conversationId,'00000000-0000-4000-8000-000000000001');
});
test('agy deadline closes local process but leaves remote outcome unknown',async()=>{
  const r=await fake('setTimeout(()=>{},10000);');r.timeoutMs=1000;
  await assert.rejects(runAgyWorker(r),/AGY_RESULT_UNKNOWN/);
  const p=JSON.parse(await readFile(join(r.evidenceDir,'process.json'),'utf8'));assert.equal(p.timedOut,true);assert.equal(p.closed,true);
});
test('missing CLI and pre-send cancellation are proven unsent',async()=>{
 const r=await fake('');r.executable='/tmp/calcifer-no-such-agy';await assert.rejects(runAgyWorker(r),e=>e.dispatched===false&&e.code==='ENOENT');
 const valid=await fake('');const stop=new AbortController();stop.abort();await assert.rejects(runAgyWorker({...valid,signal:stop.signal}),e=>e.dispatched===false&&e.message==='AGY_CANCELLED_BEFORE_SEND');
});
test('agy generic agent and writable roots are passed explicitly without Thor permissions',async()=>{
 const r=await fake(`let input='';for await(const c of process.stdin)input+=c;
 const args=process.argv.slice(2),settings=JSON.parse(args[args.indexOf('--settings')+1]);
 if(args[args.indexOf('--agent')+1]!=='calcifer-worker'||settings.permissions.allow.some(x=>/erasebot|tools|docs/.test(x)))process.exit(4);
 console.log(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000001',init:{model:'gemini-4-argon-medium',agent:'calcifer-worker'}}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',response:'generic fixture'}}));`);
 const result=await runAgyWorker({...r,fileTools:true,agentName:'calcifer-worker',writeRoots:['taskboard','checks']});assert.equal(result.actualModel,r.model);
});

test('agy selected worker pins independent model tier and effort in argv and receipts',async()=>{
 const {selectedWorker}=await import('../src/project-execution.mjs');
 const r=await fake(`let input='';for await(const c of process.stdin)input+=c;
 const args=process.argv.slice(2);if(args[args.indexOf('--model')+1]!=='gemini-4-argon-high'||args[args.indexOf('--effort')+1]!=='max')process.exit(8);
 console.log(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000001',init:{model:'gemini-4-argon-high'}}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',response:'fixture'}}));`);
 const result=await selectedWorker('agy',{...r,model:'gemini-4-argon-high',effort:'max'});
 assert.equal(result.requestedModel,'gemini-4-argon-high');assert.equal(result.requestedEffort,'max');assert.equal(result.actualEffort,null);
 for(const name of ['started.json','session.json','terminal.json']){const receipt=JSON.parse(await readFile(join(r.evidenceDir,name),'utf8'));assert.equal(receipt.requestedModel,'gemini-4-argon-high');assert.equal(receipt.requestedEffort,'max');}
});
test('agy rejects unsupported model and effort before any CLI invocation',async()=>{
 const r=await fake("throw Error('must not execute');");
 for(const options of [{model:'gemini-unknown'},{model:'gpt-6-astra'},{effort:'ultra'},{effort:null}])await assert.rejects(runAgyWorker({...r,...options}),error=>error.dispatched===false&&error.message==='AGY_PROFILE_INVALID');
});
test('agy observed model mismatch remains UNKNOWN without accepting a fallback',async()=>{
 const r=await fake(`for await(const c of process.stdin){}
 console.log(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000001',init:{model:'gemini-4-argon-low'}}));
 console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',response:'wrong model'}}));`);
 await assert.rejects(runAgyWorker(r),/AGY_RESULT_UNKNOWN/);
});


test('agy honors no deadline and explicit durations longer than twenty minutes',async()=>{
 for(const timeoutMs of [null,1500000]){
  const r=await fake(`for await(const c of process.stdin){}
    const args=process.argv.slice(2);if(args[args.indexOf('--print-timeout')+1]!==${JSON.stringify(timeoutMs===null?'0s':'1500s')})process.exit(8);
    await new Promise(r=>setTimeout(r,30));
    console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'00000000-0000-4000-8000-000000000001',response:'completed'}}));`);
  const result=await runAgyWorker({...r,timeoutMs});assert.equal(result.response,'completed');assert.equal(result.process.timedOut,false);
 }
});
test('agy can cancel without a deadline and still drains the local process',async()=>{
 const r=await fake(`for await(const c of process.stdin){}
 process.on('SIGTERM',()=>{});
 console.log(JSON.stringify({event:'init',conversation_id:'00000000-0000-4000-8000-000000000001',init:{}}));
 setInterval(()=>{},10000);`),controller=new AbortController();
 await assert.rejects(runAgyWorker({...r,timeoutMs:null,signal:controller.signal,onEvent:e=>{if(e.event==='init')controller.abort();}}),/AGY_RESULT_UNKNOWN/);
 const p=JSON.parse(await readFile(join(r.evidenceDir,'process.json'),'utf8'));assert.equal(p.closed,true);assert.equal(p.cancelled,true);assert.equal(p.timedOut,false);assert.equal(p.signal,'SIGKILL');
});
