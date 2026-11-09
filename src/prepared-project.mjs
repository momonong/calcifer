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
 if(documents!==null&&!canEditProject(documents.source,current.profile))fail('PREPARED_DOCUMENT_SCOPE');
 const record={...p,hash:digest(p)};
 await writeDurable(join(stateDir,'prepared-task.json'),JSON.stringify(record,null,2)+'\n',true);
 return record;
}
export async function readPreparedTask({stateDir}){
 let content;
 try{content=(await readText(stateDir,'prepared-task.json',{limits:{maxFileBytes:131072}})).content;}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
 const {hash,...p}=JSON.parse(content);validate(p);
 if(hash!==digest(p))fail('PREPARED_TASK_CHANGED');
 const current=await projectStatus({stateDir});
 if(digest(p.binding)!==digest(binding(current)))fail('PREPARED_SCOPE_CHANGED');
 if(!current.routing)fail(p.documents===null?'PREPARED_CODE_REQUIRES_ROUTING':'PREPARED_DOCUMENTS_REQUIRES_ROUTING');
 return {...p,hash};
}
