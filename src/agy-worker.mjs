import { spawn, execFileSync } from 'node:child_process';
import { open, readFile, realpath } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hash, fail, writeDurable } from './workspace-tools.mjs';

import { EXECUTIONS, EXECUTION_MODELS, EXECUTION_EFFORTS, MAX_EXECUTION_TIMEOUT_MS } from './project-execution.mjs';

export const AGY_MODEL = EXECUTIONS.agy.model;
const EFFORT_EVIDENCE='requested-only: pinned CLI --effort; native stream does not attest actual effort';
export const AGY_SETTINGS = Object.freeze({
  useG1Credits: false, modelProvider: '',
  permissions: { allow: [], ask: [], deny: [
    'read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'
  ] }
});

// One CLI turn, not a raw provider generation. No retry or fallback here.
export async function runAgyWorker({prompt, directory, evidenceDir, model=AGY_MODEL, effort=EXECUTIONS.agy.effort, expectedVersion=EXECUTIONS.agy.version,
  conversationId, timeoutMs=null, signal, fileTools = false, onEvent, agentName='calcifer-worker', writeRoots=[], executable = join(homedir(), '.local/bin/agy')}) {
  const env = {HOME:homedir(), PATH:'/usr/local/bin:/usr/bin:/bin', LANG:'C.UTF-8', TERM:'dumb'};
  const deadline=timeoutMs===null?null:Date.now()+timeoutMs;
  let binary,binaryHash,version,args,log;
  try {
  if(!EXECUTION_MODELS.agy.includes(model) || !EXECUTION_EFFORTS.includes(effort) || (timeoutMs!==null&&(!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS))) fail('AGY_PROFILE_INVALID');
  if(conversationId && !/^[a-f0-9-]{36}$/.test(conversationId)) fail('AGY_SESSION_INVALID');
  binary = await realpath(executable); binaryHash = hash(await readFile(binary));
  version = execFileSync(binary,['--version'],{env,encoding:'utf8',timeout:deadline===null?5000:Math.max(1,Math.min(5000,deadline-Date.now()))}).trim();
  if(version !== expectedVersion) throw Object.assign(new Error('AGY_VERSION_CHANGED'),{dispatched:false});
  if(signal?.aborted) fail('AGY_CANCELLED_BEFORE_SEND');
  if(deadline!==null&&Date.now()>=deadline)fail('AGY_DEADLINE_BEFORE_SEND');
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(agentName)||!Array.isArray(writeRoots)||writeRoots.some(p=>!p||p.startsWith('/')||p.split('/').some(x=>!x||x.startsWith('.'))||/[^A-Za-z0-9_/-]/.test(p)))fail('AGY_SCOPE_INVALID');
  const settings=fileTools ? {useG1Credits:false,modelProvider:'',permissions:{allow:[`read_file(${directory})`,...writeRoots.map(p=>`write_file(${directory}/${p})`)],ask:[],deny:['command(*)','read_url(*)','execute_url(*)','mcp(*)',`write_file(${directory}/.agents)`,`write_file(${directory}/AGENTS.md)`]}} : AGY_SETTINGS;
  args=['--model',model,'--effort',effort,'--mode','accept-edits','--settings',JSON.stringify({...settings,trustedWorkspaces:[directory]}),
    '--disable-slash-commands','--input-format','stream-json','--output-format','stream-json',
    '--print-timeout',deadline===null?'0s':`${Math.max(1,Math.ceil((deadline-Date.now())/1000))}s`];
  if(fileTools)args.push('--agent',agentName);
  if(conversationId)args.push('--conversation',conversationId);
  log=await open(join(evidenceDir,'events.jsonl'),'wx',0o600);
  } catch(error) { error.dispatched=false; throw error; }
  let recorded = Promise.resolve();
  try {
    if(deadline!==null&&Date.now()>=deadline)throw Object.assign(new Error('AGY_DEADLINE_BEFORE_SEND'),{dispatched:false});
    return await new Promise((resolve,reject)=>{
      const child=spawn(binary,args,{cwd:directory,env,stdio:['pipe','pipe','pipe'],detached:true});
      recorded=recorded.then(()=>writeDurable(join(evidenceDir,'started.json'),JSON.stringify({pid:child.pid??null,at:new Date().toISOString(),conversationId:conversationId??null,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,argsHash:hash(JSON.stringify(args))}),true));
      const decoder=new StringDecoder('utf8');
      let buffer='',bytes=0,result,init,parseError=false,stderrBytes=0,stderrDigest=[],spawnError,
        cancelled=false,timedOut=false,overflow=false,closed=false,killTimer,watchdog;
      const tools=[];
      const kill=sig=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')spawnError=e.code;}};
      const stop=()=>{
        if(closed)return;
        kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),1000);
        // Settlement protection begins on cancellation/error, not on a run deadline.
        watchdog??=setTimeout(()=>{if(!closed)reject(Object.assign(new Error('AGY_PROCESS_SETTLEMENT_UNKNOWN'),{receipt:{conversationId:result?.conversation_id??init?.conversation_id??conversationId??null,process:{closed:false,cancelled,timedOut}}}));},5000);
      };
      const abort=()=>{cancelled=true;stop();};
      signal?.addEventListener('abort',abort,{once:true});
      const parse=line=>{
        if(!line.trim())return;
        try{
          const event=JSON.parse(line);
          if(event.event==='init'){
            init=event;if((event.init?.model!=null&&event.init.model!==model)||(fileTools&&(event.init?.model!==model||event.init?.agent!==agentName)))throw new Error('AGY_INIT_MISMATCH');
            recorded=recorded.then(()=>writeDurable(join(evidenceDir,'session.json'),JSON.stringify({conversationId:event.conversation_id,modelRequested:model,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,init:event.init,version,binaryHash})));
          }
          if(event.event==='result'){if(result)throw new Error('duplicate result');result=event.result;recorded=recorded.then(()=>writeDurable(join(evidenceDir,'terminal.json'),JSON.stringify({...result,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE}),true));}
          const step=event.step_update;
          if(step && !['agent_response','user_input','system_message','error_message'].includes(step.step_type))tools.push({type:step.step_type,state:step.state,index:step.step_index});
        try{onEvent?.({event:event.event,type:step?.step_type,state:step?.state,index:step?.step_index,conversationId:event.conversation_id});}catch{}
        }catch{parseError=true;stop();}
      };
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>2097152){overflow=true;stop();return;}
        recorded=recorded.then(()=>log.write(chunk));
        buffer+=decoder.write(chunk);let end;
        while((end=buffer.indexOf('\n'))>=0){parse(buffer.slice(0,end));buffer=buffer.slice(end+1);}
      });
      child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes<=32768)stderrDigest.push(chunk);else{overflow=true;stop();}});
      child.once('error',e=>{spawnError=e.code;});
      child.stdin.on('error',e=>{spawnError??=e.code;stop();});
      const timer=deadline===null?null:setTimeout(()=>{timedOut=true;stop();},Math.max(1,deadline-Date.now()));
      child.once('close',async(exitCode,exitSignal)=>{
        closed=true;clearTimeout(timer);clearTimeout(watchdog);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
        buffer+=decoder.end();if(buffer.trim())parse(buffer);
        try{
          await recorded;await log.sync();
          const processReceipt={closed:true,exitCode,signal:exitSignal,spawnError,cancelled,timedOut,overflow,parseError,
            stderrBytes,stderrHash:hash(Buffer.concat(stderrDigest)),stderrKind:/authentication required/i.test(Buffer.concat(stderrDigest).toString())?'AUTHENTICATION_REQUIRED':/quota|rate.limit|exhaust/i.test(Buffer.concat(stderrDigest).toString())?'PROVIDER_LIMIT':null};
          await writeDurable(join(evidenceDir,'process.json'),JSON.stringify(processReceipt),true);
          if(!result || parseError || cancelled || timedOut || overflow || spawnError || exitCode!==0 || result.status!=='SUCCESS')
            return reject(Object.assign(new Error('AGY_RESULT_UNKNOWN'),{receipt:{process:processReceipt,conversationId:result?.conversation_id??init?.conversation_id,status:result?.status}}));
          if(typeof result.response!=='string'||!result.conversation_id || conversationId&&result.conversation_id!==conversationId)
            return reject(new Error('AGY_RESULT_IDENTITY_UNKNOWN'));
          resolve({...result,process:processReceipt,tools,version,binaryHash,
            actualModel:init?.init?.model??null,requestedModel:model,requestedEffort:effort,actualEffort:null,effortEvidence:EFFORT_EVIDENCE,modelEvidence:'explicit CLI model; no fallback; native model field when available'});
        }catch(error){reject(error);}
      });
      recorded.then(async()=>{
        if(signal?.aborted){abort();child.stdin.end();return;}
        await writeDurable(join(evidenceDir,'dispatch.json'),JSON.stringify({state:'sending-or-unknown',at:new Date().toISOString(),promptHash:hash(prompt)}),true);
        child.stdin.end(JSON.stringify({event:'user',message:{content:prompt}})+'\n');
      }).catch(()=>{spawnError='DISPATCH_RECORD_FAILED';stop();});
    });
  }finally{await recorded;await log.close();}
}
