import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../src/workspace-tools.mjs';
const repo=new URL('../',import.meta.url),bun=resolve(new URL('../node_modules/.bin/bun',import.meta.url).pathname);
for(const framework of ['opencode','pi'])test(`${framework} official SDK observes semantic bug then edits once and host accepts fixed JSON CLI cases`,async()=>{
  const root=await mkdtemp(join(tmpdir(),`calcifer-m4-${framework}-`)),stateRoot=join(root,'state');
  try{
    const child=spawnSync(bun,['test/helpers/goal-probe.mjs',framework,'json-cli',stateRoot,process.execPath],{cwd:repo,env:{PATH:process.env.PATH},encoding:'utf8',timeout:25000,maxBuffer:8*1024*1024});
    assert.equal(child.error,undefined);assert.equal(child.signal,null,child.stderr);assert.equal(child.status,0,child.stdout+child.stderr);
    const report=JSON.parse(child.stdout.split('\n').find(line=>line.startsWith('CALCIFER_GOAL_RESULT=')).slice(21));
    assert.equal(report.status,'completed');assert.equal(report.acceptanceKind,'node-json-cli');assert.equal(report.runtimeCorrectness,'fixed_json_cli_cases_only');
    assert.equal(report.actualModelRequests,0);assert.deepEqual(report.requestCounts,{attempted:5,admitted:5,dispatched:5,terminalConfirmed:5});assert.equal(report.reservedOutputTokens,2560);
    const wire=JSON.parse(await readFile(join(report.runDir,'synthetic-wire.json'),'utf8'));
    assert.deepEqual(wire.requestFailures,[]);assert.deepEqual(wire.phases.flatMap(item=>item.tools.map(tool=>tool.input.action)),['check','read','edit']);
    const baseline=report.inner.checks[0],final=report.inner.checks[1];
    assert.equal(baseline.kind,'node-json-cli');assert.equal(baseline.code,'CHECK_VALUE_MISMATCH');assert.equal(baseline.cases[0].process.exitCode,0);assert.equal(baseline.cases[0].comparison,false);
    assert.equal(final.status,'passed');assert.equal(final.cases.length,3);assert.ok(final.cases.every(item=>item.comparison&&item.process.closed));assert.equal(final.manifestHash,report.inner.finalManifestHash);
    const source=await readFile(new URL('../fixtures/json-cli-demo/entry.mjs',import.meta.url),'utf8');assert.match(source,/input.a - input.b/);
    const artifact=report.inner.artifacts[0];assert.match(artifact.content,/input.a \+ input.b/);assert.equal(hash(artifact.content),artifact.afterHash);
    const ledger=join(report.runDir,'ledger.jsonl'),before=await readFile(ledger,'utf8');
    const reopen=spawnSync(process.execPath,['src/goal-cli.mjs','reopen','--state-root',stateRoot,'--run-id',report.runID],{cwd:repo,encoding:'utf8',timeout:10000});
    assert.equal(reopen.status,0,reopen.stdout+reopen.stderr);const reopened=JSON.parse(reopen.stdout);assert.equal(reopened.reopenedWithoutSDK,true);assert.equal(reopened.acceptanceKind,'node-json-cli');
    assert.equal(reopened.checks[1].cases.length,3);assert.equal(await readFile(ledger,'utf8'),before);
    if(process.env.CALCIFER_M4_KEEP==='1'){await writeFile(join(root,'result.json'),JSON.stringify(report));console.log(`M4_ARTIFACT ${framework} ${root}`);}
  }finally{if(process.env.CALCIFER_M4_KEEP!=='1')await rm(root,{recursive:true,force:true});}
});
test('Node CLI launches json-cli example through pinned Bun and rejects unknown examples',async()=>{
  const root=await mkdtemp(join(tmpdir(),'calcifer-m4-cli-'));
  const cli=(...args)=>spawnSync(process.execPath,['src/goal-cli.mjs',...args],{cwd:repo,encoding:'utf8',timeout:25000,maxBuffer:1024*1024});
  try{
    const result=cli('demo','--example','json-cli','--state-root',join(root,'state'));
    assert.equal(result.error,undefined);assert.equal(result.status,0,result.stdout+result.stderr);
    const report=JSON.parse(result.stdout);assert.equal(report.status,'completed');assert.equal(report.acceptanceKind,'node-json-cli');assert.equal(report.syntheticModelRequests,5);assert.equal(report.checks[0].code,'CHECK_VALUE_MISMATCH');assert.equal(report.checks[1].cases.length,3);
    assert.ok(report.checks.every(check=>!('stdoutBase64'in check)&&!('runtime'in check)));assert.equal(report.actualModelRequests,0);
    const rejected=cli('demo','--example','arbitrary','--state-root',join(root,'other'));assert.equal(rejected.status,1);assert.equal(JSON.parse(rejected.stdout).code,'INVALID_EXAMPLE');
  }finally{await rm(root,{recursive:true,force:true});}
});
