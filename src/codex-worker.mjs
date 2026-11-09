import { spawn, spawnSync } from 'node:child_process';
import { access, open, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hash, relativePath, secureFile, secureRoot, writeDurable } from './workspace-tools.mjs';

import { EXECUTIONS, EXECUTION_MODELS, EXECUTION_EFFORTS, MAX_EXECUTION_TIMEOUT_MS } from './project-execution.mjs';

export const CODEX_MODEL=EXECUTIONS.codex.model;
export const CODEX_VERSION=EXECUTIONS.codex.version;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTECTED=['AGENTS.md','.git','.agents','.codex','.aws'];
const EFFORT_EVIDENCE='requested-only: pinned CLI reasoning effort; native exec JSONL does not attest actual effort';
const MODEL_EVIDENCE='requested-only: pinned CLI --model; native exec JSONL does not attest actual model';
const rejectInput=code=>{throw new Error(code);};
const toml=value=>typeof value==='object' && value!==null
  ? `{ ${Object.entries(value).map(([key,item])=>`${JSON.stringify(key)} = ${toml(item)}`).join(', ')} }`
  : JSON.stringify(value);

function validate({directory,model,effort=EXECUTIONS.codex.effort,conversationId,writeRoots=[],readOnlyPaths=[]}) {
  if(typeof directory!=='string'||!isAbsolute(directory)||resolve(directory)!==directory||directory==='/')rejectInput('CODEX_DIRECTORY_INVALID');
  if(!EXECUTION_MODELS.codex.includes(model))rejectInput('CODEX_MODEL_INVALID');
  if(!EXECUTION_EFFORTS.includes(effort))rejectInput('CODEX_EFFORT_INVALID');
  if(conversationId!=null&&!UUID.test(conversationId))rejectInput('CODEX_SESSION_INVALID');
  if(!Array.isArray(writeRoots)||new Set(writeRoots).size!==writeRoots.length)rejectInput('CODEX_ROOTS_INVALID');
  for(const root of writeRoots)if(typeof root!=='string'||!root||/[\\:\x00-\x1f\x7f*?\[\]]/.test(root)||root.split('/').some(part=>!part||part==='.'||part==='..'||part.startsWith('.')||PROTECTED.includes(part)))rejectInput('CODEX_ROOTS_INVALID');
  if(!Array.isArray(readOnlyPaths)||readOnlyPaths.length>256||new Set(readOnlyPaths).size!==readOnlyPaths.length||readOnlyPaths.some(path=>!relativePath(path)))rejectInput('CODEX_READ_ONLY_PATHS_INVALID');
}
function configArgs(options) {
  validate(options);
  const scoped={'.':'read'};
  for(const root of options.writeRoots??[])scoped[root]='write';
  for(const root of ['',...(options.writeRoots??[])])for(const path of PROTECTED)scoped[root?`${root}/${path}`:path]='read';
  for(const path of options.readOnlyPaths??[])scoped[path]='read';
  // Explicit protections avoid inherited temp write roots and Linux parent deny masks.
  // The sandbox may create private shadow scratch paths; only supplied roots bind host writes.
  const profile={workspace_roots:{[options.directory]:true},filesystem:{':root':'deny',':minimal':'read',':workspace_roots':scoped},network:{enabled:false}};
  const configs=[
    'default_permissions="calcifer"',`permissions.calcifer=${toml(profile)}`,
    'approval_policy="never"','forced_login_method="chatgpt"','model_provider="openai"',
    `model_reasoning_effort=${JSON.stringify(options.effort??EXECUTIONS.codex.effort)}`,
    'web_search="disabled"','features.multi_agent=false','features.apps=false','features.plugins=false',
    'features.remote_plugin=false','features.hooks=false','features.memories=false',
    'shell_environment_policy.inherit="none"','shell_environment_policy.set.PATH="/usr/bin:/bin"',
  ];
  return configs.flatMap(value=>['-c',value]);
}
export function buildCodexArgs(options) {
  const configs=configArgs(options);
  return ['--no-daemon','-C',options.directory,...configs,'exec',...(options.conversationId?['resume']:[]),
    '--ignore-user-config','--strict-config','--json','--skip-git-repo-check','--model',options.model,
    ...(options.conversationId?[options.conversationId]:[]),'-'];
}
async function discover(executable) {
  if(executable!==undefined)return realpath(executable);
  for(const directory of (process.env.PATH??'').split(':').filter(Boolean)) {
    if(!isAbsolute(directory))continue;
    const candidate=join(directory,'codex');
    try{await access(candidate,constants.X_OK);return await realpath(candidate);}catch(error){if(!['ENOENT','ENOTDIR','EACCES'].includes(error.code))throw error;}
  }
  throw Object.assign(new Error('CODEX_EXECUTABLE_NOT_FOUND'),{code:'ENOENT'});
}
function readonly(binary,args,env,cwd,deadline) {
  const remaining=deadline===null?10000:deadline-Date.now();
  if(remaining<1)rejectInput('CODEX_DEADLINE_BEFORE_SEND');
  const result=spawnSync(binary,args,{env,cwd,encoding:'utf8',timeout:Math.min(10000,remaining),maxBuffer:32768,stdio:['ignore','pipe','pipe']});
  if(result.error||result.status!==0)throw Object.assign(new Error('CODEX_PREFLIGHT_FAILED'),{preflight:{exitCode:result.status??null,signal:result.signal??null,kind:result.error?.code??'CONFIG_OR_SANDBOX',stderrHash:hash(result.stderr??'')}});
  return result;
}

// One public CLI turn. Ambiguous completion is durable UNKNOWN, never retried here.
export async function runCodexWorker({prompt,directory,evidenceDir,model=CODEX_MODEL,effort=EXECUTIONS.codex.effort,expectedVersion=CODEX_VERSION,
  conversationId,timeoutMs=null,signal,onEvent,writeRoots=[],readOnlyPaths=[],executable}) {
  const deadline=timeoutMs===null?null:Date.now()+timeoutMs;
  const options={directory,model,effort,conversationId,writeRoots,readOnlyPaths};
  const env={HOME:homedir(),PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TERM:'dumb',NO_COLOR:'1'};
  let binary,binaryHash,version,args,log;
  try {
    validate(options);
    if(typeof prompt!=='string'||!prompt.trim()||(timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>MAX_EXECUTION_TIMEOUT_MS)))rejectInput('CODEX_PROFILE_INVALID');
    if(signal?.aborted)rejectInput('CODEX_CANCELLED_BEFORE_SEND');
    await secureRoot(directory);await secureRoot(evidenceDir);
    for(const root of writeRoots)await secureRoot(join(directory,root));
    for(const path of readOnlyPaths)await secureFile(directory,path);
    binary=await discover(executable);binaryHash=hash(await readFile(binary));
    version=readonly(binary,['--version'],env,directory,deadline).stdout.trim();
    if(version!==`codex-cli ${expectedVersion}`&&version!==expectedVersion)rejectInput('CODEX_VERSION_CHANGED');
    const auth=readonly(binary,['login','status'],env,directory,deadline);
    if(!`${auth.stdout}\n${auth.stderr}`.split(/\r?\n/).includes('Logged in using ChatGPT'))rejectInput('CODEX_CHATGPT_AUTH_REQUIRED');
    // Explicit -P selects this profile, including managed requirements. No model call.
    readonly(binary,['--no-daemon','sandbox','-P','calcifer','--include-managed-config','-C',directory,...configArgs(options),'--','/usr/bin/true'],env,directory,deadline);
    if(signal?.aborted)rejectInput('CODEX_CANCELLED_BEFORE_SEND');
    if(deadline!==null&&Date.now()>=deadline)rejectInput('CODEX_DEADLINE_BEFORE_SEND');
    args=buildCodexArgs(options);
    log=await open(join(evidenceDir,'events.jsonl'),'wx',0o600);
  } catch(error){error.dispatched=false;throw error;}

  let queue=Promise.resolve();
  try {
    if(deadline!==null&&Date.now()>=deadline)throw Object.assign(new Error('CODEX_DEADLINE_BEFORE_SEND'),{dispatched:false});
    return await new Promise((resolveResult,rejectResult)=>{
      let child;
      try{child=spawn(binary,args,{cwd:directory,env,stdio:['pipe','pipe','pipe'],detached:true});}
      catch(error){error.dispatched=false;rejectResult(error);return;}
      const decoder=new StringDecoder('utf8'),stderrDigest=createHash('sha256');
      let buffer='',stdoutBytes=0,stderrBytes=0,stderrPrefix=Buffer.alloc(0),threadId=null,
        response=[],usage=null,completed=false,turnStarted=false,parseError=false,turnFailed=false,
        cancelled=false,timedOut=false,overflow=false,spawnError=null,storageError=null,closed=false,
        spawned=false,dispatchRecorded=false,killTimer,watchdog;
      const kill=sig=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')spawnError??=error.code;}};
      const stop=()=>{
        if(closed)return;
        kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),1000);
        // Retain an open-process UNKNOWN receipt if cancellation cannot settle.
        watchdog??=setTimeout(()=>{if(!closed)rejectResult(Object.assign(new Error('CODEX_PROCESS_SETTLEMENT_UNKNOWN'),{dispatched:spawned,receipt:{conversationId:threadId??conversationId??null,process:{closed:false,cancelled,timedOut}}}));},5000);
      };
      const record=operation=>{queue=queue.then(()=>storageError?undefined:operation()).catch(error=>{storageError=error.code??'EVIDENCE_WRITE_FAILED';stop();});};
      const abort=()=>{cancelled=true;stop();};
      const parse=line=>{
        if(!line.trim())return;
        try {
          const event=JSON.parse(line);
          if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string')throw new Error('invalid event');
          if(completed||turnFailed)throw new Error('event after terminal');
          if(event.type==='thread.started') {
            if(threadId||!UUID.test(event.thread_id)||conversationId&&event.thread_id!==conversationId)throw new Error('thread mismatch');
            threadId=event.thread_id;
            record(()=>writeDurable(join(evidenceDir,'session.json'),JSON.stringify({conversationId:threadId,backend:'codex',requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,modelEvidence:MODEL_EVIDENCE,init:{model:null},version,binaryHash}),true));
          } else if(event.type==='turn.started') {
            if(turnStarted)throw new Error('duplicate turn');turnStarted=true;
          } else if(event.type==='turn.completed') {
            if(!threadId||!turnStarted)throw new Error('missing turn identity');completed=true;usage=event.usage??null;
          } else if(event.type==='turn.failed'||event.type==='error') {turnFailed=true;stop();}
          else if(event.type==='item.completed'&&event.item?.type==='agent_message') {
            if(typeof event.item.text!=='string')throw new Error('invalid message');response.push(event.item.text);
          }
          try{onEvent?.({event:event.type,type:event.type,conversationId:threadId,itemType:event.item?.type});}catch{}
        }catch{parseError=true;stop();}
      };
      child.stdout.on('data',chunk=>{
        stdoutBytes+=chunk.length;
        if(stdoutBytes>2097152){overflow=true;stop();return;}
        record(()=>log.write(chunk));buffer+=decoder.write(chunk);let end;
        while((end=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}
      });
      child.stderr.on('data',chunk=>{
        stderrBytes+=chunk.length;stderrDigest.update(chunk);
        if(stderrPrefix.length<32768)stderrPrefix=Buffer.concat([stderrPrefix,chunk.subarray(0,32768-stderrPrefix.length)]);
        if(stderrBytes>32768){overflow=true;stop();}
      });
      child.once('error',error=>{spawnError=error.code??'SPAWN_ERROR';});
      child.stdin.on('error',error=>{spawnError??=error.code??'STDIN_ERROR';stop();});
      signal?.addEventListener('abort',abort,{once:true});
      const timer=deadline===null?null:setTimeout(()=>{timedOut=true;stop();},Math.max(1,deadline-Date.now()));
      child.once('spawn',()=>{
        spawned=true;
        record(()=>writeDurable(join(evidenceDir,'started.json'),JSON.stringify({pid:child.pid,at:new Date().toISOString(),backend:'codex',conversationId:conversationId??null,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,modelEvidence:MODEL_EVIDENCE,binaryHash,version,configEvidence:'native sandbox explicit profile preflight passed',argsHash:hash(JSON.stringify(args))}),true));
        record(async()=>{
          if(signal?.aborted||closed||cancelled||timedOut){abort();child.stdin.end();return;}
          await writeDurable(join(evidenceDir,'dispatch.json'),JSON.stringify({state:'sending-or-unknown',at:new Date().toISOString(),promptHash:hash(prompt)}),true);
          dispatchRecorded=true;
          if(signal?.aborted){abort();child.stdin.end();return;}
          child.stdin.end(prompt);
        });
      });
      child.once('close',async(exitCode,exitSignal)=>{
        closed=true;clearTimeout(timer);clearTimeout(watchdog);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
        buffer+=decoder.end();if(buffer.trim())parse(buffer);
        const text=stderrPrefix.toString('utf8');
        const processReceipt={closed:true,exitCode,signal:exitSignal,spawnError,cancelled,timedOut,overflow,parseError,turnFailed,storageError,dispatchRecorded,stdoutBytes,stderrBytes,
          stderrHash:stderrDigest.digest('hex'),stderrKind:/auth|login required/i.test(text)?'AUTHENTICATION_REQUIRED':/quota|rate.limit|exhaust/i.test(text)?'PROVIDER_LIMIT':null};
        try {
          await queue;await log.sync();processReceipt.storageError=storageError;
          await writeDurable(join(evidenceDir,'process.json'),JSON.stringify(processReceipt),true);
          if(!completed||!threadId||!turnStarted||parseError||turnFailed||cancelled||timedOut||overflow||spawnError||storageError||exitCode!==0||!dispatchRecorded) {
            rejectResult(Object.assign(new Error('CODEX_RESULT_UNKNOWN'),{dispatched:spawned,receipt:{conversationId:threadId??conversationId??null,process:processReceipt,status:'UNKNOWN'}}));return;
          }
          const result={status:'SUCCESS',conversation_id:threadId,response:response.join('\n'),actualModel:null,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,modelEvidence:MODEL_EVIDENCE,usage,process:processReceipt,version,binaryHash};
          await writeDurable(join(evidenceDir,'terminal.json'),JSON.stringify(result),true);
          resolveResult(result);
        }catch(error){error.dispatched=spawned;error.receipt={conversationId:threadId??conversationId??null,process:processReceipt,status:'UNKNOWN'};rejectResult(error);}
      });
      if(signal?.aborted)abort();
    });
  }finally{await queue;await log.close();}
}
