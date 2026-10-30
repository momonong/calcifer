import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const cwd=new URL('../',import.meta.url),bun=resolve(new URL('../node_modules/.bin/bun',import.meta.url).pathname);
for(const framework of ['opencode','pi'])test(`${framework} SDK corrects multi-file npm repo after command failure and independent semantic mismatch`,async()=>{
 const root=await mkdtemp(join(tmpdir(),`calcifer-m5-${framework}-`)),state=join(root,'state');
 try{
  const child=spawnSync(bun,['test/helpers/goal-probe.mjs',framework,'npm-repo',state,process.execPath],{cwd,env:{PATH:process.env.PATH,CALCIFER_NPM_CANARY:'must-not-inherit'},encoding:'utf8',timeout:25000,maxBuffer:8*1024*1024});
  assert.equal(child.error,undefined);assert.equal(child.signal,null);assert.equal(child.status,0,child.stdout+child.stderr);
  const report=JSON.parse(child.stdout.split('\n').find(line=>line.startsWith('CALCIFER_GOAL_RESULT=')).slice(21));
  assert.equal(report.status,'completed');assert.equal(report.acceptanceKind,'node-npm-repo');assert.equal(report.unitTestAssertions,'not_attested');assert.equal(report.actualModelRequests,0);assert.deepEqual(report.requestCounts,{attempted:5,admitted:5,dispatched:5,terminalConfirmed:5});assert.equal(report.reservedOutputTokens,2560);
  const [before,after]=report.inner.checks;assert.equal(before.npm.process.exitCode,1);assert.equal(before.oracle.code,'CHECK_VALUE_MISMATCH');assert.equal(after.npm.process.exitCode,0);assert.equal(after.npm.process.closed,true);assert.equal(after.oracle.cases.length,3);assert.ok(after.oracle.cases.every(c=>c.comparison&&c.process.closed));assert.equal(after.manifestHash,report.inner.finalManifestHash);
  const wire=JSON.parse(await readFile(join(report.runDir,'synthetic-wire.json'),'utf8'));assert.deepEqual(wire.requestFailures,[]);assert.deepEqual(wire.phases.flatMap(p=>p.tools.map(t=>t.input.action)),['check','read','edit']);
  assert.equal(report.inner.artifacts.length,1);assert.equal(report.inner.artifacts[0].path,'src/add.mjs');assert.match(report.inner.artifacts[0].content,/a \+ b/);assert.match(await readFile(new URL('../fixtures/npm-repo-demo/src/add.mjs',import.meta.url),'utf8'),/a - b/);
  const innerLedger=(await readFile(join(report.inner.runDir,'ledger.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(innerLedger.filter(e=>e.type==='intent'&&e.data.kind==='repo-command').length,6);
  const reopen=spawnSync(process.execPath,['src/goal-cli.mjs','reopen','--state-root',state,'--run-id',report.runID],{cwd,encoding:'utf8',timeout:10000});assert.equal(reopen.status,0,reopen.stdout+reopen.stderr);assert.equal(JSON.parse(reopen.stdout).reopenedWithoutSDK,true);
  if(process.env.CALCIFER_M5_KEEP==='1'){await writeFile(join(root,'result.json'),JSON.stringify(report));console.log(`M5_ARTIFACT ${framework} ${root}`);}
 }finally{if(process.env.CALCIFER_M5_KEEP!=='1')await rm(root,{recursive:true,force:true});}
});
test('Node goal CLI launches npm-repo example with fixed official SDK path and safe summary',async()=>{
 const root=await mkdtemp(join(tmpdir(),'calcifer-m5-goal-cli-'));try{
  const child=spawnSync(process.execPath,['src/goal-cli.mjs','demo','--example','npm-repo','--state-root',join(root,'state')],{cwd,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stdout+child.stderr);const r=JSON.parse(child.stdout);assert.equal(r.acceptanceKind,'node-npm-repo');assert.equal(r.checks[0].npm.exitCode,1);assert.equal(r.checks[1].npm.exitCode,0);assert.equal(r.checks[1].oracle.cases.length,3);assert.equal(r.syntheticModelRequests,5);assert.ok(!child.stdout.includes('stdoutBase64')&&!child.stdout.includes(process.execPath));
 }finally{await rm(root,{recursive:true,force:true});}
});
