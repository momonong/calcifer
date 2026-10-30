import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunState, readRunState } from './run-state.mjs';
import { GoalRequestGate, MOCK_POLICY, MODEL_ID } from './goal-request-gate.mjs';
import { installGoalBoundary, runSdkPhase } from './goal-sdk.mjs';
import { bindP1, p1Snapshot, p1Artifacts, createP1Tools } from './p1-workspace.mjs';
import { bindP1Runtime, runP1Check, p1CommandSettlement } from './p1-check.mjs';
import { readMockScript, startP1Mock } from './p1-mock.mjs';
import { digest, fail, hash, materializeSnapshot, readText, snapshotWorkspace, writeDurable } from './workspace-tools.mjs';

export const P1_TOOL_SCHEMA={type:'object',properties:{action:{type:'string',enum:['read','search','edit','create','check']},args:{type:'object'}},required:['action','args'],additionalProperties:false};
const provenance=Object.freeze({kind:'mock',actualModelRequests:0,modelQuality:'not_validated',p1b:'unstarted',fullResume:false});
const code=error=>/^[A-Z_0-9]+$/.test(error?.message)?error.message:'P1_WORKFLOW_FAILED';
const settled=e=>e?.sdkSettled&&e.toolsSettled&&e.transportSettled&&e.closed;

export async function runP1({repo,config:inputConfig,stateRoot,goal,harness,profile,mockScript,hostNodeBinary,signal}){
  if(!process.versions.bun)fail('PINNED_BUN_HOST_REQUIRED');
  const config=structuredClone(inputConfig),bound=await bindP1({repo,config,stateRoot,goal,harness,profile});
  const runtime=await bindP1Runtime(hostNodeBinary),fixture=await readMockScript(mockScript);
  const plan={kind:'p1-goal',goal},state=await createRunState({stateRoot,sourceDir:repo,metadata:{kind:'p1',stateRoot,repo,config,plan,planHash:digest(plan),authorityHash:bound.authorityHash,initialManifest:bound.initial.manifest,commands:bound.commands,acceptance:bound.acceptance,runtime,harness,profile,limits:bound.limits,startedAt:Date.now(),policy:MOCK_POLICY,mockScriptHash:fixture.scriptHash,provenance}});
  const checks=[];let mock,gate,phase,tools,sdk,status='failed',reason,artifacts=[],finalManifestHash,work,finalDir,sourcePreserved=null,boundary;
  let verificationSequence=0;
  const safeRecord=async(kind,operation)=>{const id=randomUUID();await state.append({type:'intent',data:{id,kind}});const result=await operation();await state.append({type:'completed',data:{id,resultHash:digest(result),...(kind==='command'?{processClosed:result?.process?.closed===true}:{})}});return result;};
  const checkSnapshot=async({snapshotDir,snapshot,definition,acceptancePath,stage,checkId})=>{
    if(signal?.aborted)fail('CHECK_CANCELLED_BEFORE_DISPATCH');
    const result=await safeRecord('command',()=>runP1Check({snapshotDir,manifest:snapshot.manifest,definition,runtime,acceptancePath,signal,maxOutputBytes:bound.limits.maxOutputBytes,stage,checkId}));
    const after=await p1Snapshot(snapshotDir,config,bound.limits);if(after.manifest.hash!==snapshot.manifest.hash)throw new Error('CHECK_MANIFEST_MISMATCH');
    checks.push(result);return result;
  };
  const stop=()=>{tools?.seal();if(phase)gate?.closePhase(phase.id);};signal?.addEventListener('abort',stop,{once:true});
  try{
    for(const name of ['host','native','checks'])await mkdir(join(state.runDir,name),{mode:0o700});
    await materializeSnapshot(join(state.runDir,'initial'),bound.initial);work=join(state.runDir,'work');await materializeSnapshot(work,bound.initial);
    const acceptancePath=join(state.runDir,'host','acceptance.mjs');await writeDurable(acceptancePath,bound.acceptanceContent,true);
    await writeDurable(join(state.runDir,'context.json'),JSON.stringify(bound.context),true);
    if(signal?.aborted)fail('CANCELLED_BEFORE_DISPATCH');
    mock=await startP1Mock({script:fixture.script,runID:state.metadata.runID});
    const nativeFetch=globalThis.fetch;
    gate=new GoalRequestGate({state,signal,endpoint:mock.endpoint,transport:async({payload,signal})=>{
      const response=await nativeFetch(mock.endpoint,{method:'POST',headers:{'content-type':'application/json','x-calcifer-mock-run':state.metadata.runID},body:JSON.stringify(payload),signal,redirect:'manual'});
      if(response.headers.get('x-calcifer-mock-run')!==state.metadata.runID)throw new Error('MOCK_HTTP_IDENTITY_MISMATCH');return response;
    }});
    boundary=await installGoalBoundary(gate,join(state.runDir,'host','isolation'));boundary.fetch='exact ephemeral loopback HTTP via durable gate';
    phase=gate.registerPhase({kind:'worker',taskId:'work',framework:harness,profileId:profile,model:MODEL_ID});
    tools=createP1Tools({root:work,config,limits:bound.limits,signal,admitted:()=>phase.open&&!gate.unknown,journal:event=>state.append(event),check:async checkId=>{
      const snapshot=await p1Snapshot(work,config,bound.limits),snapshotDir=join(state.runDir,'checks',String(++verificationSequence));await materializeSnapshot(snapshotDir,snapshot);
      return checkSnapshot({snapshotDir,snapshot,definition:bound.commands[checkId],stage:'worker',checkId});
    }});
    const sdkIntent=randomUUID();await state.append({type:'intent',data:{id:sdkIntent,kind:'sdk',harness,phaseId:phase.id}});
    try{sdk=await runSdkPhase({gate,phase,directory:join(state.runDir,'native','sdk'),prompt:JSON.stringify(bound.context),dispatch:tools.dispatch,signal,modelBaseURL:mock.endpoint.slice(0,-'/chat/completions'.length),toolSchema:P1_TOOL_SCHEMA,settlementMs:20000});}
    catch(error){sdk=error.evidence;reason=code(error);
      const refusal=gate.failures.findLast(f=>f.preDispatch&&/BUDGET_EXHAUSTED|WINDOW_EXHAUSTED/.test(f.code));if(refusal&&settled(sdk)&&!gate.unknown)reason=refusal.code;}
    tools.seal();await tools.drain();
    if(sdk)await writeDurable(join(state.runDir,'native.json'),JSON.stringify(sdk),true);
    if(settled(sdk)&&!gate.unknown)await state.append({type:'completed',data:{id:sdkIntent,resultHash:digest(sdk)}});
    if(gate.unknown||!settled(sdk))throw new Error('SDK_RESULT_UNKNOWN');
    if(signal?.aborted)fail('CANCELLED_AFTER_SETTLEMENT');
    if(reason)fail(reason);
    const final=await p1Snapshot(work,config,bound.limits);artifacts=p1Artifacts(bound.initial,final,config);finalManifestHash=final.manifest.hash;
    finalDir=join(state.runDir,'final');await materializeSnapshot(finalDir,final);
    // Reuse a matching check receipt; final acceptance is always host-owned.
    for(const [id,definition]of Object.entries(bound.commands))if(!checks.some(c=>c.checkId===id&&c.manifestHash===finalManifestHash&&c.definitionHash===definition.definitionHash))await checkSnapshot({snapshotDir:finalDir,snapshot:final,definition,stage:'final-project',checkId:id});
    if(checks.some(c=>c.manifestHash===finalManifestHash&&c.status!=='passed'))fail('PROJECT_CHECK_FAILED');
    if((await readText(join(state.runDir,'host'),'acceptance.mjs',{limits:bound.limits})).hash!==bound.acceptance.scriptHash)fail('ACCEPTANCE_SCRIPT_MISMATCH');
    const host=await checkSnapshot({snapshotDir:finalDir,snapshot:final,definition:bound.acceptance,acceptancePath,stage:'final-acceptance',checkId:'host-acceptance'});
    if(host.status!=='passed')fail('HOST_ACCEPTANCE_FAILED');
    const source=await snapshotWorkspace(repo,config.sourceFiles,{writablePaths:config.sourceFiles,limits:bound.limits,complete:true});sourcePreserved=source.manifest.hash===bound.initial.manifest.hash;if(!sourcePreserved)fail('SOURCE_PRESERVATION_MISMATCH');
    status='completed';
  }catch(error){reason=code(error);status=gate?.unknown?'unknown':signal?.aborted?'cancelled':'failed';}
  finally{
    signal?.removeEventListener('abort',stop);tools?.seal();try{await tools?.drain();}catch{status='unknown';reason='TOOL_OUTCOME_UNKNOWN';}
    if(mock)try{await mock.close();}catch{status='unknown';reason='MOCK_CLOSE_UNKNOWN';}
  }
  const saved=await readRunState({stateRoot,runID:state.metadata.runID});if(saved.unknown.length){status='unknown';reason??='UNSETTLED_INTENTS';}
  const wire={requests:gate?.wire??[],failures:gate?.failures??[],received:mock?.received??[],rejections:mock?.rejections??[]};
  await writeDurable(join(state.runDir,'wire.json'),JSON.stringify(wire),true);
  // Preserve tool/native evidence even if SDK/tool drain failed.
  if(sdk){try{await readText(state.runDir,'native.json',{limits:{maxFileBytes:2097152}});}catch(e){if(e.code==='ENOENT')await writeDurable(join(state.runDir,'native.json'),JSON.stringify(sdk),true);else throw e;}}
  const summary=status==='completed'
    ? `${harness}: host accepted ${artifacts.length} changed files (${artifacts.filter(a=>a.beforeHash===null).length} new). Final snapshot ${finalManifestHash}. Original source preserved. ${gate?.wire.length??0} HTTP mock requests; real model requests 0. P1-B unstarted.`
    : `${harness}: ${status} (${reason??'P1_WORKFLOW_FAILED'}). No accepted artifacts. Inspect saved checks and unresolved intents. HTTP mock only; real model requests 0. P1-B unstarted.`;
  await writeDurable(join(state.runDir,'summary.md'),summary+'\n',true);
  const processSettlement=p1CommandSettlement(saved.events);
  const toolRecords=sdk?.tools??[],readRecords=toolRecords.filter(t=>t.input?.action==='read');
  const report={schemaVersion:1,kind:'p1',status,code:reason,runID:state.metadata.runID,runDir:state.runDir,provenance,actualModelRequests:0,syntheticModelRequests:gate?.wire.length??0,integrationAccepted:status==='completed',summary,goal,harness,sourcePreserved,initialManifestHash:bound.initial.manifest.hash,finalManifestHash,artifacts:status==='completed'?artifacts:[],checks,sdk,
    evidence:{summaryHash:hash(summary+'\n'),wireHash:digest(wire),nativeHash:sdk?digest(sdk):null,contextHash:digest(bound.context)},http:{endpoint:mock?.endpoint,requests:mock?.received.length??0,closed:mock?.closed??true,rejections:mock?.rejections??[]},boundary,
    metrics:{toolCalls:tools?.calls??0,reads:readRecords.length,reReads:readRecords.filter((t,i)=>readRecords.slice(0,i).some(p=>p.input.args.path===t.input.args.path)).length,checks:checks.length,workerChecks:checks.filter(c=>c.stage==='worker').length,repeatedChecks:checks.filter((c,i)=>checks.slice(0,i).some(p=>p.checkId===c.checkId&&p.manifestHash===c.manifestHash)).length,humanInterventions:signal?.aborted?1:0,requests:gate?.wire.length??0,elapsedMs:Date.now()-state.metadata.startedAt},
    cancellation:{userStoppedWaiting:signal?.aborted??false,sdkSettled:sdk?.sdkSettled??false,toolProcessesClosed:processSettlement.allClosed,commandProcesses:processSettlement,transportSettled:sdk?.transportSettled??false,remoteInference:'not_applicable_mock'},remaining:status==='completed'?['P1-B model ability unvalidated','Full resume unimplemented']:['Work not accepted; inspect saved evidence','UNKNOWN must be reconciled outside this no-resume entry']};
  await state.finish(report);await state.release(status!=='unknown');return report;
}
