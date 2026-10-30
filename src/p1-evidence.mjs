import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { readRunState } from './run-state.mjs';
import { p1Snapshot, p1Artifacts } from './p1-workspace.mjs';
import { digest, fail, hash, readText, secureRoot, snapshotWorkspace, writeDurable } from './workspace-tools.mjs';
import { gitDiff } from './artifact-diff.mjs';
import { verifyP1CheckOutput } from './p1-check.mjs';

async function json(root,name){try{return JSON.parse((await readText(root,name,{anyExtension:true,limits:{maxFileBytes:2097152}})).content);}catch(e){if(e.code==='ENOENT')fail('EVIDENCE_MISSING');throw e;}}
async function availableInitial(runDir,metadata){
  const root=join(runDir,'initial'),expected=metadata.initialManifest.files;
  try{await secureRoot(root);}catch(error){if(error.code==='ENOENT')return{status:'absent',verifiedFiles:0,expectedFiles:expected.length};throw error;}
  const directories=new Set(expected.flatMap(file=>{const p=file.path.split('/');return p.slice(0,-1).map((_,i)=>p.slice(0,i+1).join('/'));}));
  let count=0;
  const walk=async(prefix='')=>{
    await secureRoot(join(root,prefix));
    for(const entry of await readdir(join(root,prefix),{withFileTypes:true})){
      const path=prefix?prefix+'/'+entry.name:entry.name;
      if(entry.isDirectory()&&directories.has(path)){await walk(path);continue;}
      const fixed=expected.find(file=>file.path===path);
      if(!fixed||!entry.isFile())fail('INITIAL_MANIFEST_MISMATCH');
      const actual=await readText(root,path,{writable:true,limits:metadata.limits});
      if(actual.hash!==fixed.hash||actual.bytes!==fixed.bytes)fail('INITIAL_MANIFEST_MISMATCH');count++;
    }
  };
  await walk();return{status:count===expected.length?'verified':'partial',verifiedFiles:count,expectedFiles:expected.length};
}
export async function reopenP1({stateRoot,runID}){
  const state=await readRunState({stateRoot,runID}),{metadata:m,report:r,runDir}=state;
  if(m.kind!=='p1'||(r&&r.kind!=='p1')||m.stateRoot!==stateRoot||m.authorityHash!==digest({repo:m.repo,stateRoot,config:m.config,harness:m.harness,profile:m.profile}))fail('P1_IDENTITY_MISMATCH');
  if(!r){
    const initialSnapshot=await availableInitial(runDir,m);
    return{schemaVersion:1,kind:'p1',runID,runDir,status:state.status,provenance:m.provenance,actualModelRequests:0,integrationAccepted:false,artifacts:[],checks:[],sourcePreserved:null,initialSnapshot,reportMissing:true,reopenedWithoutSDK:true,savedSourceOnly:true,unknown:state.unknown,unverified:['No terminal report; unfinished evidence and process state remain unverified'],remaining:['Read-only inspection only; no resume or automatic reconciliation']};
  }
  const initial=await snapshotWorkspace(join(runDir,'initial'),m.config.sourceFiles,{writablePaths:m.config.sourceFiles,limits:m.limits,complete:true});
  if(digest(initial.manifest)!==digest(m.initialManifest)||initial.manifest.hash!==r.initialManifestHash)fail('INITIAL_MANIFEST_MISMATCH');
  const summary=await readText(runDir,'summary.md',{limits:{maxFileBytes:8192}});if(summary.hash!==r.evidence.summaryHash||summary.content!==r.summary+'\n')fail('SUMMARY_EVIDENCE_MISMATCH');
  const context=await json(runDir,'context.json');if(digest(context)!==r.evidence.contextHash)fail('CONTEXT_EVIDENCE_MISMATCH');
  const wire=await json(runDir,'wire.json');if(digest(wire)!==r.evidence.wireHash||wire.requests.length!==r.syntheticModelRequests||wire.received.length!==r.http.requests)fail('WIRE_EVIDENCE_MISMATCH');
  if(r.sdk){const native=await json(runDir,'native.json');if(digest(native)!==r.evidence.nativeHash||digest(native)!==digest(r.sdk))fail('SDK_EVIDENCE_MISMATCH');}
  for(const request of wire.requests){
    const intent=state.events.find(e=>e.type==='intent'&&e.data.id===request.id)?.data;
    if(intent?.kind!=='model'||intent.payloadHash!==digest(request.adapted)||request.url!==r.http.endpoint)fail('WIRE_INTENT_MISMATCH');
  }
  for(const received of wire.received){
    const request=wire.requests[received.index];if(!request||received.runID!==runID||received.bodyHash!==hash(JSON.stringify(request.adapted))||digest(received.body)!==digest(request.adapted))fail('HTTP_EVIDENCE_MISMATCH');
  }
  const acceptance=await readText(join(runDir,'host'),'acceptance.mjs',{limits:m.limits});if(acceptance.hash!==m.acceptance.scriptHash)fail('ACCEPTANCE_SCRIPT_MISMATCH');
  for(const check of r.checks){
    verifyP1CheckOutput(check);
    const definition=check.stage==='final-acceptance'?m.acceptance:m.commands[check.checkId];
    if(!definition||check.definitionHash!==definition.definitionHash||check.runtimeHash!==digest(m.runtime)||check.process?.closed!==true)fail('CHECK_EVIDENCE_MISMATCH');
    if(!state.events.some(e=>e.type==='completed'&&e.data.resultHash===digest(check)))fail('CHECK_RECEIPT_MISMATCH');
    const p=check.process,passed=p.exitCode===0&&p.signal===null&&!p.spawnError&&!p.outputLimit&&!p.cancelled&&!p.isolationError;
    if(check.status!==(passed?'passed':'failed'))fail('CHECK_COMPARISON_MISMATCH');
  }
  if(r.status==='completed'){
    if(state.unknown.length||r.integrationAccepted!==true||r.sourcePreserved!==true||!r.sdk?.sdkSettled||!r.sdk?.transportSettled||!r.sdk?.toolsSettled||!r.sdk?.closed||r.http.closed!==true)fail('ACCEPTANCE_EVIDENCE_MISMATCH');
    const final=await p1Snapshot(join(runDir,'final'),m.config,m.limits);
    if(final.manifest.hash!==r.finalManifestHash||digest(p1Artifacts(initial,final,m.config))!==digest(r.artifacts))fail('ARTIFACT_MANIFEST_MISMATCH');
    const finalChecks=r.checks.filter(c=>c.manifestHash===r.finalManifestHash);
    if(finalChecks.some(c=>c.status!=='passed')||!finalChecks.some(c=>c.stage==='final-acceptance'&&c.status==='passed')||Object.keys(m.commands).some(id=>!finalChecks.some(c=>c.checkId===id&&c.status==='passed')))fail('FINAL_ACCEPTANCE_MISMATCH');
  }else if(r.integrationAccepted||r.artifacts.length)fail('UNACCEPTED_ARTIFACTS_MISMATCH');
  return{...r,reopenedWithoutSDK:true,savedSourceOnly:true,unknown:state.unknown};
}
export async function exportP1(options){
  const r=await reopenP1(options);
  if(r.status!=='completed'||!r.integrationAccepted||r.unknown.length)fail('EXPORT_REQUIRES_COMPLETED_ACCEPTED_RUN');
  const scratch=await mkdtemp('/tmp/calcifer-p1-export-'),settlement={closed:true};
  try{
    for(const dir of ['a','b','home'])await mkdir(join(scratch,dir),{mode:0o700});
    const {metadata:m}=await readRunState(options),before=await snapshotWorkspace(join(r.runDir,'initial'),m.config.sourceFiles,{writablePaths:m.config.sourceFiles,limits:m.limits,complete:true});
    for(const artifact of r.artifacts){
      for(const [directory,content]of [['a',artifact.beforeHash===null?null:before.contents[artifact.path]],['b',artifact.content]]){
        if(content===null)continue;const target=join(scratch,directory,artifact.path);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeDurable(target,content,true);
      }
    }
    settlement.closed=false;const {patch,exitCode}=await gitDiff(scratch,spawn,settlement);
    if(r.artifacts.length?(exitCode!==1||!patch.length):(exitCode!==0||patch.length))fail('PATCH_RESULT_MISMATCH');
    return{patch,receipt:{schemaVersion:1,status:'exported',runID:r.runID,patchHash:hash(patch),patchBytes:patch.length,changedFiles:r.artifacts.length,initialManifestHash:r.initialManifestHash,finalManifestHash:r.finalManifestHash,noInferencePerformed:true,newFiles:r.artifacts.filter(a=>a.beforeHash===null).map(a=>a.path)}};
  }finally{if(settlement.closed)await rm(scratch,{recursive:true,force:true});}
}
