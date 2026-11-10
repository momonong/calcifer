import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { main, parseArgs } from '../src/calcifer-cli.mjs';
function harness(api={}) {
  let out='',err=''; const proc=new EventEmitter();
  return { api:{projectStatus:async()=>status,lookupProject:async()=>null,registerProject:async()=>null,...api}, home:'/home/example', stdin:{isTTY:false}, stdout:{isTTY:false,write:s=>out+=s}, stderr:{write:s=>err+=s}, process:proc, result:()=>({out,err}),proc };
}
const status = {status:'unauthorized', projectId:'thor', workspaceDir:'/state/workspace',maxTurns:0,turnsUsed:0};
test('parser accepts state before or after command and rejects injection switches',()=>{
  assert.equal(parseArgs(['thor','--state','/s','work','修好結果匯出']).task,'修好結果匯出');
  assert.equal(parseArgs(['thor','status','--state','/s']).stateDir,'/s');
  assert.throws(()=>parseArgs(['thor','work','x','--mock','m']),/不支援/);
  assert.throws(()=>parseArgs(['thor','status','--state','relative']),/絕對/);
  assert.throws(()=>parseArgs(['thor','status','unexpected']),/額外/);
  assert.throws(()=>parseArgs(['thor','work']),/需求/);
});
test('authorization bounds and explicit note required',()=>{
  assert.throws(()=>parseArgs(['thor','authorize','--turns','33','--minutes','45','--note','用途','--yes']),/1 與 32/);
  assert.throws(()=>parseArgs(['thor','authorize','--turns','2','--minutes','3','--yes']),/note/);
  assert.throws(()=>parseArgs(['thor','status','--yes']),/不接受/);
});
test('nonTTY entry displays status without opening REPL or authorizing',async()=>{
  let reads=0; const h=harness({projectStatus:async()=>{reads++;return status;}, authorizeProject:()=>assert.fail('must not authorize')});
  assert.equal(await main(['thor'],h),0); assert.equal(reads,1);
  assert.match(h.result().out,/未授權|unauthorized/); assert.match(h.result().out,/非互動/);
  assert.equal(h.proc.listenerCount('SIGINT'),0);
});
test('nonTTY authorize does not hang or call host without yes',async()=>{
  const h=harness({authorizeProject:()=>assert.fail('must not authorize')});
  assert.equal(await main(['thor','authorize','--turns','2','--minutes','3','--note','bounded task'],h),2);
  assert.match(h.result().err,/--yes/);
});
test('explicit authorization forwards exact limits once',async()=>{
  let received;const h=harness({authorizeProject:async p=>{received=p;return status;}});
  assert.equal(await main(['thor','authorize','--turns','2','--minutes','3','--note','one task','--yes','--state','/s'],h),0);
  assert.deepEqual(received,{stateDir:'/s',maxTurns:2,maxMinutes:3,note:'one task'});
});
test('insufficient initial routing budget explains the minimum without implying authorization',async()=>{
 const h=harness({authorizeProject:()=>{throw new Error('GOAL_REQUIRES_PLANNER_AND_WORKER_BUDGET');}});
 assert.equal(await main(['authorize','--state','/s','--turns','1','--note','Initial goal','--yes'],h),1);
 assert.match(h.result().err,/至少.*2.*規劃.*執行/);
 assert.match(h.result().err,/明確.*授權/);
});
test('initialization never authorizes and uses explicit repo/context',async()=>{
  const calls=[]; const h=harness({thorSourceFiles:async repo=>{calls.push(repo);return ['erasebot/a.py'];},loadProjectContext:async()=>({text:'rules',sources:[],hash:'h'}),createProject:async p=>{calls.push(p);return status;},authorizeProject:()=>assert.fail('must not authorize')});
  assert.equal(await main(['thor','init','--repo','/repo','--state','/s'],h),0);
  assert.deepEqual(calls[1].seedContents,{});assert.equal(calls[1].context.text,'rules');
});
test('test command carries force and signals; failed checks return failure',async()=>{
  let received; const h=harness({testProject:async p=>{received=p;return {status:'failed',checks:[{status:'failed',stderr:'assertion failed'}]};}});
  assert.equal(await main(['thor','test','--force','--state','/s'],h),1);
  assert.equal(received.force,true); assert.equal(received.stateDir,'/s'); assert.ok(received.signal instanceof AbortSignal);
  const h2=harness({testProject:async()=>({status:'passed',reused:true,checks:[{status:'passed'}]})});
  assert.equal(await main(['thor','test'],h2),0); assert.match(h2.result().out,/沿用/);
});
test('work relays task/events and cancellation never retries',async()=>{
  let calls=0;const h=harness({workProject:async({task,signal,onEvent})=>{calls++;assert.equal(task,'修好它');onEvent({type:'dispatch',raw:'token=NEVERPRINT'});h.proc.emit('SIGINT');assert.equal(signal.aborted,true);return {status:'unknown',code:'RESULT_UNKNOWN'};}});
  assert.equal(await main(['thor','work','修好它'],h),1);assert.equal(calls,1);
  assert.match(h.result().out,/取消/);assert.doesNotMatch(h.result().out,/NEVERPRINT/);
});
test('errors do not print stack or raw credentials',async()=>{
  const h=harness({projectStatus:async()=>{throw new Error('token=private_value\nprivate stack');}});
  assert.equal(await main(['thor','status'],h),1);assert.doesNotMatch(h.result().err,/private_value|private stack|at main/);
});
test('missing state explains explicit initialization',async()=>{
  const h=harness({projectStatus:async()=>{const e=new Error('missing');e.code='ENOENT';throw e;}});
  assert.equal(await main(['thor'],h),1);assert.match(h.result().err,/init --repo/);
});
test('help runs without loading host API',async()=>{
  const h=harness();assert.equal(await main(['--help'],h),0);assert.match(h.result().out,/Calcifer/);assert.match(h.result().out,/codex\|agy/);
});

test('generic project and execution backend are independent CLI choices',()=>{
 const a=parseArgs(['init','--project','taskboard','--repo','/repo','--profile','/profile.json','--backend','codex'],'/home/user');
 assert.equal(a.stateDir,'/home/user/.local/state/calcifer/taskboard');assert.equal(a.opts['--backend'],'codex');assert.equal(a.legacy,false);
 assert.equal(parseArgs(['--project','taskboard']).command,'repl');
 assert.equal(parseArgs(['thor']).stateDir,parseArgs(['--project','thor']).stateDir);
 assert.throws(()=>parseArgs(['init','--project','x','--repo','/repo']),/profile/);
 assert.throws(()=>parseArgs(['work','hello','--project','x','--backend','codex']),/不接受/);
 assert.throws(()=>parseArgs(['status','--project','../thor']),/project/);
});


test('authorization without minutes requests no deadline while preserving explicit call authorization',async()=>{
 let received;const h=harness({projectStatus:async()=>({...status,backend:'codex',model:'gpt-6-astra'}),authorizeProject:async p=>{received=p;return {...status,maxTurns:3,maxMinutes:null};}});
 assert.equal(await main(['authorize','--project','p','--turns','3','--note','Goal-driven work','--yes'],h),0);
 assert.equal(received.maxMinutes,null);assert.equal(received.maxTurns,3);
 assert.match(h.result().out,/不設.*期限/);assert.doesNotMatch(h.result().out,/undefined|NaN/);
 assert.equal(parseArgs(['authorize','--project','p','--turns','3','--minutes','60','--note','Optional deadline']).opts['--minutes'],'60');
 for(const n of ['0','-1','Infinity','1.5','35792'])assert.throws(()=>parseArgs(['authorize','--project','p','--turns','3','--minutes',n,'--note','Invalid']),/minutes/);
 const unconfirmed=harness({authorizeProject:()=>assert.fail('still requires confirmation')});
 assert.equal(await main(['authorize','--project','p','--turns','3','--note','No silent authorization'],unconfirmed),2);
});

test('reallocation CLI requires a concrete transfer and cannot reset global limits',()=>{
 const args=['reallocate','--project','p','--from','terra','--to','astra','--calls','1','--note','Approved transfer'];
 const parsed=parseArgs(args);assert.equal(parsed.command,'reallocate');assert.equal(parsed.opts['--calls'],'1');
 for(const k of ['--from','--to','--calls','--note']){const bad=[...args],i=bad.indexOf(k);bad.splice(i,2);assert.throws(()=>parseArgs(bad),/reallocate|改配/);}
 for(const extra of [['--turns','5'],['--minutes','10'],['--routing','/new-policy.json']])assert.throws(()=>parseArgs([...args,...extra]),/不接受/);
});
test('reallocation CLI requires confirmation and forwards the bounded transfer only',async()=>{
 const args=['reallocate','--state','/s','--from','terra','--to','astra','--calls','1','--note','Human-approved transfer','--json'];
 const blocked=harness({reallocateProject:()=>assert.fail('must not reallocate without confirmation')});
 assert.equal(await main(args,blocked),2);
 assert.equal(JSON.parse(blocked.result().out).error.code,'CONFIRMATION_REQUIRED');
 let received;const confirmed=harness({reallocateProject:async p=>{received=p;return {...status,turnsUsed:3,maxTurns:4,resourceAllocation:{budgetId:'original',usedByProfile:{argon:1,astra:2},reallocations:[]}};}});
 assert.equal(await main([...args,'--yes'],confirmed),0);
 assert.deepEqual(received,{stateDir:'/s',fromProfileId:'terra',toProfileId:'astra',calls:1,note:'Human-approved transfer'});
 const result=JSON.parse(confirmed.result().out);assert.equal(result.data.turnsUsed,3);assert.equal(result.data.maxTurns,4);assert.equal(result.data.resourceAllocation.budgetId,'original');
});
