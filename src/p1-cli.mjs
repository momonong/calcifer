import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reopenP1, exportP1 } from './p1-evidence.mjs';
import { fail, readText, writeDurable } from './workspace-tools.mjs';
let temporary;
try{
  const [command,...args]=process.argv.slice(2),values=new Map();
  if(process.versions.bun||!['run','reopen','export'].includes(command))fail('NODE_P1_CLI_REQUIRED');
  const keys=command==='run'?['--repo','--config','--state-root','--goal','--goal-file','--harness','--profile','--mock-script']:['--state-root','--run-id'];
  for(let i=0;i<args.length;i+=2){if(!keys.includes(args[i])||values.has(args[i])||!args[i+1]||args[i+1].startsWith('--'))fail('INVALID_ARGUMENTS');values.set(args[i],args[i+1]);}
  const absolute=key=>{const value=values.get(key);if(!value||resolve(value)!==value)fail('ABSOLUTE_PATH_REQUIRED');return value;};
  const stateRoot=absolute('--state-root');
  if(command==='export'){
    const {patch,receipt}=await exportP1({stateRoot,runID:values.get('--run-id')});process.stdout.write(patch);process.stderr.write(JSON.stringify(receipt)+'\n');
  }else{
    let result;
    if(command==='reopen')result=await reopenP1({stateRoot,runID:values.get('--run-id')});
    else{
      if(Number(values.has('--goal'))+Number(values.has('--goal-file'))!==1)fail('EXACT_GOAL_REQUIRED');
      const goal=values.has('--goal')?values.get('--goal'):(await readText(dirname(absolute('--goal-file')),basename(values.get('--goal-file')),{limits:{maxFileBytes:8192}})).content;
      const input={repo:absolute('--repo'),configPath:absolute('--config'),stateRoot,goal,harness:values.get('--harness'),profile:values.get('--profile'),mockScript:absolute('--mock-script'),hostNodeBinary:process.execPath};
      if(!['opencode','pi'].includes(input.harness)||input.profile!=='mock-loopback')fail('MOCK_PROFILE_REQUIRED');
      temporary=await mkdtemp('/tmp/calcifer-p1-cli-');const inputPath=join(temporary,'input.json');await writeDurable(inputPath,JSON.stringify(input),true);
      const outcome=await new Promise((accept,reject)=>{
        const child=spawn(fileURLToPath(new URL('../node_modules/.bin/bun',import.meta.url)),[fileURLToPath(new URL('./p1-child.mjs',import.meta.url)),inputPath],{env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
        let stdout='',overflow=false,killTimer;
        const stop=()=>{child.kill('SIGTERM');killTimer??=setTimeout(()=>child.kill('SIGKILL'),4000);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
        const timer=setTimeout(stop,125000);child.stdout.on('data',bytes=>{stdout+=bytes.toString();if(Buffer.byteLength(stdout)>131072){overflow=true;stop();}});child.stderr.on('data',()=>{});
        child.once('error',reject);child.once('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(killTimer);process.off('SIGINT',stop);process.off('SIGTERM',stop);if(overflow||signal)return reject(new Error('P1_CHILD_RESULT_UNKNOWN'));try{const line=stdout.split('\n').find(l=>l.startsWith('CALCIFER_P1_RESULT='));if(!line)throw new Error('P1_CHILD_RESULT_UNKNOWN');accept({...JSON.parse(line.slice(19)),exitCode});}catch(e){reject(e);}});
      });
      if(!outcome.runID)fail(outcome.code??'P1_CHILD_RESULT_UNKNOWN');
      result=await reopenP1({stateRoot,runID:outcome.runID});delete result.reopenedWithoutSDK;
      if(outcome.exitCode!==0&&result.status==='completed')fail('P1_CHILD_RESULT_UNKNOWN');
    }
    process.stdout.write(JSON.stringify(result)+'\n');if(result.status!=='completed')process.exitCode=1;
  }
}catch(error){process.stdout.write(JSON.stringify({schemaVersion:1,status:'rejected',code:/^[A-Z_0-9]+$/.test(error.message)?error.message:'P1_FAILED',actualModelRequests:0})+'\n');process.exitCode=1;}
finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
