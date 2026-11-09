import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createProject,projectStatus} from '../src/project-session.mjs';
import {createRemoteServer} from '../src/remote-server.mjs';
import {createPasswordVerifier} from '../src/remote-auth.mjs';
import {digest} from '../src/workspace-tools.mjs';

test('real project API runs CPU checks and delivers an authenticated patch without model authority',async t=>{
 const root=await mkdtemp('/tmp/calcifer-remote-native-'),repo=join(root,'source'),stateDir=join(root,'project'),control=join(root,'control');
 await mkdir(join(repo,'tools'),{recursive:true});await mkdir(join(repo,'tests'));await mkdir(control,{mode:0o700});
 await writeFile(join(repo,'tools/value.py'),'VALUE=1\n');await writeFile(join(repo,'tests/test_value.py'),'import unittest\nfrom tools.value import VALUE\nclass ValueTest(unittest.TestCase):\n def test_positive(self): self.assertGreater(VALUE,0)\n');
 const sources=[],text='Only use this synthetic acceptance project.',profile={schemaVersion:1,name:'Remote CPU acceptance',sourceFiles:['tools/value.py','tests/test_value.py'],writeRules:[{root:'tools',extensions:['.py']},{root:'tests',extensions:['.py']}],check:{kind:'python-unittest',testDir:'tests',timeoutMs:10000}};
 const created=await createProject({repo,stateDir,profile,context:{text,sources,hash:digest({sources,text})}});
 await writeFile(join(created.workspaceDir,'tools/value.py'),'VALUE=2\n');
 const verifierPath=join(root,'password.json');await writeFile(verifierPath,JSON.stringify(await createPasswordVerifier('synthetic-native-password')),{mode:0o600});
 const config={stateDir:control,verifierPath,projects:[{id:'sample',label:'CPU 驗收',stateDir}],port:0,origin:'http://127.0.0.1:0',allowHttp:true};let server=await createRemoteServer(config);t.after(()=>server.close());
 let origin=new URL(server.url).origin,cookie,csrf;const request=(path,body)=>fetch(server.url+'api/'+path,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json','X-CSRF-Token':csrf??''}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const login=await request('login',{password:'synthetic-native-password'});cookie=login.headers.get('set-cookie').split(';')[0];csrf=(await login.json()).csrf;
 async function command(action,input={}){const id=randomUUID();const r=await request('commands',{id,project:'sample',action,input});assert.equal(r.status,202);for(let i=0;i<300;i++){const c=await(await request('commands/'+id)).json();if(!['queued','running'].includes(c.status))return c;await new Promise(r=>setTimeout(r,25));}throw Error('native command did not settle');}
 const work=await command('work',{task:'This task must not be sent to a provider.'});assert.equal(work.status,'failed');assert.equal(work.error,'AUTHORIZATION_REQUIRED');
 const checked=await command('test');assert.equal(checked.status,'completed');assert.ok(checked.result.checks.some(c=>c.stage==='project'));assert.ok(checked.result.checks.every(c=>c.status==='passed'));
 const exported=await command('export');assert.equal(exported.status,'completed');assert.equal(exported.hasPatch,true);
 const download=await request('commands/'+exported.id+'/patch');assert.equal(download.status,200);assert.match(await download.text(),/\+VALUE=2/);
 assert.equal(await readFile(join(repo,'tools/value.py'),'utf8'),'VALUE=1\n');assert.equal((await projectStatus({stateDir})).turnsUsed,0);
 const view=server.controller.snapshot().projects[0].status;
 const approved=await command('authorize',{maxTurns:1,maxMinutes:null,note:'Offline receipt acceptance only; no model dispatch.',scopeHash:view.scopeHash});assert.equal(approved.status,'completed');
 // Simulate loss of only the controller acknowledgement after native completion.
 await server.close();const path=join(control,'remote.json'),store=JSON.parse(await readFile(path,'utf8'));
 for(const c of [checked,exported,approved]){store.commands[c.id].status='running';delete store.commands[c.id].result;delete store.commands[c.id].artifact;}
 await writeFile(path,JSON.stringify(store));server=await createRemoteServer(config);origin=new URL(server.url).origin;
 const recovered=await command('recover');assert.equal(recovered.status,'completed');
 for(const c of [checked,exported,approved]){const original=await(await request('commands/'+c.id)).json();assert.equal(original.status,'completed');assert.equal(original.recovered,true);}
 assert.equal((await request('commands/'+exported.id+'/patch')).status,200);assert.equal((await projectStatus({stateDir})).turnsUsed,0);
});
