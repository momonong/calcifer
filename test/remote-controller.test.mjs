import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openController} from '../src/remote-controller.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function until(fn){for(let i=0;i<200;i++){if(await fn())return;await sleep(10);}throw Error('condition did not settle');}
export async function fixture(t, overrides={}){
  const root=await mkdtemp('/tmp/calcifer-remote-controller-');
  const state={projectId:'project-one',projectName:'驗收專案',status:'ready',model:'fixture',backend:'fixture',maxTurns:2,turnsUsed:0,maxMinutes:null,profile:{sourceFiles:['tools/value.py'],writeRules:[]},execution:{backend:'fixture'},routing:null,lastTask:null};
  let calls=0;
  const api={projectStatus:async()=>structuredClone(state),workProject:async({task,operationId})=>{calls++;state.remoteCommandId=operationId;state.lastTask={id:operationId,status:'completed',task,response:'已完成'};return{status:'completed',response:'已完成'};},testProject:async()=>({status:'passed',checks:[]}),reconcileProject:async()=>structuredClone(state),authorizeProject:async({maxTurns})=>{state.maxTurns=maxTurns;return structuredClone(state);},...overrides};
  const options={stateDir:join(root,'remote'),projects:[{id:'sample',label:'驗收專案',stateDir:join(root,'project')}],api};
  const c=await openController(options);t.after(()=>c.close());return{c,options,state,root,calls:()=>calls};
}
const cmd=(action='work',input={task:'修正數值'})=>({id:randomUUID(),project:'sample',action,input});

test('duplicate acknowledgement and concurrent submits dispatch once and survive reopen',async t=>{
 const f=await fixture(t),input=cmd();const [a,b]=await Promise.all([f.c.submit(input),f.c.submit(input)]);
 assert.equal(a.id,b.id);await until(()=>f.c.command(input.id).status==='completed');assert.equal(f.calls(),1);
 const cursor=f.c.snapshot().cursor;await f.c.close();const reopened=await openController(f.options);t.after(()=>reopened.close());
 assert.equal((await reopened.submit(input)).status,'completed');assert.equal(f.calls(),1);assert.ok(reopened.snapshot().cursor>=cursor);
 await assert.rejects(reopened.submit({...input,input:{task:'different'}}),/COMMAND_CONFLICT/);
});
test('accepted work is not tied to subscribers; queued work never overlaps',async t=>{
 let release;const hold=new Promise(r=>release=r);let calls=0,concurrent=0,max=0;
 const f=await fixture(t,{workProject:async()=>{calls++;concurrent++;max=Math.max(max,concurrent);if(calls===1)await hold;concurrent--;return{status:'completed',response:'done'};}});
 const first=cmd(),second=cmd('work',{task:'next'});const off=f.c.subscribe(()=>{});await f.c.submit(first);off();
 await until(()=>calls===1);await f.c.submit(second);assert.equal(f.c.command(second.id).status,'queued');release();
 await until(()=>f.c.command(second.id).status==='completed');assert.equal(calls,2);assert.equal(max,1);
 assert.ok(f.c.events(0).events.some(e=>e.id===first.id));
});
test('cancel acknowledges a request without claiming remote inference stopped',async t=>{
 const f=await fixture(t,{workProject:async({signal})=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return{status:'unknown',cancellation:{userStoppedWaiting:true,localProcess:{closed:true},streamDrained:true,toolsStopped:'unknown',remoteInference:'unknown'}};}});
 const input=cmd();await f.c.submit(input);await until(()=>f.c.command(input.id).status==='running');
 await f.c.cancel(input.id);await until(()=>f.c.command(input.id).status==='unknown');
 assert.equal(f.c.command(input.id).result.cancellation.remoteInference,'unknown');
 await assert.rejects(f.c.submit(cmd()),/PROJECT_UNKNOWN/);
});
test('restart preserves uncertain operation and does not dispatch queued work',async t=>{
 const f=await fixture(t,{workProject:async()=>new Promise(()=>{})});const input=cmd();await f.c.submit(input);await until(()=>f.c.command(input.id).status==='running');
 await f.c.submit(cmd('work',{task:'later'}));await f.c.close({waitMs:5});
 const reopened=await openController(f.options);t.after(()=>reopened.close());
 assert.equal(reopened.command(input.id).status,'unknown');assert.equal((await reopened.submit(input)).status,'unknown');
 assert.equal(reopened.snapshot().commands.filter(c=>c.status==='queued').length,1);
});
test('reconcile only releases unknown fence with matching native operation identity',async t=>{
 const f=await fixture(t,{workProject:async()=>({status:'unknown'})});const input=cmd();await f.c.submit(input);await until(()=>f.c.command(input.id).status==='unknown');
 const r1=cmd('recover',{});await f.c.submit(r1);await until(()=>f.c.command(r1.id).status==='completed');
 assert.equal(f.c.command(input.id).status,'unknown');
 Object.assign(f.state,{remoteCommandId:input.id,status:'ready',pending:null,lastTask:{id:'native-1',remoteCommandId:input.id,status:'completed',response:'recovered'}});
 const r2=cmd('recover',{});await f.c.submit(r2);await until(()=>f.c.command(r2.id).status==='completed');
 assert.equal(f.c.command(input.id).status,'completed');assert.equal(f.c.command(input.id).recovered,true);
});
test('recovery never borrows a previous task and releases known failed or partial outcomes',async t=>{
 for(const scenario of ['previous','failed','partial']){
  const f=await fixture(t,{workProject:async()=>({status:'unknown'})}),c=cmd();await f.c.submit(c);await until(()=>f.c.command(c.id).status==='unknown');
  Object.assign(f.state,{status:'ready',pending:null,remoteCommandId:c.id,routing:scenario==='partial'?{}:null,goal:scenario==='partial'?{status:'working'}:null,lastTask:{id:'native',remoteCommandId:scenario==='previous'?randomUUID():c.id,status:scenario==='failed'?'failed':'completed',response:'native result'}});
  const recover=cmd('recover',{});await f.c.submit(recover);await until(()=>f.c.command(recover.id).status==='completed');
  assert.notEqual(f.c.command(c.id).status,'completed');
  if(scenario!=='previous'){assert.equal(f.c.command(c.id).status,'failed');assert.equal(f.c.command(c.id).recovered,true);}
 }
});
test('wrong project, arbitrary action and stale authorization scope never execute',async t=>{
 const f=await fixture(t);await assert.rejects(f.c.submit({...cmd(),project:'../../secret'}),/PROJECT_NOT_REGISTERED/);
 await assert.rejects(f.c.submit(cmd('shell',{command:'ls'})),/COMMAND_INVALID/);
 const s=f.c.snapshot().projects[0].status;
 const input=cmd('authorize',{maxTurns:2,maxMinutes:null,note:'explicit user authorization',scopeHash:s.scopeHash});
 f.state.execution={backend:'changed'};await f.c.submit(input);await until(()=>f.c.command(input.id).status==='failed');
 assert.equal(f.c.command(input.id).error,'AUTHORIZATION_SCOPE_CHANGED');assert.equal(f.calls(),0);
});
test('persisted events and receipts contain no raw tool output or authentication secrets',async t=>{
 const f=await fixture(t,{workProject:async({onEvent})=>{onEvent({event:'dispatch',model:'fixture',prompt:'secret prompt',token:'secret-value'});return{status:'completed',response:'safe result'};}});
 const input=cmd();await f.c.submit(input);await until(()=>f.c.command(input.id).status==='completed');
 const bytes=await readFile(join(f.options.stateDir,'remote.json'),'utf8');assert.doesNotMatch(bytes,/secret prompt|secret-value/);
 assert.equal(f.c.snapshot().projects[0].id,'sample');
});
