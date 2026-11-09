import {mkdir,readFile,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {secureRoot,writeDurable} from './workspace-tools.mjs';

export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const commandId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const fail=code=>{throw Error(code);}, now=()=>new Date().toISOString();
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const ACTIVE=new Set(['running','cancel_requested']);
const MODEL=new Set(['work','resume']);
const safeError=e=>/^[A-Z][A-Z0-9_]{1,80}$/.test(e?.message)?e.message:'REMOTE_OPERATION_FAILED';
const text=v=>typeof v==='string'?v.slice(0,65536):null;
export function projectView(s){
 const scope={projectId:s.projectId,profile:s.profile,execution:s.execution,routing:s.routing};
 return{projectId:s.projectId,projectName:s.projectName,status:s.status,code:s.code??null,model:s.model,backend:s.backend,
   execution:s.execution,routing:s.routing,profile:s.profile,scopeHash:fingerprint(scope),
   turnsUsed:s.turnsUsed,maxTurns:s.maxTurns,maxMinutes:s.maxMinutes,deadlineAt:s.deadlineAt,
   goal:s.goal?{id:s.goal.id,status:s.goal.status,task:text(s.goal.task),assignments:s.goal.assignments,code:s.goal.code}:null,
   pending:Boolean(s.pending),remoteCommandId:s.remoteCommandId??null,cancellation:s.cancellation??null,
   lastTask:s.lastTask?{id:s.lastTask.id,status:s.lastTask.status,task:text(s.lastTask.task),response:text(s.lastTask.response)}:null,
   changedFiles:s.changedFiles??[],sourceMatches:s.sourceMatches??null};
}
function resultView(r){return{status:r.status??'completed',code:r.code??null,response:text(r.response??r.lastTask?.response),
 checks:(r.checks??[]).map(c=>({stage:c.stage,status:c.status,code:c.code,stdout:text(c.stdout),stderr:text(c.stderr)})),
 cancellation:r.cancellation??null,...(r.patchHash?{patchHash:r.patchHash}:{}),...(r.reused!==undefined?{reused:r.reused}:{})};}
function validateCommand(c,projects){
 if(!object(c)||!commandId(c.id)||Object.keys(c).some(k=>!['id','project','action','input'].includes(k)))fail('COMMAND_INVALID');
 if(!projects.has(c.project))fail('PROJECT_NOT_REGISTERED');
 const fields={work:['task'],resume:[],test:[],recover:[],export:[],authorize:['maxTurns','maxMinutes','note','scopeHash'],abandon:['note']}[c.action];
 if(!fields||!object(c.input)||Object.keys(c.input).some(k=>!fields.includes(k)))fail('COMMAND_INVALID');
 if(c.action==='work'&&(typeof c.input.task!=='string'||!c.input.task.trim()||Buffer.byteLength(c.input.task)>16384))fail('COMMAND_INVALID');
 if(['authorize','abandon'].includes(c.action)&&(typeof c.input.note!=='string'||!c.input.note.trim()||c.input.note.length>4096))fail('COMMAND_INVALID');
 if(c.action==='authorize'&&(!Number.isInteger(c.input.maxTurns)||c.input.maxTurns<1||c.input.maxTurns>8||
   !(c.input.maxMinutes===null||Number.isInteger(c.input.maxMinutes)&&c.input.maxMinutes>0&&c.input.maxMinutes<=35791)||!/^[a-f0-9]{64}$/.test(c.input.scopeHash)))fail('COMMAND_INVALID');
}
async function lock(root){
 const p=spawn('/usr/bin/flock',['--exclusive','--nonblock','-E','73',join(root,'remote.lock'),process.execPath,'-e',"process.stdout.write('locked');process.stdin.resume()"],{stdio:['pipe','pipe','ignore']});
 await new Promise((ok,no)=>{p.once('error',no);p.once('exit',()=>no(Error('REMOTE_ALREADY_RUNNING')));p.stdout.once('data',ok);});
 return async()=>{p.stdin.end();if(p.exitCode===null)await new Promise(r=>p.once('exit',r));};
}

export async function openController({stateDir,projects,api}){
 if(resolve(stateDir)!==stateDir||!Array.isArray(projects)||!projects.length||projects.length>32)fail('REMOTE_CONFIG_INVALID');
 const registry=new Map();for(const p of projects){if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id)||registry.has(p.id)||resolve(p.stateDir)!==p.stateDir)fail('REMOTE_CONFIG_INVALID');registry.set(p.id,p);}
 if(new Set(projects.map(p=>p.stateDir)).size!==projects.length)fail('REMOTE_CONFIG_INVALID');
 await mkdir(stateDir,{recursive:true,mode:0o700});await secureRoot(stateDir);
 const info=await lstat(stateDir);if(info.uid!==process.getuid()||(info.mode&0o077))fail('REMOTE_STATE_PERMISSIONS');
 const unlock=await lock(stateDir),path=join(stateDir,'remote.json');
 let data={version:1,cursor:0,commands:{},events:[]},chain=Promise.resolve(),fault=null,closing=false,sealed=false;
 const listeners=new Set(),running=new Map(),statuses=new Map();
 const event=(draft,c,kind,detail={})=>{draft.events.push({seq:++draft.cursor,id:c.id,project:c.project,kind,at:now(),...detail});draft.events=draft.events.slice(-2000);};
 const commit=fn=>{
  if(sealed)return Promise.reject(Error('REMOTE_CLOSED'));if(fault)return Promise.reject(fault);
  const promise=chain.then(async()=>{if(sealed)fail('REMOTE_CLOSED');if(fault)throw fault;const next=structuredClone(data);const value=fn(next);await writeDurable(path,JSON.stringify(next));data=next;for(const cb of listeners){try{cb(data.cursor);}catch{}}return structuredClone(value);});
  chain=promise.catch(e=>{if(['REMOTE_CLOSED','COMMAND_CONFLICT','PROJECT_UNKNOWN','COMMAND_LIMIT','COMMAND_NOT_FOUND','PROJECT_BUSY'].includes(e.message))return;fault=e;});
  return promise;
 };
 const refresh=async id=>{try{statuses.set(id,projectView(await api.projectStatus({stateDir:registry.get(id).stateDir})));}catch(e){statuses.set(id,{status:'unavailable',code:safeError(e)});}};
 try{
  try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.size>134217728)fail('REMOTE_STATE_INVALID');data=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  if(data.version!==1||!Number.isSafeInteger(data.cursor)||!object(data.commands)||!Array.isArray(data.events))fail('REMOTE_STATE_INVALID');
  for(const [id,c] of Object.entries(data.commands)){if(!commandId(id)||id!==c.id||!registry.has(c.project))fail('REMOTE_STATE_INVALID');}
  await commit(draft=>{for(const c of Object.values(draft.commands))if(ACTIVE.has(c.status)){c.status='unknown';c.error='HOST_RESTARTED';event(draft,c,'unknown');}});
  await Promise.all(projects.map(p=>refresh(p.id)));
 }catch(e){await unlock();throw e;}
 const unknown=project=>Object.values(data.commands).some(c=>c.project===project&&c.status==='unknown');
 const run=async id=>{
  let c=data.commands[id];const abort=new AbortController();running.set(c.project,{id,abort,promise:null});
  await commit(d=>{const r=d.commands[id];r.status='running';r.startedAt=now();event(d,r,'running');});
  c=data.commands[id];const p=registry.get(c.project),args={stateDir:p.stateDir,signal:abort.signal,operationId:id,
   onEvent:e=>{const kind=e?.event;if(!['dispatch','route','checks'].includes(kind))return;
    commit(d=>event(d,d.commands[id],kind,{model:e.model??e.execution?.model??null,effort:e.effort??e.execution?.effort??null,used:e.used??null,max:e.max??null})).catch(()=>{});}};
  const work=(async()=>{
   try{
    let result;
    switch(c.action){
     case 'work':result=await api.workProject({...args,task:c.input.task});break;
     case 'resume':result=await api.resumeProjectGoal(args);break;
     case 'test':result=await api.testProject(args);break;
     case 'recover':result=await api.reconcileProject(args);break;
     case 'export':result=await api.exportProject(args);break;
     case 'abandon':result=await api.abandonProjectGoal({...args,note:c.input.note});break;
     case 'authorize':{
      const current=projectView(await api.projectStatus(args));if(current.scopeHash!==c.input.scopeHash)fail('AUTHORIZATION_SCOPE_CHANGED');
      result=await api.authorizeProject({...args,maxTurns:c.input.maxTurns,maxMinutes:c.input.maxMinutes,note:c.input.note});break;
     }
    }
    const recovered=new Map();
    if(c.action==='recover'&&!result.pending&&result.status!=='unknown'&&api.recoverRemoteOperation){
     for(const prior of Object.values(data.commands))if(prior.project===c.project&&prior.status==='unknown'){
      const outcome=await api.recoverRemoteOperation({stateDir:p.stateDir,operationId:prior.id,action:prior.action});
      if(outcome.status!=='unknown')recovered.set(prior.id,outcome);
     }
    }
    await refresh(c.project);
    await commit(d=>{
     const r=d.commands[id];r.status=result.status==='unknown'?'unknown':['failed','rejected','cancelled'].includes(result.status)?result.status:'completed';
     r.result=resultView(result);r.finishedAt=now();if(result.patchPath)r.artifact={path:result.patchPath,hash:result.patchHash};event(d,r,r.status);
     if(c.action==='recover'&&!result.pending&&result.status!=='unknown'){
      for(const [priorId,outcome] of recovered){const prior=d.commands[priorId];prior.status=['failed','rejected','cancelled'].includes(outcome.status)?outcome.status:'completed';prior.recovered=true;prior.result=resultView(outcome);prior.finishedAt=now();if(outcome.patchPath)prior.artifact={path:outcome.patchPath,hash:outcome.patchHash};event(d,prior,'recovered');}
      for(const prior of Object.values(d.commands))if(prior.project===c.project&&prior.status==='unknown'&&MODEL.has(prior.action)&&result.remoteCommandId===prior.id&&result.lastTask?.remoteCommandId===prior.id&&['completed','failed'].includes(result.lastTask.status)){
       prior.status=result.lastTask.status==='completed'&&(!result.routing||result.goal?.status==='completed')?'completed':'failed';
       prior.recovered=true;prior.result=resultView({status:prior.status,response:result.lastTask.response,code:result.routing&&result.goal?.status!=='completed'?'GOAL_REQUIRES_RESUME':result.lastTask.code??result.code});prior.finishedAt=now();event(d,prior,'recovered');
      }
     }
    });
   }catch(e){
    if(!sealed){await refresh(c.project);await commit(d=>{const r=d.commands[id];r.status=statuses.get(c.project)?.pending||MODEL.has(c.action)&&!e.known?'unknown':'failed';r.error=safeError(e);r.finishedAt=now();event(d,r,r.status);}).catch(()=>{});}
   }finally{running.delete(c.project);if(!closing&&!sealed&&!fault)queueMicrotask(pump);}
  })();running.get(c.project).promise=work;
 };
 function pump(){
  if(closing||sealed||fault)return;
  for(const project of registry.keys()){
   if(running.has(project))continue;
   const choices=Object.values(data.commands).filter(c=>c.project===project&&c.status==='queued');
   const next=choices.find(c=>!unknown(project)||c.action==='recover');if(next)run(next.id).catch(e=>{fault=e;});
  }
 }
 const publicCommand=c=>{if(!c)return null;const {artifact,...rest}=c;return structuredClone({...rest,hasPatch:Boolean(artifact)});};
 const controller={
  async sync(){await Promise.all(projects.map(p=>refresh(p.id)));return controller.snapshot();},
  snapshot:()=>({cursor:data.cursor,closing,storageHealthy:!fault,projects:projects.map(p=>({id:p.id,label:p.label??p.id,status:structuredClone(statuses.get(p.id))})),commands:Object.values(data.commands).slice(-200).map(publicCommand)}),
  command:id=>publicCommand(data.commands[id]),
  artifact:id=>data.commands[id]?.status==='completed'?structuredClone(data.commands[id].artifact??null):null,
  project:id=>registry.get(id),
  events:after=>({reset:after>data.cursor||after<(data.events[0]?.seq??1)-1,cursor:data.cursor,events:structuredClone(data.events.filter(e=>e.seq>after))}),
  subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb);},
  async submit(input){
   if(closing||sealed)fail('REMOTE_CLOSED');validateCommand(input,registry);const payloadHash=fingerprint(input);
   const receipt=await commit(d=>{
    if(d.commands[input.id]){if(d.commands[input.id].payloadHash!==payloadHash)fail('COMMAND_CONFLICT');return d.commands[input.id];}
    if(Object.keys(d.commands).length>=10000)fail('COMMAND_LIMIT');
    if(Object.values(d.commands).some(c=>c.project===input.project&&c.status==='unknown')&&input.action!=='recover')fail('PROJECT_UNKNOWN');
    if(Object.values(d.commands).filter(c=>c.project===input.project&&c.status==='queued').length>=8)fail('PROJECT_BUSY');
    const c={...structuredClone(input),payloadHash,status:'queued',createdAt:now()};d.commands[c.id]=c;event(d,c,'accepted');return c;
   });queueMicrotask(pump);return publicCommand(receipt);
  },
  async cancel(id){
   await commit(d=>{const c=d.commands[id];if(!c)fail('COMMAND_NOT_FOUND');if(c.status==='queued'){c.status='cancelled';c.finishedAt=now();event(d,c,'cancelled');}else if(c.status==='running'){c.status='cancel_requested';c.cancelRequestedAt=now();event(d,c,'cancel_requested');}});
   const c=data.commands[id];if(running.get(c.project)?.id===id)running.get(c.project).abort.abort();return publicCommand(c);
  },
  async close({waitMs=10000}={}){
   if(sealed)return;closing=true;for(const r of running.values())r.abort.abort();
   let timer;await Promise.race([Promise.allSettled([...running.values()].map(r=>r.promise)),new Promise(r=>{timer=setTimeout(r,waitMs);})]);clearTimeout(timer);
   await commit(d=>{for(const c of Object.values(d.commands))if(ACTIVE.has(c.status)){c.status='unknown';c.error='HOST_STOPPED';event(d,c,'unknown');}}).catch(()=>{});
   sealed=true;listeners.clear();await unlock();
  }
 };
 queueMicrotask(pump);return controller;
}
