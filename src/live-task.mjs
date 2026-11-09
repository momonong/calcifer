import { mkdir, lstat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { runAgyWorker, AGY_MODEL } from './agy-worker.mjs';
import { bindPythonRuntime, runP1Check } from './p1-check.mjs';
import { gitDiff } from './artifact-diff.mjs';
import { p1Artifacts } from './p1-workspace.mjs';
import { digest, fail, hash, materializeSnapshot, pathList, readText, secureRoot, snapshotContents, writeDurable } from './workspace-tools.mjs';

const limits={maxFiles:64,maxFileBytes:65536,maxTotalBytes:524288,maxOutputBytes:32768};
const code=e=>/^[A-Z_0-9]+$/.test(e?.message)?e.message:'LIVE_TASK_FAILED';
const save=(dir,name,value,exclusive=false)=>writeDurable(join(dir,name),JSON.stringify(value,null,2)+'\n',exclusive);
async function snapshot(repo,paths){
  const contents={};pathList(paths);
  for(const path of [...paths].sort()){
    if(path.split('/').some(part=>part.startsWith('.')||part==='node_modules')||! /\.(py|csv|md|json|toml|lock)$/.test(path))fail('SOURCE_PATH_DENIED');
    contents[path]=(await readText(repo,path,{anyExtension:true,limits})).content;
  }
  return snapshotContents(contents,limits);
}

export function validateArtifacts(output,config,current){
  if(!output||Object.keys(output).sort().join(',')!=='files,summary'||typeof output.summary!=='string'||!Array.isArray(output.files)||!output.files.length||output.files.length>8)fail('ARTIFACT_FORMAT_INVALID');
  const seen=new Set(),contents={...current.contents};
  for(const f of output.files){
    if(!f||Object.keys(f).sort().join(',')!=='content,path'||typeof f.content!=='string'||f.content.includes('\0')||seen.has(f.path)||
      ![...config.createPaths,...config.writePaths].includes(f.path))fail('ARTIFACT_SCOPE_DENIED');
    seen.add(f.path);contents[f.path]=f.content;
  }
  return snapshotContents(contents,limits);
}

function validateConfig(c){
  if(c.schemaVersion!==1||c.model!==AGY_MODEL||typeof c.authorization!=='string'||!c.authorization.trim()||!c.quota||
    ![1,2].includes(c.maxAttempts)||!Number.isSafeInteger(c.totalTimeoutMs)||c.totalTimeoutMs<1000||c.totalTimeoutMs>1200000||
    typeof c.goal!=='string'||!c.goal.trim()||typeof c.rules!=='string'||!c.rules.trim()||typeof c.agyVersion!=='string')fail('LIVE_CONFIG_INVALID');
  for(const p of [c.repo,c.stateDir,c.acceptancePath])if(typeof p!=='string'||resolve(p)!==p)fail('LIVE_PATH_INVALID');
  if(c.stateDir===c.repo||c.stateDir.startsWith(c.repo+'/')||c.repo.startsWith(c.stateDir+'/')||c.acceptancePath.startsWith(c.repo+'/')||c.acceptancePath.startsWith(c.stateDir+'/'))fail('LIVE_ISOLATION_INVALID');
  for(const name of ['sourceFiles','contextFiles','writePaths','createPaths'])pathList(c[name]);
  if(c.sourceFiles.length+c.createPaths.length>limits.maxFiles||c.contextFiles.some(p=>!c.sourceFiles.includes(p))||c.writePaths.some(p=>!c.contextFiles.includes(p))||c.createPaths.some(p=>c.sourceFiles.includes(p)))fail('LIVE_SCOPE_INVALID');
  for(const p of [...c.writePaths,...c.createPaths])if(!/^(tools|tests)\/[A-Za-z0-9_-]+\.py$/.test(p))fail('LIVE_WRITE_PATH_DENIED');
  if(!Array.isArray(c.commands)||c.commands.length>2||c.commands.some(cmd=>JSON.stringify(cmd.argv)!==JSON.stringify(['-B','-m','unittest','discover','-s','tests'])||cmd.timeoutMs!==10000))fail('LIVE_COMMAND_DENIED');
}

export async function runLiveTask(config,{worker=runAgyWorker,signal}={}){
  const c=structuredClone(config);validateConfig(c);await secureRoot(c.repo);
  // mkdir is the durable one-run admission gate. Never remove/reuse after UNKNOWN.
  try{await mkdir(c.stateDir,{mode:0o700});}catch(e){if(e.code==='EEXIST')fail('STATE_EXISTS_RECONCILE_REQUIRED');throw e;}
  await secureRoot(c.stateDir);
  const startedAt=new Date().toISOString(),report={schemaVersion:1,status:'preparing',startedAt,modelRequested:c.model,
    harness:'agy-leaf-executor',provenance:{kind:worker===runAgyWorker?'live':'offline-test',opencodeValidated:false},
    attempts:[],checks:[],patchPath:null,sourcePreserved:null,remoteInference:'not_sent',actualProviderRequests:null,apiCost:null};
  const writeReport=()=>save(c.stateDir,'report.json',report);
  const remainingMs=()=>executionStarted===undefined?c.totalTimeoutMs:c.totalTimeoutMs-(Date.now()-executionStarted);
  const withinDeadline=()=>{if(remainingMs()<=0)fail('LIVE_TIME_LIMIT');};
  let initial,current,acceptance,runtime,executionStarted,conversationId;
  try{
    initial=await snapshot(c.repo,c.sourceFiles);current=initial;
    for(const path of c.createPaths){try{await lstat(join(c.repo,path));fail('CREATE_PATH_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
    acceptance=(await readText(dirname(c.acceptancePath),c.acceptancePath.split('/').at(-1),{anyExtension:true,limits}));
    runtime=await bindPythonRuntime('/usr/bin/python3.12');
    await save(c.stateDir,'config.json',c,true);await save(c.stateDir,'initial-manifest.json',initial.manifest,true);
    await materializeSnapshot(join(c.stateDir,'initial'),initial);
    await writeDurable(join(c.stateDir,'acceptance.py'),acceptance.content,true);
    const check=async(dir,snap,stage)=>{
      const checks=[];
      for(const [i,command] of [...c.commands,{argv:[],timeoutMs:10000}].entries()){
        withinDeadline();
        const host=i===c.commands.length,definition={...command,timeoutMs:Math.min(command.timeoutMs,remainingMs()),definitionHash:digest({...command,host,scriptHash:host?acceptance.hash:null})};
        const result=await runP1Check({snapshotDir:dir,manifest:snap.manifest,definition,runtime,
          acceptancePath:host?join(c.stateDir,'acceptance.py'):undefined,signal,maxOutputBytes:32768,stage,checkId:host?'host-acceptance':'project-tests'});
        report.checks.push(result);checks.push(result);
        withinDeadline();
        if(result.process.closed!==true)throw new Error('CHECK_SETTLEMENT_UNKNOWN');
        if(result.process.isolationError)fail('CHECK_ISOLATION_UNAVAILABLE');
      }
      return checks;
    };
    report.baseline=(await check(join(c.stateDir,'initial'),initial,'baseline')).at(-1);
    if(report.baseline.status!=='failed'||report.baseline.process.exitCode!==1)fail('BASELINE_EXPECTED_FAILURE_MISSING');
    await writeReport();
    const native=join(c.stateDir,'native');await mkdir(native,{mode:0o700});
    // This empty workspace is not the original repo. File/network/command tools are denied.
    const directory=join(native,'workspace');await mkdir(directory,{mode:0o700});
    let prompt=['Implement the requested Python change. Return ONLY a JSON object with exactly summary (string) and files (array of {path, content}).',
      'Return full UTF-8 file contents for the allowed paths. No markdown fences. You have no filesystem, command, network or MCP tools; all required context is below.',
      'Do not call tools, delegate, inspect other projects, or claim to have run tests. Calcifer will apply your files in an isolated snapshot and run protected tests.',
      `Allowed output paths: ${JSON.stringify([...c.writePaths,...c.createPaths])}`,c.rules,c.goal,
      ...c.contextFiles.map(path=>JSON.stringify({path,content:initial.contents[path]}))].join('\n\n');
    executionStarted=Date.now();
    for(let attempt=1;attempt<=c.maxAttempts;attempt++){
      if(signal?.aborted)fail('CANCELLED_BEFORE_DISPATCH');
      const remaining=c.totalTimeoutMs-(Date.now()-executionStarted);if(remaining<1000)fail('LIVE_TIME_LIMIT');
      const evidenceDir=join(native,`attempt-${attempt}`);await mkdir(evidenceDir,{mode:0o700});
      await writeDurable(join(evidenceDir,'prompt.txt'),prompt,true);
      const intent={state:'sent_or_unknown',attempt,conversationId:conversationId??null,promptHash:hash(prompt),model:c.model,at:new Date().toISOString()};
      await save(c.stateDir,`attempt-${attempt}.json`,intent,true);report.remoteInference='unknown';await writeReport();
      let outcome;
      try{outcome=await worker({prompt,directory,evidenceDir,model:c.model,expectedVersion:c.agyVersion,conversationId,timeoutMs:remaining,signal});}
      catch(error){report.status='unknown';report.code=code(error);report.unresolvedAttempt=attempt;report.cancellation={userStoppedWaiting:signal?.aborted??false,remoteInference:'unknown',receipt:error.receipt??null};break;}
      if(outcome.status!=='SUCCESS'||outcome.process?.closed!==true||outcome.process?.exitCode!==0||typeof outcome.response!=='string'||!outcome.conversation_id||conversationId&&outcome.conversation_id!==conversationId){report.status='unknown';report.code='LIVE_NATIVE_RESULT_UNKNOWN';break;}
      conversationId=outcome.conversation_id;report.remoteInference='cli_terminal_success';
      await save(evidenceDir,'result.json',outcome,true);
      await save(c.stateDir,`attempt-${attempt}.json`,{...intent,state:'completed',conversationId,resultHash:digest(outcome)});
      report.attempts.push({attempt,conversationId,usage:outcome.usage??null,actualModel:outcome.actualModel??null,version:outcome.version??c.agyVersion,tools:outcome.tools??[],durationSeconds:outcome.duration_seconds??null});
      let output;try{output=JSON.parse(outcome.response);}catch{fail('ARTIFACT_JSON_INVALID');}
      withinDeadline();
      current=validateArtifacts(output,c,current);p1Artifacts(initial,current,c);
      if(c.createPaths.some(path=>!Object.hasOwn(current.contents,path)))fail('REQUIRED_ARTIFACT_MISSING');
      const dir=join(c.stateDir,`candidate-${attempt}`);await materializeSnapshot(dir,current);
      const checks=await check(dir,current,`attempt-${attempt}`);
      if(checks.every(r=>r.status==='passed')){
        if(hash(await readFile(join(c.stateDir,'acceptance.py')))!==acceptance.hash)fail('ACCEPTANCE_CHANGED');
        const after=await snapshot(c.repo,c.sourceFiles);report.sourcePreserved=after.manifest.hash===initial.manifest.hash;
        if(!report.sourcePreserved)fail('SOURCE_CHANGED_DURING_RUN');
        const changes=p1Artifacts(initial,current,c);if(!changes.length)fail('NO_DELIVERABLE_CHANGES');
        const scratch=join(c.stateDir,'export');await mkdir(scratch,{mode:0o700});
        await materializeSnapshot(join(scratch,'a'),initial);await materializeSnapshot(join(scratch,'b'),current);await mkdir(join(scratch,'home'));
        const settlement={closed:false};const diff=await gitDiff(scratch,spawn,settlement);
        withinDeadline();
        if(diff.exitCode!==1||diff.patch.length===0)fail('PATCH_EMPTY');
        report.patchPath=join(c.stateDir,'thor.patch');await writeDurable(report.patchPath,diff.patch,true);
        Object.assign(report,{status:'completed',integrationAccepted:true,patchHash:hash(diff.patch),initialManifestHash:initial.manifest.hash,finalManifestHash:current.manifest.hash,
          finalDirectory:dir,changedFiles:changes.map(({path,beforeHash,afterHash})=>({path,beforeHash,afterHash})),summary:output.summary});break;
      }
      if(attempt===c.maxAttempts){report.status='failed';report.code='ACCEPTANCE_FAILED';break;}
      prompt=['The host tests failed on your delivered files. Correct only the authorized outputs. Return the same JSON format; no tools. Do not weaken tests or modify host acceptance.',
        JSON.stringify(checks.map(r=>({checkId:r.checkId,status:r.status,stdout:r.stdout,stderr:r.stderr})))].join('\n');
    }
  }catch(error){report.status=/UNKNOWN/.test(code(error))?'unknown':signal?.aborted?'cancelled':'failed';report.code=code(error);}
  if(initial && report.sourcePreserved===null){try{report.sourcePreserved=(await snapshot(c.repo,c.sourceFiles)).manifest.hash===initial.manifest.hash;}catch{report.sourcePreserved=false;}}
  report.finishedAt=new Date().toISOString();report.executionElapsedMs=executionStarted?Date.now()-executionStarted:0;
  report.taskExecutions=report.attempts.length+(report.unresolvedAttempt?1:0);
  await writeReport();return report;
}
