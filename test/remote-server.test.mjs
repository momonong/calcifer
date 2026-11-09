import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createPasswordVerifier} from '../src/remote-auth.mjs';
import {createRemoteServer} from '../src/remote-server.mjs';

const PASSWORD='synthetic-acceptance-password';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await pause(10);}throw Error('not settled');}
async function setup(t, overrides={}){
 const root=await mkdtemp('/tmp/calcifer-remote-http-'),stateDir=join(root,'control'),project=join(root,'project');
 await mkdir(stateDir,{mode:0o700});await mkdir(project,{mode:0o700});await mkdir(join(project,'exports'));
 const verifierPath=join(root,'password.json');await writeFile(verifierPath,JSON.stringify(await createPasswordVerifier(PASSWORD)),{mode:0o600});
 const projectState={projectId:'one',projectName:'合成驗收',status:'ready',profile:{sourceFiles:[],writeRules:[]},execution:{backend:'fixture'},maxTurns:2,turnsUsed:0,maxMinutes:null};
 let calls=0;
 const api={projectStatus:async()=>projectState,workProject:async({task,operationId})=>{calls++;projectState.remoteCommandId=operationId;return{status:'completed',response:'完成 '+task};},...overrides};
 const server=await createRemoteServer({stateDir,verifierPath,projects:[{id:'sample',label:'合成驗收',stateDir:project}],hostLabel:'驗收主機',origin:'http://127.0.0.1:0',allowHttp:true,port:0},{api});
 t.after(()=>server.close());const base=server.url,origin=new URL(base).origin;
 const request=(path,options={})=>fetch(base+'api/'+path,{...options,headers:{Origin:origin,...options.headers}});
 async function login(){const res=await request('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD,device:'acceptance'})});assert.equal(res.status,200);return{cookie:res.headers.get('set-cookie').split(';')[0],...(await res.json())};}
 return{server,root,stateDir,project,verifierPath,request,login,origin,base,calls:()=>calls};
}
test('host/origin/JSON/session and CSRF gates protect all private controls',async t=>{
 const f=await setup(t);assert.equal((await f.request('snapshot')).status,401);
 // fetch rewrites Host on this runtime; raw HTTP exercises the actual boundary.
 const forged=await new Promise((resolve,reject)=>{const r=httpRequest(f.base+'api/snapshot',{headers:{Host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end();});
 assert.equal(forged,403);
 assert.equal((await f.request('login',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
 const a=await f.login();const command={id:randomUUID(),project:'sample',action:'work',input:{task:'small edit'}};
 assert.equal((await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json'},body:JSON.stringify(command)})).status,403);
 assert.equal((await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'X-CSRF-Token':'é'.repeat(43),'Content-Type':'application/json'},body:JSON.stringify(command)})).status,403);
 const ok=await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:JSON.stringify(command)});assert.equal(ok.status,202);
 await until(()=>f.calls()===1);
 assert.match(ok.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'X-CSRF-Token':a.csrf,'Content-Type':'text/plain'},body:'{}'})).status,415);
});
test('two devices see one durable command and logout revokes only the current device',async t=>{
 const f=await setup(t),a=await f.login(),b=await f.login();const c={id:randomUUID(),project:'sample',action:'work',input:{task:'once'}};
 const submit=s=>f.request('commands',{method:'POST',headers:{Cookie:s.cookie,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify(c)});
 const responses=await Promise.all([submit(a),submit(b)]);assert.ok(responses.every(r=>r.status===202));await until(()=>f.calls()===1);
 const snapshot=await(await f.request('snapshot',{headers:{Cookie:b.cookie}})).json();assert.equal(snapshot.commands.length,1);
 assert.equal((await f.request('logout',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:'{}'})).status,200);
 assert.equal((await f.request('session',{headers:{Cookie:a.cookie}})).status,401);assert.equal((await f.request('session',{headers:{Cookie:b.cookie}})).status,200);
});
test('SSE disconnect leaves execution running and reconnect replays the same event cursor',async t=>{
 let release,started=false;const wait=new Promise(r=>release=r);
 const f=await setup(t,{workProject:async()=>{started=true;await wait;return{status:'completed',response:'done'};}}),a=await f.login();
 const c={id:randomUUID(),project:'sample',action:'work',input:{task:'long'}};
 await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:JSON.stringify(c)});await until(()=>started);
 const stream=await f.request('events?after=0',{headers:{Cookie:a.cookie}});assert.equal(stream.status,200);const reader=stream.body.getReader();const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/event: update/);await reader.cancel();
 assert.equal(f.server.controller.command(c.id).status,'running');release();await until(()=>f.server.controller.command(c.id).status==='completed');
 const again=await f.request('events?after=0',{headers:{Cookie:a.cookie}});const r=again.body.getReader();assert.match(new TextDecoder().decode((await r.read()).value),/completed/);await r.cancel();
});
test('password rotation and revoke-all invalidate old sessions',async t=>{
 const f=await setup(t),a=await f.login(),b=await f.login();
 await f.request('logout-all',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:'{}'});
 assert.equal((await f.request('session',{headers:{Cookie:b.cookie}})).status,401);
 const c=await f.login();await writeFile(f.verifierPath,JSON.stringify(await createPasswordVerifier('synthetic-new-password')),{mode:0o600});
 assert.equal((await f.request('session',{headers:{Cookie:c.cookie}})).status,401);
});
test('revocation also rejects authenticated POSTs whose body was still in transit',async t=>{
 const f=await setup(t),a=await f.login();const payload=JSON.stringify({id:randomUUID(),project:'sample',action:'work',input:{task:'must not execute'}});let req;
 const result=new Promise((resolve,reject)=>{req=httpRequest(f.base+'api/commands',{method:'POST',headers:{Origin:f.origin,Cookie:a.cookie,'X-CSRF-Token':a.csrf,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);req.write(payload.slice(0,-1));});
 await pause(40);await f.request('logout-all',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:'{}'});
 req.end(payload.slice(-1));assert.equal(await result,401);assert.equal(f.calls(),0);
});
test('patch downloads require completed export, matching hash and confined regular file',async t=>{
 let patchPath,patchHash;const f=await setup(t,{exportProject:async()=>({status:'completed',patchPath,patchHash})}),a=await f.login();
 patchPath=join(f.project,'exports','accepted.patch');const patch='diff --git a/value.py b/value.py\n';await writeFile(patchPath,patch);patchHash=createHash('sha256').update(patch).digest('hex');
 const c={id:randomUUID(),project:'sample',action:'export',input:{}};await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:JSON.stringify(c)});await until(()=>f.server.controller.command(c.id).status==='completed');
 assert.equal((await f.request('commands/'+c.id+'/patch')).status,401);
 const good=await f.request('commands/'+c.id+'/patch',{headers:{Cookie:a.cookie}});assert.equal(good.status,200);assert.equal(await good.text(),patch);
 await writeFile(patchPath,'changed');assert.equal((await f.request('commands/'+c.id+'/patch',{headers:{Cookie:a.cookie}})).status,409);
 patchPath=join(f.project,'exports','link.patch');await symlink('/etc/passwd',patchPath);
 const unsafe={...c,id:randomUUID()};await f.request('commands',{method:'POST',headers:{Cookie:a.cookie,'Content-Type':'application/json','X-CSRF-Token':a.csrf},body:JSON.stringify(unsafe)});await until(()=>f.server.controller.command(unsafe.id).status==='completed');
 assert.equal((await f.request('commands/'+unsafe.id+'/patch',{headers:{Cookie:a.cookie}})).status,409);
});
test('invalid body, unknown routes and repeated failed logins fail closed',async t=>{
 const f=await setup(t);assert.equal((await f.request('login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'})).status,400);
 for(let i=0;i<6;i++)await f.request('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'wrong'})});
 assert.equal((await f.request('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})})).status,429);
 assert.equal((await fetch(f.base+'../unrelated')).status,404);
});
