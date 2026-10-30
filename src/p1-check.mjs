import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { nodeRuntimeIdentity } from './json-cli-check.mjs';
import { digest, fail, hash } from './workspace-tools.mjs';

export async function bindP1Runtime(binary){
  if(process.platform!=='linux')fail('CHECK_ISOLATION_UNAVAILABLE');
  for(const file of ['/usr/bin/timeout','/usr/bin/unshare','/usr/bin/bwrap'])await access(file,constants.X_OK);
  return nodeRuntimeIdentity(binary);
}
export async function runP1Check({snapshotDir,manifest,definition,runtime,acceptancePath,signal,maxOutputBytes=32768,stage,checkId}){
  if(signal?.aborted)fail('CHECK_CANCELLED_BEFORE_DISPATCH');
  const args=['--signal=TERM','--kill-after=0.2s',`${definition.timeoutMs/1000}s`,'/usr/bin/unshare','--user','--map-root-user','--net','--fork','--kill-child=KILL','/usr/bin/bwrap','--unshare-user','--unshare-all','--share-net','--die-with-parent','--new-session','--cap-drop','ALL','--disable-userns','--assert-userns-disabled','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--dir','/runtime','--ro-bind',runtime.path,'/runtime/node','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--ro-bind',snapshotDir,'/workspace','--chdir','/workspace','--setenv','PATH','/runtime:/usr/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp','--setenv','LANG','C'];
  if(acceptancePath)args.push('--dir','/acceptance','--ro-bind',acceptancePath,'/acceptance/check.mjs');
  args.push('--remount-ro','/','--','/runtime/node',...(acceptancePath?['--test','/acceptance/check.mjs']:definition.argv));
  const raw=await new Promise((accept,reject)=>{
    const child=spawn('/usr/bin/timeout',args,{env:{PATH:'/usr/bin:/bin'},detached:true,stdio:['ignore','pipe','pipe']});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),outputLimit=false,cancelled=false,spawnError=null,killTimer,closed=false;
    const kill=sig=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')spawnError=e.code;}};
    const stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),200);};
    const abort=()=>{cancelled=true;stop();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const capture=stream=>bytes=>{const left=maxOutputBytes-stdout.length-stderr.length,part=bytes.subarray(0,Math.max(0,left));if(stream==='stdout')stdout=Buffer.concat([stdout,part]);else stderr=Buffer.concat([stderr,part]);if(bytes.length>left&&!outputLimit){outputLimit=true;stop();}};
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));child.once('error',e=>spawnError=e.code);
    const watchdog=setTimeout(()=>{if(!closed){stop();reject(new Error('CHECK_SETTLEMENT_UNKNOWN'));}},definition.timeoutMs+1500);
    child.once('close',(exitCode,exitSignal)=>{closed=true;clearTimeout(watchdog);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);accept({stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64'),outputPreviewEncoding:'utf8-with-replacement',stdoutHash:hash(stdout),stderrHash:hash(stderr),process:{closed:true,exitCode,signal:exitSignal,spawnError,outputLimit,cancelled,timedOut:exitCode===124||exitCode===137,isolationError:exitCode!==0&&/(?:unshare|bwrap):/.test(stderr.toString('utf8'))}});});
  });
  const p=raw.process,passed=p.exitCode===0&&p.signal===null&&!p.spawnError&&!p.outputLimit&&!p.cancelled&&!p.isolationError;
  return{stage,checkId,kind:'node-project-command',manifestHash:manifest.hash,definitionHash:definition.definitionHash,runtimeHash:digest(runtime),...raw,status:passed?'passed':'failed',code:passed?'CHECK_PASSED':p.isolationError?'CHECK_ISOLATION_UNAVAILABLE':p.cancelled?'CHECK_CANCELLED':p.outputLimit?'CHECK_OUTPUT_LIMIT':p.timedOut||p.signal?'CHECK_TIMEOUT_OR_TERMINATED':'CHECK_NONZERO_EXIT'};
}

// A missing/unknown process receipt never becomes closure through Array.every([]).
export function p1CommandSettlement(events){
  const intents=events.filter(event=>event.type==='intent'&&event.data.kind==='command');
  const closed=new Set(events.filter(event=>event.type==='completed'&&event.data.processClosed===true).map(event=>event.data.id));
  const unsettledIds=intents.filter(event=>!closed.has(event.data.id)).map(event=>event.data.id);
  return{attempted:intents.length,closed:intents.length-unsettledIds.length,allClosed:unsettledIds.length===0,unsettledIds};
}


export function verifyP1CheckOutput(check){
  for(const stream of ['stdout','stderr']){
    const encoded=check[stream+'Base64'];
    if(typeof encoded!=='string')fail('CHECK_OUTPUT_MISMATCH');
    const bytes=Buffer.from(encoded,'base64');
    if(bytes.toString('base64')!==encoded||hash(bytes)!==check[stream+'Hash']||bytes.toString('utf8')!==check[stream])fail('CHECK_OUTPUT_MISMATCH');
  }
  return true;
}

// Full lossless receipt stays with the host. SDK receives a bounded, explicit preview.
export function boundedP1CheckSummary(receipt,maxBytes){
  const summary={status:receipt.status,code:receipt.code,checkId:receipt.checkId,manifestHash:receipt.manifestHash,definitionHash:receipt.definitionHash,
    process:{closed:receipt.process.closed,exitCode:receipt.process.exitCode,signal:receipt.process.signal},
    output:{stdoutPreview:receipt.stdout.slice(0,2048),stderrPreview:receipt.stderr.slice(0,2048),truncated:receipt.stdout.length>2048||receipt.stderr.length>2048,fullReceiptRetained:true}};
  while(Buffer.byteLength(JSON.stringify(summary))>maxBytes&&(summary.output.stdoutPreview.length||summary.output.stderrPreview.length)){
    summary.output.stdoutPreview=summary.output.stdoutPreview.slice(0,Math.floor(summary.output.stdoutPreview.length/2));
    summary.output.stderrPreview=summary.output.stderrPreview.slice(0,Math.floor(summary.output.stderrPreview.length/2));
    summary.output.truncated=true;
  }
  if(Buffer.byteLength(JSON.stringify(summary))>maxBytes)fail('TOOL_OUTPUT_LIMIT');
  return summary;
}
