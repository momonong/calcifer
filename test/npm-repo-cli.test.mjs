import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const cwd=new URL('../',import.meta.url),contractSource=new URL('../fixtures/npm-repo-contract.json',import.meta.url);
const cli=(...args)=>spawnSync(process.execPath,['src/collaboration-run-cli.mjs',...args],{cwd,encoding:'utf8',timeout:15000,maxBuffer:1024*1024});
test('caller repo-check observes baseline failure, checks corrected repo once, and reopens saved authority readonly',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calcifer-m5-cli-')),repo=join(root,'repo'),contract=join(root,'contract.json'),state=join(root,'state');
 try{
  await cp(new URL('../fixtures/npm-repo-demo/',import.meta.url),repo,{recursive:true});await cp(contractSource,contract);
  const args=['repo-check','--repo',repo,'--contract',contract,'--state-root',state];
  const red=cli(...args);assert.equal(red.error,undefined);assert.equal(red.status,1);const baseline=JSON.parse(red.stdout);assert.equal(baseline.status,'failed',red.stdout+red.stderr);assert.equal(baseline.checks[0].npm.exitCode,1);assert.equal(baseline.checks[0].oracle.code,'CHECK_VALUE_MISMATCH');assert.equal(baseline.modelRequests,0);
  const file=join(repo,'src/add.mjs');await writeFile(file,(await readFile(file,'utf8')).replace('a - b','a + b'));
  const green=cli(...args);assert.equal(green.status,0,green.stdout+green.stderr);const result=JSON.parse(green.stdout);assert.equal(result.status,'completed');assert.equal(result.executionMode,'local-host-check');assert.equal(result.frameworkInstantiated,false);assert.equal(result.checks.length,1);assert.equal(result.checks[0].npm.exitCode,0);assert.equal(result.checks[0].oracle.cases.length,3);
  assert.ok(!green.stdout.includes('stdoutBase64')&&!green.stdout.includes(process.execPath));
  const ledger=join(state,'runs',result.runID,'ledger.jsonl'),before=await readFile(ledger,'utf8');const events=before.trim().split('\n').map(JSON.parse);assert.equal(events.filter(e=>e.type==='intent'&&e.data.kind==='repo-command'&&e.data.stage==='npm').length,1);
  await writeFile(contract,'{"invalid":"current caller contract must not replace saved authority"}');
  const reopened=cli('reopen','--state-root',state,'--run-id',result.runID);assert.equal(reopened.status,0,reopened.stdout);assert.equal(JSON.parse(reopened.stdout).reopenedWithoutExecution,true);assert.equal(await readFile(ledger,'utf8'),before);
  assert.equal(cli(...args,'--command','arbitrary').status,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
import { createRunState } from '../src/run-state.mjs';
import { snapshotContents, materializeSnapshot, digest, DEFAULT_LIMITS } from '../src/workspace-tools.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
test('readonly CLI keeps metadata runID and unresolved intents before any report exists',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calcifer-m5-pending-')),sourceDir=join(root,'repo'),stateRoot=join(root,'state');let state;
 try{
  await mkdir(sourceDir);const initial=snapshotContents({'note.txt':'saved\n'}),plan={schemaVersion:1,goal:'Observe pending host command',tasks:[{id:'pending',instruction:'Observe only',dependsOn:[],requiredCapabilities:[],writePaths:[],checkIds:[]}]};
  state=await createRunState({stateRoot,sourceDir,metadata:{plan,planHash:digest(plan),sourceFiles:['note.txt'],allowedPaths:[],finalCheckIds:[],definitions:{},initialManifest:initial.manifest,limits:DEFAULT_LIMITS,provenance:{kind:'mock'}}});
  await materializeSnapshot(join(state.runDir,'initial'),initial);await state.append({type:'intent',data:{id:randomUUID(),kind:'repo-command',stage:'npm'}});
  const before=await readFile(join(state.runDir,'ledger.jsonl'),'utf8'),result=cli('reopen','--state-root',stateRoot,'--run-id',state.metadata.runID);
  assert.equal(result.status,1);const value=JSON.parse(result.stdout);assert.equal(value.status,'unknown');assert.equal(value.runID,state.metadata.runID);assert.equal(value.unknown[0].kind,'repo-command');assert.equal(value.reopenedWithoutExecution,true);assert.equal(await readFile(join(state.runDir,'ledger.jsonl'),'utf8'),before);
 }finally{await state?.release(false);await rm(root,{recursive:true,force:true});}
});
