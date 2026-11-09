import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {main,parseArgs} from '../src/calcifer-cli.mjs';

const entry={project:'sample',stateDir:'/state/sample',projectId:'00000000-0000-4000-8000-000000000001'};
function harness(entries=[entry]){
 let out='',err='',work=0,auth=0;
 return {home:'/home/example',stdin:{isTTY:false},stdout:{isTTY:false,write:s=>out+=s},stderr:{write:s=>err+=s},process:new EventEmitter(),
  api:{discoverProjects:async()=>entries,lookupProject:async()=>null,projectStatus:async()=>({projectId:entry.projectId,projectName:'Sample project',status:'ready',model:'gpt-6-astra',turnsUsed:3,maxTurns:6}),workProject:async()=>work++,authorizeProject:async()=>auth++},
  result:()=>({out,err,work,auth})};
}
test('bare command opens project selection while explicit help remains help',()=>{
 assert.equal(parseArgs([]).command,'select');
 assert.equal(parseArgs(['--help']).command,'help');
});
test('non-interactive bare entry lists known projects without authorizing or dispatching',async()=>{
 const h=harness();assert.equal(await main([],h),0);
 assert.match(h.result().out,/sample/);assert.match(h.result().out,/Sample project/);
 assert.equal(h.result().auth,0);assert.equal(h.result().work,0);
 assert.equal(h.process.listenerCount('SIGINT'),0);
});

function interactive(h,answers){
 h.stdin.isTTY=true;h.stdout.isTTY=true;
 h.createInterface=()=>{const rl=new EventEmitter();rl.closed=false;rl.close=()=>{rl.closed=true;};rl.question=async prompt=>{h.stdout.write(prompt);assert.ok(answers.length,'unexpected prompt');return answers.shift();};return rl;};
 return h;
}
test('selection opens the same session and quit does not dispatch or authorize',async()=>{
 const h=interactive(harness(),['wrong','1','/quit']);
 assert.equal(await main([],h),0);assert.match(h.result().out,/calcifer sample>/);
 assert.match(h.result().out,/3\/6/);assert.match(h.result().out,/有效編號/);
 assert.equal(h.result().work,0);assert.equal(h.result().auth,0);
 assert.equal(h.process.listenerCount('SIGINT'),0);
});
test('empty or cancelled selector never dispatches',async()=>{
 const h=harness([]);assert.equal(await main([],h),0);assert.match(h.result().out,/init/);
 const c=interactive(harness(),['q']);assert.equal(await main([],c),0);
 assert.equal(c.result().work,0);assert.equal(c.result().auth,0);
});
test('registered project name resolves its custom state and explicit state wins',async()=>{
 const h=harness();let seen;h.api.lookupProject=async()=>entry;h.api.projectStatus=async({stateDir})=>{seen=stateDir;return {projectId:entry.projectId,status:'ready'};};
 assert.equal(await main(['status','--project','sample'],h),0);assert.equal(seen,entry.stateDir);
 assert.equal(await main(['status','--project','sample','--state','/another'],h),0);assert.equal(seen,'/another');
});
test('selector refuses an identity changed between listing and opening',async()=>{
 const h=interactive(harness(),['1']);let reads=0;
 h.api.projectStatus=async()=>({projectId:++reads===1?entry.projectId:'changed',status:'ready'});
 assert.equal(await main([],h),1);assert.equal(h.result().work,0);assert.match(h.result().err,/身分|IDENTITY/);
});
test('unreadable item is visible and cannot hide a healthy session',async()=>{
 const h=harness([{project:'broken',stateDir:'/bad',error:'REGISTRY_IDENTITY_CHANGED'},entry]);
 assert.equal(await main([],h),0);assert.match(h.result().out,/broken.*無法開啟/);assert.match(h.result().out,/sample/);
 assert.equal(h.result().work,0);
});
test('compact startup omits old full task and response; explicit status retains them',async()=>{
 const h=interactive(harness(),['1','/quit']);h.api.projectStatus=async()=>({projectId:entry.projectId,lastTask:'LONG_TASK_BODY',lastResponse:'LONG_MODEL_RESPONSE'});
 assert.equal(await main([],h),0);assert.doesNotMatch(h.result().out,/LONG_TASK_BODY|LONG_MODEL_RESPONSE/);
 const s=harness();s.api.projectStatus=h.api.projectStatus;
 assert.equal(await main(['status','--state','/state'],s),0);assert.match(s.result().out,/LONG_MODEL_RESPONSE/);
});
test('register is explicit and never authorizes existing state',async()=>{
 assert.throws(()=>parseArgs(['register','--project','sample']),/--state/);
 const h=harness();let registered;h.api.registerProject=async p=>{registered=p;return entry;};
 assert.equal(await main(['register','--project','sample','--state',entry.stateDir],h),0);
 assert.equal(registered.project,'sample');assert.equal(registered.stateDir,entry.stateDir);
 assert.equal(h.result().auth,0);assert.equal(h.result().work,0);
});

test('interrupting project selection exits cleanly without dispatch',async()=>{
 const h=interactive(harness(),[]);
 h.createInterface=()=>{const rl=new EventEmitter();rl.closed=false;rl.close=()=>{rl.closed=true;rl.emit('close');};rl.question=(_,{signal})=>new Promise((ok,no)=>{signal.addEventListener('abort',()=>no(new DOMException('Cancelled','AbortError')),{once:true});queueMicrotask(()=>h.process.emit('SIGINT'));});return rl;};
 assert.equal(await main([],h),0);assert.equal(h.result().auth,0);assert.equal(h.result().work,0);assert.equal(h.process.listenerCount('SIGINT'),0);
});
