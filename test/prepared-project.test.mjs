import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProject,authorizeProject,projectStatus} from '../src/project-session.mjs';
import {digest} from '../src/workspace-tools.mjs';
import {prepareProjectTask,readPreparedTask} from '../src/prepared-project.mjs';
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'calcifer-prepared-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo'),stateDir=join(root,'state');await mkdir(join(repo,'checks'),{recursive:true});await writeFile(join(repo,'checks/test_input.py'),'# frozen input\n');
 const content={sources:[],text:'Test fixture rules'};const context={...content,hash:digest(content)};
 const profile={schemaVersion:1,name:'Prepared fixture',sourceFiles:['checks/test_input.py'],writeRules:[{root:'docs/submission',extensions:['.md']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:1000}};
 await createProject({repo,stateDir,context,profile,backend:'codex',model:'gpt-6-astra',effort:'high'});
 return {stateDir,title:'Proposal',task:'Complete all documents',maxTurns:24,note:'Explicit prepared phase',documents:{source:'docs/submission/proposal.md',python:'/runtime/python3',renderer:'/skill/render_docx.py',maxPages:10,maxBytes:20971520}};
}
test('preparing a real session preserves zero calls and no authorization',async t=>{
 const p=await setup(t),before=await readFile(join(p.stateDir,'project.json'));
 await prepareProjectTask(p);assert.equal((await readPreparedTask(p)).maxTurns,24);
 assert.deepEqual(await readFile(join(p.stateDir,'project.json')),before);
 await authorizeProject({...p,maxMinutes:null});assert.equal((await projectStatus(p)).maxTurns,24);
 await assert.rejects(prepareProjectTask(p),/ALREADY_USED/);
});
test('prepared task tampering and project replacement are refused',async t=>{
 const p=await setup(t),prepared=await prepareProjectTask(p),file=join(p.stateDir,'prepared-task.json');
 await writeFile(file,JSON.stringify({...prepared,task:'Different goal'}));await assert.rejects(readPreparedTask(p),/CHANGED/);
 await writeFile(file,JSON.stringify(prepared));
 const state=JSON.parse(await readFile(join(p.stateDir,'project.json'),'utf8'));state.projectId='00000000-0000-4000-8000-000000000099';await writeFile(join(p.stateDir,'project.json'),JSON.stringify(state));
 await assert.rejects(readPreparedTask(p),/SCOPE_CHANGED/);
});
