import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runLiveTask, validateArtifacts } from '../src/live-task.mjs';
import { bindPythonRuntime, runP1Check } from '../src/p1-check.mjs';
import { digest, hash } from '../src/workspace-tools.mjs';

test('live artifacts reject traversal, protected changes and duplicate paths', () => {
  const config = {createPaths:['tools/task.py'],writePaths:[]};
  const before={contents:{'input.csv':'a\n'}};
  for(const files of [[{path:'../escape.py',content:'x'}],[{path:'input.csv',content:'x'}],[{path:'tools/task.py',content:'x'},{path:'tools/task.py',content:'y'}]])
    assert.throws(()=>validateArtifacts({summary:'ok',files},config,before), /ARTIFACT/);
  assert.equal(validateArtifacts({summary:'ok',files:[{path:'tools/task.py',content:'print(1)\n'}]},config,before).contents['tools/task.py'],'print(1)\n');
});

async function fixture(){
  const base=await mkdtemp('/tmp/calcifer-live-test-');
  const repo=join(base,'source');await mkdir(repo);
  await writeFile(join(repo,'input.csv'),'status\nnot_run\n');
  const acceptance=join(base,'acceptance.py');
  await writeFile(acceptance,"from pathlib import Path\nimport unittest\nclass Acceptance(unittest.TestCase):\n def test_result(self):\n  p=Path('/workspace/tools/task.py')\n  self.assertTrue(p.is_file(), 'missing implementation')\n  self.assertEqual(p.read_text(), 'print(42)\\n')\nunittest.main()\n");
  return {base,config:{schemaVersion:1,repo,stateDir:join(base,'state'),sourceFiles:['input.csv'],contextFiles:['input.csv'],createPaths:['tools/task.py'],writePaths:[],goal:'Create task.py',rules:'Use only scoped outputs.',acceptancePath:acceptance,commands:[],model:'gemini-4-argon-medium',agyVersion:'test-only',maxAttempts:2,totalTimeoutMs:120000,authorization:'offline fixture seam only',quota:{kind:'fixture'}}};
}
const response=(content,id='00000000-0000-4000-8000-000000000001')=>({status:'SUCCESS',conversation_id:id,response:JSON.stringify({summary:'implemented',files:[{path:'tools/task.py',content}]}),usage:{input_tokens:30,output_tokens:20},process:{closed:true,exitCode:0},tools:[],actualModel:'gemini-4-argon-medium'});

test('Python checks run in isolated read-only snapshot without host home/network',async()=>{
  const base=await mkdtemp('/tmp/calcifer-python-test-');
  const script="import pathlib,socket\nassert not pathlib.Path('/home').exists()\ntry:\n pathlib.Path('/workspace/escape').write_text('x')\n raise AssertionError('writable')\nexcept OSError: pass\ns=socket.socket()\ns.settimeout(.2)\nassert s.connect_ex(('1.1.1.1',443)) != 0\nprint('isolated')\n";
  await writeFile(join(base,'check.py'),script);
  const runtime=await bindPythonRuntime('/usr/bin/python3.12');
  const definition={argv:['-I','-B','check.py'],timeoutMs:3000};definition.definitionHash=digest(definition);
  const receipt=await runP1Check({snapshotDir:base,manifest:{hash:hash(script)},definition,runtime,stage:'test',checkId:'python'});
  assert.equal(receipt.status,'passed',JSON.stringify(receipt));
  assert.match(receipt.stdout,/isolated/);
});

test('live flow stops at acceptance, preserves source, exports and refuses replay',async()=>{
  const {config}=await fixture();let calls=0;
  const report=await runLiveTask(config,{worker:async()=>{calls++;return response('print(42)\n');}});
  assert.equal(report.status,'completed',JSON.stringify(report));assert.equal(calls,1);
  assert.equal(report.sourcePreserved,true);assert.equal(report.baseline.status,'failed');
  assert.match(await readFile(report.patchPath,'utf8'),/\+print\(42\)/);
  assert.equal(await readFile(join(config.repo,'input.csv'),'utf8'),'status\nnot_run\n');
  await assert.rejects(runLiveTask(config,{worker:async()=>{calls++;}}),/STATE_EXISTS/);assert.equal(calls,1);
});

test('failed acceptance permits only one same-session correction',async()=>{
  const {config}=await fixture();const seen=[];
  const report=await runLiveTask(config,{worker:async request=>{seen.push(request);return response(seen.length===1?'print(1)\n':'print(42)\n');}});
  assert.equal(report.status,'completed',JSON.stringify(report));assert.equal(seen.length,2);
  assert.equal(seen[1].conversationId,'00000000-0000-4000-8000-000000000001');assert.match(seen[1].prompt,/test_result/);
});

test('unknown result retains intent and never resubmits',async()=>{
  const {config}=await fixture();let calls=0;
  const report=await runLiveTask(config,{worker:async()=>{calls++;throw new Error('TRANSPORT_UNKNOWN');}});
  assert.equal(report.status,'unknown');assert.equal(calls,1);assert.equal(report.patchPath,null);
  const receipt=JSON.parse(await readFile(join(config.stateDir,'attempt-1.json'),'utf8'));assert.equal(receipt.state,'sent_or_unknown');
});

test('invalid artifact output cannot touch the original or produce patch',async()=>{
  const {config}=await fixture();let calls=0;
  const report=await runLiveTask(config,{worker:async()=>{calls++;return {...response('x'),response:JSON.stringify({summary:'bad',files:[{path:'../source/input.csv',content:'changed'}]})};}});
  assert.equal(report.status,'failed');assert.equal(calls,1);assert.equal(report.patchPath,null);
  assert.equal(await readFile(join(config.repo,'input.csv'),'utf8'),'status\nnot_run\n');
});

test('completion requires every explicitly required created artifact',async()=>{
  const {config}=await fixture();config.createPaths.push('tests/test_task.py');
  const report=await runLiveTask(config,{worker:async()=>response('print(42)\n')});
  assert.equal(report.status,'failed');assert.equal(report.code,'REQUIRED_ARTIFACT_MISSING');assert.equal(report.patchPath,null);
});

test('the whole task deadline includes host validation and export',async()=>{
  const {config}=await fixture();config.totalTimeoutMs=1000;
  const report=await runLiveTask(config,{worker:async()=>{await new Promise(r=>setTimeout(r,1050));return response('print(42)\n');}});
  assert.equal(report.status,'failed');assert.equal(report.code,'LIVE_TIME_LIMIT');assert.equal(report.patchPath,null);
});
