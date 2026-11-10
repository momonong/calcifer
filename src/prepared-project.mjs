import {join,isAbsolute} from 'node:path';
import {digest,fail,readText,writeDurable,relativePath} from './workspace-tools.mjs';
import {projectStatus} from './project-session.mjs';
import {canEditProject} from './project-profile.mjs';
import {MAX_PROJECT_CALLS} from './project-execution.mjs';

const binding=s=>({projectId:s.projectId,profileHash:digest(s.profile),routingHash:digest(s.routing)});
function validate(p){
 if(!p||p.schemaVersion!==1||typeof p.title!=='string'||!p.title.trim()||p.title.length>100||typeof p.task!=='string'||!p.task.trim()||Buffer.byteLength(p.task)>50000||typeof p.note!=='string'||!p.note.trim()||p.note.length>4000||!Number.isSafeInteger(p.maxTurns)||p.maxTurns<1||p.maxTurns>MAX_PROJECT_CALLS)fail('PREPARED_TASK_INVALID');
 const d=p.documents;
 if(d!==null&&(!d||!relativePath(d.source)||!d.source.endsWith('.md')||!isAbsolute(d.python??'')||!isAbsolute(d.renderer??'')||d.maxPages!==10||d.maxBytes!==20*1024*1024))fail('PREPARED_DOCUMENTS_INVALID');
}
export async function prepareProjectTask({stateDir,title,task,maxTurns,note,documents}){
 const current=await projectStatus({stateDir});
 if(current.pending)fail('PROJECT_PENDING');
 if(current.maxTurns!==null||current.turnsUsed||current.goal)fail('PREPARED_SESSION_ALREADY_USED');
 const p={schemaVersion:1,title,task,maxTurns,note,documents,binding:binding(current)};validate(p);
 if(!current.routing)fail(documents===null?'PREPARED_CODE_REQUIRES_ROUTING':'PREPARED_DOCUMENTS_REQUIRES_ROUTING');
 if(maxTurns<2)fail('GOAL_REQUIRES_PLANNER_AND_WORKER_BUDGET');
 if(documents!==null&&!canEditProject(documents.source,current.profile))fail('PREPARED_DOCUMENT_SCOPE');
 const record={...p,hash:digest(p)};
 await writeDurable(join(stateDir,'prepared-task.json'),JSON.stringify(record,null,2)+'\n',true);
 return record;
}
// Preserve frozen task bytes. Only a referenced, verified chain of call transfers
// can connect its original routing hash to the current resource allocation.
async function reallocationBindingMatches(stateDir,current,expected){
 try{
  let routingHash=digest(current.routing);
  for(const ref of [...(current.resourceAllocation?.reallocations??[])].reverse()){
   if(!/^[a-f0-9-]{36}$/.test(ref.id))return false;
   const receipt=JSON.parse((await readText(stateDir,`reallocation-${ref.id}.json`,{limits:{maxFileBytes:262144}})).content);
   if(digest(receipt)!==ref.hash||receipt.id!==ref.id||receipt.budgetId!==receipt.before.budget.id||receipt.after.routingHash!==routingHash||digest(receipt.after.routing)!==routingHash)return false;
   const {fromProfileId,toProfileId,calls}=receipt,prior=receipt.before.budget,routing=structuredClone(receipt.before.routing);
   if(!Number.isSafeInteger(calls)||calls<1||fromProfileId===toProfileId||![fromProfileId,toProfileId].every(id=>prior.allowedProfileIds.includes(id)))return false;
   const from=routing.profiles.find(p=>p.id===fromProfileId),to=routing.profiles.find(p=>p.id===toProfileId);
   if(!from||!to||calls>from.maxCalls-(prior.usedByProfile[fromProfileId]??0)||calls>prior.maxTurns-prior.used||prior.profileHash!==digest(current.profile))return false;
   from.maxCalls-=calls;to.maxCalls+=calls;
   if(digest(routing)!==routingHash)return false;
   routingHash=digest(receipt.before.routing);
   if(prior.routingHash!==routingHash)return false;
   if(routingHash===expected)return true;
  }
 }catch{return false;}
 return false;
}

export async function readPreparedTask({stateDir}){
 let content;
 try{content=(await readText(stateDir,'prepared-task.json',{limits:{maxFileBytes:131072}})).content;}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
 const {hash,...p}=JSON.parse(content);validate(p);
 if(hash!==digest(p))fail('PREPARED_TASK_CHANGED');
 const current=await projectStatus({stateDir});
 if(digest(p.binding)!==digest(binding(current))){
  const sameProject=digest({...p.binding,routingHash:digest(current.routing)})===digest(binding(current));
  if(!sameProject||!await reallocationBindingMatches(stateDir,current,p.binding.routingHash))fail('PREPARED_SCOPE_CHANGED');
 }
 if(!current.routing)fail(p.documents===null?'PREPARED_CODE_REQUIRES_ROUTING':'PREPARED_DOCUMENTS_REQUIRES_ROUTING');
 const correction=current.resourceAllocation?.preparedBudgetCorrection;
 if(correction){
  // Only an explicitly approved, source-bound authorization can repair the old
  // frozen one-call cap. Keep the original prepared bytes and hash unchanged.
  let receipt;
  try{
   if(!/^[a-f0-9-]{36}$/.test(correction.authorizationId))fail('PREPARED_SCOPE_CHANGED');
   receipt=JSON.parse((await readText(stateDir,`authorization-${correction.authorizationId}.json`,{limits:{maxFileBytes:262144}})).content);
   if(digest(receipt)!==correction.hash||receipt.id!==correction.authorizationId||p.maxTurns!==1||receipt.preparedBudgetCorrection?.previousMaxTurns!==1||receipt.preparedBudgetCorrection?.preparedTaskHash!==hash||receipt.profileHash!==p.binding.profileHash||receipt.routingHash!==p.binding.routingHash||receipt.note!==p.note||!Number.isSafeInteger(receipt.maxTurns)||receipt.maxTurns<2||receipt.maxTurns>MAX_PROJECT_CALLS)fail('PREPARED_SCOPE_CHANGED');
  }catch{fail('PREPARED_SCOPE_CHANGED');}
  return {...p,hash,effectiveMaxTurns:receipt.maxTurns};
 }
 return {...p,hash};
}
