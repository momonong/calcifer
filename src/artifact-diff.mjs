import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { readRunState } from './run-state.mjs';
import { reopenRun } from './collaboration-runner.mjs';
import { reopenGoal } from './goal-runner.mjs';
import { boundedLimits, diffSnapshots, digest, fail, hash, pathList, secureRoot, snapshotWorkspace, writeDurable } from './workspace-tools.mjs';

const GIT='/usr/bin/git',MAX_PATCH_BYTES=1048576,MAX_STDERR_BYTES=8192,TIMEOUT_MS=2000;
const ARGS=['--no-pager','-c','core.quotePath=true','-c','core.attributesFile=/dev/null','-c','core.autocrlf=false',
  'diff','--no-index','--no-ext-diff','--no-textconv','--no-renames','--no-color','--text','--unified=3','--no-prefix','--diff-algorithm=myers','--no-indent-heuristic','--full-index','--','a','b'];
function accepted(state){
  if(state.status!=='completed'||state.report?.status!=='completed'||state.report.integrationAccepted!==true||state.unknown?.length)fail('EXPORT_REQUIRES_COMPLETED_ACCEPTED_RUN');
}
async function verifiedRun(options){
  const first=await readRunState(options);accepted(first);
  if(first.metadata.kind==='goal'){
    const goal=await reopenGoal(options);
    if(goal.status!=='completed'||goal.integrationAccepted!==true||goal.unknown?.length||goal.inner?.status!=='completed'||goal.inner.integrationAccepted!==true)fail('EXPORT_GOAL_INNER_MISMATCH');
    const inner=await reopenRun({stateRoot:join(first.runDir,'inner-state'),runID:goal.inner.runID});accepted(inner);
    if(digest(inner.report)!==digest(goal.inner))fail('EXPORT_GOAL_INNER_MISMATCH');
    return{...inner,runDir:join(first.runDir,'inner-state','runs',inner.metadata.runID),format:'goal'};
  }
  if(first.metadata.kind!==undefined||first.metadata.plan?.schemaVersion!==1||!Array.isArray(first.metadata.plan.tasks))fail('EXPORT_FORMAT_UNSUPPORTED');
  const state=await reopenRun(options);accepted(state);
  return{...state,runDir:first.runDir,format:'collaboration'};
}
async function verifiedChanges(state){
  const {metadata,report,runDir}=state;pathList(metadata.sourceFiles);pathList(metadata.allowedPaths);
  if(metadata.allowedPaths.some(path=>!metadata.sourceFiles.includes(path)))fail('EXPORT_SCOPE_MISMATCH');
  if(metadata.sourceFiles.some(path=>path.split('/').some(part=>['.git','.gitattributes'].includes(part.toLowerCase()))))fail('EXPORT_METADATA_PATH_REJECTED');
  const limits=boundedLimits(metadata.limits),options={writablePaths:metadata.sourceFiles,limits,complete:true};
  const before=await snapshotWorkspace(join(runDir,'initial'),metadata.sourceFiles,options),after=await snapshotWorkspace(join(runDir,'integration'),metadata.sourceFiles,options);
  if(digest(before.manifest)!==digest(metadata.initialManifest)||before.manifest.hash!==report.initialManifestHash||after.manifest.hash!==report.finalManifestHash)fail('EXPORT_MANIFEST_MISMATCH');
  const artifacts=diffSnapshots(before,after,metadata.allowedPaths);
  if(!Array.isArray(report.artifacts)||artifacts.length!==report.artifacts.length)fail('EXPORT_ARTIFACTS_MISMATCH');
  for(let index=0;index<artifacts.length;index++){
    const actual=report.artifacts[index],expected=artifacts[index];
    if(!actual||Object.keys(actual).sort().join(',')!=='afterHash,beforeHash,content,path'||Object.keys(expected).some(key=>actual[key]!==expected[key]))fail('EXPORT_ARTIFACTS_MISMATCH');
  }
  return{before,after,artifacts};
}
export function gitDiff(scratch,spawnGit,settlement){
  const env={PATH:'/usr/bin:/bin',LANG:'C',HOME:join(scratch,'home'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_ATTR_NOSYSTEM:'1',GIT_CEILING_DIRECTORIES:dirname(scratch),GIT_OPTIONAL_LOCKS:'0'};
  return new Promise((accept,reject)=>{
    let child;try{child=spawnGit(GIT,[...ARGS],{cwd:scratch,env,detached:true,stdio:['ignore','pipe','pipe']});}catch{settlement.closed=true;reject(new Error('EXPORT_GIT_SPAWN_FAILED'));return;}
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),overflow=false,timedOut=false,spawnError,killTimer;
    const kill=sig=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')spawnError=error.code;}};
    const stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),200);};
    const capture=stream=>bytes=>{
      const current=stream==='stdout'?stdout:stderr,limit=stream==='stdout'?MAX_PATCH_BYTES:MAX_STDERR_BYTES;
      const next=Buffer.concat([current,bytes.subarray(0,Math.max(0,limit-current.length))]);
      if(stream==='stdout')stdout=next;else stderr=next;
      if(bytes.length>limit-current.length&&!overflow){overflow=true;stop();}
    };
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));
    child.once('error',error=>{spawnError=error.code??'SPAWN_FAILED';});
    const timer=setTimeout(()=>{timedOut=true;stop();},TIMEOUT_MS);
    const watchdog=setTimeout(()=>{if(!settlement.closed)reject(new Error('EXPORT_GIT_SETTLEMENT_UNKNOWN'));},TIMEOUT_MS+1500);
    child.once('close',(exitCode,signal)=>{
      settlement.closed=true;clearTimeout(timer);clearTimeout(watchdog);clearTimeout(killTimer);
      if(spawnError)reject(new Error('EXPORT_GIT_SPAWN_FAILED'));
      else if(overflow)reject(new Error('EXPORT_PATCH_OUTPUT_LIMIT'));
      else if(timedOut)reject(new Error('EXPORT_GIT_TIMEOUT'));
      else if(signal||![0,1].includes(exitCode))reject(new Error('EXPORT_GIT_FAILED'));
      else accept({patch:stdout,exitCode});
    });
  });
}
// The optional host spawn seam is for bounded process-contract tests, never a CLI capability.
export async function exportArtifactDiff({stateRoot,runID},{spawnGit=spawn}={}){
  const state=await verifiedRun({stateRoot,runID}),changes=await verifiedChanges(state);
  try{await access(GIT,constants.X_OK);}catch{fail('EXPORT_GIT_UNAVAILABLE');}
  await secureRoot('/tmp');const scratch=await mkdtemp('/tmp/calcifer-export-'),settlement={closed:true};
  try{
    if(((await lstat(scratch)).mode&0o777)!==0o700)fail('EXPORT_SCRATCH_PERMISSIONS');
    for(const root of ['a','b','home'])await mkdir(join(scratch,root),{mode:0o700});
    for(const artifact of changes.artifacts)for(const[root,content,expectedHash]of [['a',changes.before.contents[artifact.path],artifact.beforeHash],['b',changes.after.contents[artifact.path],artifact.afterHash]]){
      if(hash(content)!==expectedHash)fail('EXPORT_ARTIFACTS_MISMATCH');
      const file=join(scratch,root,artifact.path);await mkdir(dirname(file),{recursive:true,mode:0o700});await writeDurable(file,content,true);
    }
    settlement.closed=false;const{patch,exitCode}=await gitDiff(scratch,spawnGit,settlement);
    if(changes.artifacts.length===0?(exitCode!==0||patch.length!==0):(exitCode!==1||patch.length===0))fail('EXPORT_GIT_RESULT_MISMATCH');
    return{patch,receipt:{schemaVersion:1,status:'exported',acceptanceScope:'verified-saved-content-artifacts',runFormat:state.format,
      initialManifestHash:changes.before.manifest.hash,finalManifestHash:changes.after.manifest.hash,changedFiles:changes.artifacts.length,patchBytes:patch.length,patchHash:hash(patch),noInferencePerformed:true}};
  }finally{if(settlement.closed)await rm(scratch,{recursive:true,force:true});}
}
