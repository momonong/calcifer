import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { runCodexWorker, buildCodexArgs } from '../src/codex-worker.mjs';

const ID='00000000-0000-4000-8000-000000000001', OTHER='00000000-0000-4000-8000-000000000002';
async function fixture(body, preflight='') {
  const base=await mkdtemp('/tmp/calcifer-codex-test-'),directory=join(base,'workspace'),evidenceDir=join(base,'evidence');
  await mkdir(directory);await mkdir(join(directory,'taskboard'));await mkdir(evidenceDir);
  const executable=join(base,'codex.mjs');
  await writeFile(executable,`#!/usr/bin/node
import {readFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2);
${preflight}
if(args.includes('--version')){console.log('codex-cli 0.166.0-alpha.6');process.exit(0)}
if(args.includes('login')){console.log('Logged in using ChatGPT');process.exit(0)}
if(args.includes('sandbox'))process.exit(0);
let input='';for await(const chunk of process.stdin)input+=chunk;
${body}
`,{mode:0o700});
  return {directory,evidenceDir,executable,model:'gpt-6.1-sol',effort:'medium',expectedVersion:'0.166.0-alpha.6',prompt:'fixture only',timeoutMs:1500,writeRoots:['taskboard']};
}
const emit=event=>`console.log(${JSON.stringify(JSON.stringify(event))});`;
const start=emit({type:'thread.started',thread_id:ID})+emit({type:'turn.started'});
const done=emit({type:'item.completed',item:{id:'item_1',type:'agent_message',text:'已完成襯材'}})+emit({type:'turn.completed',usage:{input_tokens:12,cached_input_tokens:4,output_tokens:3}});
async function json(options,name){return JSON.parse(await readFile(join(options.evidenceDir,name),'utf8'));}
async function unknown(options,check=()=>{}) {
  await assert.rejects(runCodexWorker(options),error=>{assert.equal(error.dispatched,true);assert.equal(error.message,'CODEX_RESULT_UNKNOWN');assert.equal(error.receipt.process.closed,true);check(error.receipt);return true;});
  await assert.rejects(access(join(options.evidenceDir,'terminal.json')));
}

test('Codex uses stdin after durable dispatch, retains native identity and distinguishes requested model',async()=>{
  const r=await fixture(`
    if(input!=='fixture only'||!existsSync(${JSON.stringify('/tmp')})||process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY)process.exit(5);
    const d=readFileSync(args[args.indexOf('-C')+1]+'/../evidence/dispatch.json','utf8');
    if(JSON.parse(d).state!=='sending-or-unknown')process.exit(6);
    ${start}
    const bytes=Buffer.from(${JSON.stringify(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'agent_message',text:'已完成襯材'}})+'\n')});
    const offset=bytes.indexOf(Buffer.from('襯'))+1;process.stdout.write(bytes.subarray(0,offset));
    await new Promise(r=>setTimeout(r,20));process.stdout.write(bytes.subarray(offset));
    ${emit({type:'turn.completed',usage:{input_tokens:12,output_tokens:3}})}
  `);
  const result=await runCodexWorker(r);
  assert.equal(result.response,'已完成襯材');assert.equal(result.conversation_id,ID);
  assert.equal(result.actualModel,null);assert.equal(result.requestedModel,'gpt-6.1-sol');
  assert.equal(result.process.exitCode,0);assert.equal(result.usage.input_tokens,12);
  assert.equal((await json(r,'session.json')).init.model,null);
  assert.deepEqual(await json(r,'terminal.json'),result);
});
test('Codex resumes only explicit UUID and preserves requested identity',async()=>{
  const r=await fixture(`if(args.indexOf(${JSON.stringify(ID)})<args.indexOf('resume')||args.at(-2)!==${JSON.stringify(ID)}||args.at(-1)!=='-'||args.includes('--last'))process.exit(8);${start}${done}`);
  r.conversationId=ID;assert.equal((await runCodexWorker(r)).conversation_id,ID);
});
test('Codex builder restricts roots, authentication, tools and retry settings without sandbox override',()=>{
  const args=buildCodexArgs({directory:'/tmp/project',model:'gpt-6.1-sol',effort:'medium',writeRoots:['taskboard','checks'],conversationId:ID});
  const cfg=args.filter((_,i)=>args[i-1]==='-c').join('\n');
  for(const forbidden of ['--sandbox','--add-dir','--last','--ignore-rules','--dangerously-bypass-approvals-and-sandbox'])assert.equal(args.includes(forbidden),false);
  assert.equal(args.includes('--ignore-user-config'),true);
  assert.match(cfg,/default_permissions="calcifer"/);assert.match(cfg,/":root" = "deny"/);
  assert.match(cfg,/"workspace_roots" = \{ "\/tmp\/project" = true \}/);
  assert.match(cfg,/":minimal" = "read"/);assert.match(cfg,/"\." = "read"/);
  assert.match(cfg,/"taskboard" = "write"/);assert.match(cfg,/"AGENTS.md" = "read"/);
  assert.match(cfg,/"enabled" = false/);assert.match(cfg,/web_search="disabled"/);
  assert.match(cfg,/forced_login_method="chatgpt"/);assert.match(cfg,/approval_policy="never"/);
  assert.match(cfg,/model_reasoning_effort="medium"/);
  assert.match(cfg,/shell_environment_policy.set.PATH="\/usr\/bin:\/bin"/);
  assert.match(cfg,/features.multi_agent=false/);assert.match(cfg,/features.apps=false/);
  // This CLI rejects any override of the built-in openai provider; no custom provider is substituted.
  assert.doesNotMatch(cfg,/model_providers\./);
  for(const roots of [['..'],['.'],['.codex'],['taskboard/../outside'],['/tmp/elsewhere'],['taskboard/.git']])
    assert.throws(()=>buildCodexArgs({directory:'/tmp/project',model:'gpt-6.1-sol',writeRoots:roots}),/CODEX_/);
});
for(const [name,body] of [
  ['missing terminal',start],['turn started only',emit({type:'turn.started'})],
  ['turn failed',start+emit({type:'turn.failed',error:{message:'provider error'}})],
  ['native error',start+done+emit({type:'error',message:'late error'})],
  ['partial JSON',start+`process.stdout.write('{"type":');`],
  ['invalid event',start+`console.log('not json');`],
  ['wrong thread',emit({type:'thread.started',thread_id:OTHER})+done],
  ['missing thread',done],['duplicate completion',start+done+done],
  ['nonzero exit',start+done+'process.exitCode=3;'],
])test(`Codex ${name} remains UNKNOWN with closed process receipt`,async()=>{
  const r=await fixture(body);if(name==='wrong thread')r.conversationId=ID;await unknown(r);
});
test('Codex timeout settles local child and retains unknown remote status',async()=>{
  const r=await fixture(start+'setTimeout(()=>{},10000);');r.timeoutMs=1000;
  await unknown(r,receipt=>{assert.equal(receipt.process.timedOut,true);assert.equal(receipt.conversationId,ID);});
});
test('Codex cancellation without a deadline drains child and preserves known thread',async()=>{
  const r=await fixture(start+'setTimeout(()=>{},10000);'),controller=new AbortController();
  await unknown({...r,timeoutMs:null,signal:controller.signal,onEvent:event=>{if(event.type==='thread.started')controller.abort();}},receipt=>assert.equal(receipt.process.cancelled,true));
});
test('Codex bounded stdout and stderr produce UNKNOWN without persisting raw stderr',async()=>{
  for(const body of [start+`process.stdout.write('x'.repeat(2097153));`,start+`process.stderr.write('secret'.repeat(6000));`]){
    const r=await fixture(body);await unknown(r,receipt=>assert.equal(receipt.process.overflow,true));
    assert.doesNotMatch(await readFile(join(r.evidenceDir,'process.json'),'utf8'),/secret/);
  }
});
test('Codex preflight errors and pre-send cancellation are proven unsent',async()=>{
  const cases=[
    ['version mismatch',`if(args.includes('--version')){console.log('codex-cli 0.0.0');process.exit(0);}`],
    ['API login',`if(args.includes('login')){console.log('Logged in using an API key');process.exit(0);}`],
    ['unsafe config',`if(args.includes('sandbox'))process.exit(9);`],
  ];
  for(const [name,preflight]of cases){const r=await fixture(`throw Error('must not dispatch');`,preflight);await assert.rejects(runCodexWorker(r),e=>e.dispatched===false,name);await assert.rejects(access(join(r.evidenceDir,'dispatch.json')));}
  const r=await fixture('');const c=new AbortController();c.abort();await assert.rejects(runCodexWorker({...r,signal:c.signal}),e=>e.dispatched===false);
  await assert.rejects(runCodexWorker({...r,executable:'/tmp/no-such-codex-calcifer'}),e=>e.dispatched===false);
});
test('Codex accepts ChatGPT auth status on native stderr without persisting its raw text',async()=>{
  const r=await fixture(start+done,`if(args.includes('login')){console.error('WARNING: harmless fixture');console.error('Logged in using ChatGPT');process.exit(0);}`);
  assert.equal((await runCodexWorker(r)).status,'SUCCESS');
  assert.doesNotMatch(await readFile(join(r.evidenceDir,'started.json'),'utf8'),/harmless fixture/);
});
test('Codex preflight consumes the same total deadline and never dispatches after expiry',async()=>{
  const r=await fixture(start+done,`if(args.includes('--version'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1100);`);
  r.timeoutMs=1000;const began=Date.now();
  await assert.rejects(runCodexWorker(r),error=>error.dispatched===false);
  assert.ok(Date.now()-began<1600);await assert.rejects(access(join(r.evidenceDir,'dispatch.json')));
});
test('Codex cancellation kills and drains the process group including descendants',async()=>{
  const r=await fixture(`
    process.on('SIGTERM',()=>{});
    const {spawn}=await import('node:child_process');
    spawn('/usr/bin/node',['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"],{stdio:['ignore','inherit','inherit']});
    await new Promise(r=>setTimeout(r,100));${start}setInterval(()=>{},10000);
  `),controller=new AbortController();
  await unknown({...r,timeoutMs:3000,signal:controller.signal,onEvent:event=>{if(event.type==='thread.started')controller.abort();}},receipt=>assert.equal(receipt.process.signal,'SIGKILL'));
});
test('Codex child environment excludes API keys and unrelated parent variables',async()=>{
  const names=['OPENAI_API_KEY','CODEX_API_KEY','CALCIFER_PRIVATE_SENTINEL'],before=names.map(name=>process.env[name]);
  try{
    for(const name of names)process.env[name]='fixture-no-secret';
    const r=await fixture(`if(process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.CALCIFER_PRIVATE_SENTINEL)process.exit(7);${start}${done}`);
    assert.equal((await runCodexWorker(r)).status,'SUCCESS');
  }finally{names.forEach((name,index)=>{if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];});}
});
test('Codex pins immutable inputs inside write roots to read-only and rejects noncanonical input paths',()=>{
  const options={directory:'/tmp/project',model:'gpt-6.1-sol',writeRoots:['taskboard'],readOnlyPaths:['README.md','taskboard/input.json','taskboard/deep/AGENTS.md']};
  const args=buildCodexArgs(options),cfg=args.filter((_,i)=>args[i-1]==='-c').join('\n');
  assert.match(cfg,/"taskboard" = "write"/);
  for(const path of ['README.md','taskboard/input.json','taskboard/deep/AGENTS.md'])assert.ok(cfg.includes(JSON.stringify(path)+' = "read"'));
  for(const paths of [['../outside'],['/tmp/outside'],['taskboard/./input.json'],['taskboard//input.json'],['taskboard\\input.json'],['taskboard/input.json','taskboard/input.json'],null])
    assert.throws(()=>buildCodexArgs({...options,readOnlyPaths:paths}),/CODEX_READ_ONLY_PATHS_INVALID/);
});

test('Codex selected worker pins configured model and effort in argv and durable receipts',async()=>{
 const {selectedWorker}=await import('../src/project-execution.mjs');
 const r=await fixture(`if(args[args.indexOf('--model')+1]!=='gpt-6.1-terra'||!args.includes('model_reasoning_effort="max"'))process.exit(9);${start}${done}`);
 const result=await selectedWorker('codex',{...r,model:'gpt-6.1-terra',effort:'max'});
 assert.equal(result.requestedModel,'gpt-6.1-terra');assert.equal(result.requestedEffort,'max');assert.equal(result.actualModel,null);assert.equal(result.actualEffort,null);
 for(const name of ['started.json','session.json','terminal.json']){const receipt=await json(r,name);assert.equal(receipt.requestedModel,'gpt-6.1-terra');assert.equal(receipt.requestedEffort,'max');}
});
test('Codex omitted profile selects Astra high and rejects unknown choices before execution',async()=>{
 const r=await fixture(`if(args[args.indexOf('--model')+1]!=='gpt-6-astra'||!args.includes('model_reasoning_effort="high"'))process.exit(9);${start}${done}`);
 delete r.model;delete r.effort;const result=await runCodexWorker(r);assert.equal(result.requestedModel,'gpt-6-astra');assert.equal(result.requestedEffort,'high');
 for(const options of [{model:'gpt-unknown'},{effort:'ultra'},{effort:null}])await assert.rejects(runCodexWorker({...r,...options}),error=>error.dispatched===false&&/CODEX_(MODEL|EFFORT)_INVALID/.test(error.message));
});


test('Codex honors no deadline and explicit durations longer than twenty minutes',async()=>{
 for(const timeoutMs of [null,1500000]){
  const r=await fixture(start+`await new Promise(r=>setTimeout(r,30));`+done);
  const result=await runCodexWorker({...r,timeoutMs});assert.equal(result.status,'SUCCESS');assert.equal(result.process.timedOut,false);
 }
});
