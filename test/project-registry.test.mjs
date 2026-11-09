import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {discoverProjects,registerProject,lookupProject} from '../src/project-registry.mjs';
async function fixture(t){const home=await mkdtemp(join(tmpdir(),'calcifer-entry-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
async function session(stateDir){
 await mkdir(stateDir,{recursive:true});
 const s={schemaVersion:2,projectId:randomUUID(),workspaceDir:join(stateDir,'workspace'),budget:{used:3,maxTurns:6},pending:{id:'unknown-operation'},status:'unknown'};
 await writeFile(join(stateDir,'project.json'),JSON.stringify(s));return s;
}
test('discovery is read-only and a new home remains uninitialized',async t=>{
 const home=await fixture(t);assert.deepEqual(await discoverProjects({home}),[]);
 await assert.rejects(access(join(home,'.local')),{code:'ENOENT'});
});
test('custom state registration survives reload and preserves budget and UNKNOWN',async t=>{
 const home=await fixture(t),stateDir=join(home,'custom');const s=await session(stateDir);
 const before=await readFile(join(stateDir,'project.json'));
 const entry=await registerProject({home,project:'demo',stateDir});assert.equal(entry.projectId,s.projectId);
 assert.deepEqual(await lookupProject({home,project:'demo'}),entry);
 assert.deepEqual(await registerProject({home,project:'demo',stateDir}),entry);
 assert.deepEqual(await discoverProjects({home}),[entry]);
 assert.deepEqual(await readFile(join(stateDir,'project.json')),before);
});
test('default states are discovered and duplicate aliases do not duplicate a session',async t=>{
 const home=await fixture(t),stateDir=join(home,'.local/state/calcifer/demo');await session(stateDir);
 assert.equal((await discoverProjects({home}))[0].project,'demo');
 await registerProject({home,project:'demo',stateDir});
 await registerProject({home,project:'other-alias',stateDir});
 assert.equal((await discoverProjects({home})).length,1);
});
test('name collision cannot replace a registered or default session',async t=>{
 const home=await fixture(t),a=join(home,'a'),b=join(home,'b');await session(a);await session(b);
 await registerProject({home,project:'same',stateDir:a});
 await assert.rejects(registerProject({home,project:'same',stateDir:b}),/NAME_CONFLICT/);
 assert.equal((await lookupProject({home,project:'same'})).stateDir,a);
 await session(join(home,'.local/state/calcifer/default'));
 await assert.rejects(registerProject({home,project:'default',stateDir:b}),/NAME_CONFLICT/);
});
test('stale identity and missing paths are visible, not replaced with new sessions',async t=>{
 const home=await fixture(t),stateDir=join(home,'custom');await session(stateDir);
 await registerProject({home,project:'demo',stateDir});await session(stateDir);
 await assert.rejects(lookupProject({home,project:'demo'}),/IDENTITY_CHANGED/);
 assert.equal((await discoverProjects({home}))[0].error,'REGISTRY_IDENTITY_CHANGED');
 await rm(stateDir,{recursive:true});
 assert.equal((await discoverProjects({home}))[0].error,'REGISTRY_STATE_MISSING');
});
test('registry cannot follow a symlink to a session or overwrite through a symlink',async t=>{
 const home=await fixture(t),stateDir=join(home,'real');await session(stateDir);
 await symlink(stateDir,join(home,'link'));
 await assert.rejects(registerProject({home,project:'demo',stateDir:join(home,'link')}),/SYMLINK_REJECTED/);
 const root=join(home,'.local/state/calcifer');await mkdir(root,{recursive:true});
 await symlink(stateDir,join(root,'.registry'));
 await assert.rejects(registerProject({home,project:'demo',stateDir}),/SYMLINK_REJECTED/);
 await assert.rejects(access(join(stateDir,'demo.json')),{code:'ENOENT'});
});
