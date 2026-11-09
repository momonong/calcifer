// Stable CLI transport. Domain APIs, authorization and state transitions stay in
// the existing project modules; this module only selects and formats feedback.
export const safeText = value => String(value ?? '')
 .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,'[已隱藏私鑰]')
 .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g,'$1[已隱藏]@')
 .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
 .replace(/(Bearer\s+)[^\s]+/gi,'$1[已隱藏]')
 .replace(/(["'](?:api[_-]?key|token|password|secret|access[_-]?token|refresh[_-]?token)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi,'$1"[已隱藏]"')
 .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,'$1[已隱藏]')
 .replace(/\b(?:sk|AIza)[-_A-Za-z0-9]{16,}\b/g,'[已隱藏]');
function clean(value){
 if(typeof value==='string')return safeText(value);
 if(Array.isArray(value))return value.map(clean);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).map(([k,v])=>[k,/^(?:authorization|password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(k)?'[已隱藏]':clean(v)]));
 return value;
}
export function errorCode(error){
 const code=error?.reasonCode??error?.code;
 if(typeof code==='string'&&/^[A-Z][A-Z_0-9]+$/.test(code))return code;
 if(error?.name==='AbortError')return 'CANCELLED';
 return /^[A-Z][A-Z_0-9]+$/.test(error?.message??'')?error.message:'PROJECT_OPERATION_FAILED';
}
export function checkView(checks){
 return (checks??[]).map(c=>({stage:c.stage,checkId:c.checkId,status:c.status,code:c.code,stdout:c.stdout?.slice(0,12000),stderr:c.stderr?.slice(0,12000)}));
}
export function statusView(s){
 return {projectId:s.projectId,projectName:s.projectName,status:s.status,code:s.code,workspaceError:s.workspaceError??null,backend:s.backend,execution:s.execution,model:s.model,workspaceDir:s.workspaceDir,repo:s.repo,
  turnsUsed:s.turnsUsed,maxTurns:s.maxTurns,maxMinutes:s.maxMinutes,deadlineAt:s.deadlineAt,sourceMatches:s.sourceMatches,
  pending:s.pending?{taskId:s.pending.taskId,goalTaskId:s.pending.goalTaskId,phase:s.pending.phase,attempt:s.pending.attempt,startedAt:s.pending.startedAt}:null,
  cancellation:s.cancellation??null,
  routing:s.routing?{planner:s.routing.planner,profiles:s.routing.profiles?.map(p=>({id:p.id,execution:p.execution,enabled:p.enabled,available:p.available,maxCalls:p.maxCalls,resource:p.resource,expiresAt:p.expiresAt}))}:null,
  goal:s.goal?{id:s.goal.id,status:s.goal.status,code:s.goal.code,completedAt:s.goal.completedAt,assignments:s.goal.assignments?.map(a=>({taskId:a.taskId,profileId:a.profileId,execution:a.execution,reason:a.plannerReason}))}:null,
  lastTask:s.lastTask?{id:s.lastTask.id,status:s.lastTask.status,code:s.lastTask.code,attempts:s.lastTask.attempts}:null,
  response:typeof(s.lastResponse??s.lastTask?.response)==='string'?(s.lastResponse??s.lastTask.response).slice(0,20000):null,
  checks:s.lastChecks?{status:s.lastChecks.status,checkedAt:s.lastChecks.checkedAt,checks:checkView(s.lastChecks.checks)}:null,
  checksCurrent:Boolean(!s.pending&&s.lastChecks?.status==='passed'&&s.workspaceManifestHash&&s.lastChecks.manifestHash===s.workspaceManifestHash),
  files:s.files??[],changedFiles:s.changedFiles??[]};
}
export function operationView(r){
 return {status:r.status,code:r.code,taskId:r.taskId,attempts:r.attempts,response:typeof r.response==='string'?r.response.slice(0,20000):undefined,workspaceDir:r.workspaceDir,reused:r.reused,
  checks:r.checks?checkView(Array.isArray(r.checks)?r.checks:r.checks.checks):undefined,
  patchPath:r.patchPath,patchHash:r.patchHash,patchBytes:r.patchBytes,changedFiles:r.changedFiles,sourceMatches:r.sourceMatches,
  directory:r.directory,docxPath:r.docxPath,pdfPath:r.pdfPath,pages:r.pages,automatedChecks:r.automatedChecks,visualReview:r.visualReview,semanticReview:r.semanticReview,submitted:r.submitted};
}
export function nextActions(data,error){
 const code=error?.code??data?.code;
 if(data?.pending||data?.status==='unknown'||['PROJECT_PENDING','RESULT_UNKNOWN','PROJECT_OPERATION_UNKNOWN','CANCELLED'].includes(code))return ['recover'];
 if(code==='PROJECT_BUSY')return ['status'];
 if(['RESOURCE_LIMIT','AUTHORIZATION_REQUIRED','CONFIRMATION_REQUIRED'].includes(code))return ['status','authorize'];
 if(data?.goal?.status==='completed')return ['result','export'];
 if(data?.goal?.status==='failed')return ['status','resume'];
 if(data?.maxTurns===null||data?.maxTurns===0)return ['authorize'];
 return [];
}
export function createOutput({format,stdout,stderr}){
 let sequence=0;
 const write=value=>stdout.write(JSON.stringify(clean(value))+'\n');
 return {
  message(text=''){if(format==='jsonl')write({schemaVersion:1,type:'event',sequence:++sequence,event:'message',message:text});else (format==='json'?stderr:stdout).write(safeText(text)+'\n');},
  event(event,detail={}){if(format==='jsonl')write({schemaVersion:1,type:'event',sequence:++sequence,event,...detail});},
  result({command,project,stateDir,exitCode,data=null,error=null}){if(format!=='text')write({schemaVersion:1,type:'result',command,project:project??null,stateDir:stateDir??null,ok:exitCode===0,exitCode,data,error,nextActions:nextActions(data,error)});},
 };
}
