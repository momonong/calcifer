#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runLiveTask } from './live-task.mjs';

const [action,flag,file,...rest]=process.argv.slice(2);
if(!['run','inspect'].includes(action)||flag!=='--config'||!file||rest.length){
  console.error('Usage: node src/live-cli.mjs run|inspect --config /absolute/task.json');process.exitCode=2;
}else{
  try{
    const config=JSON.parse(await readFile(resolve(file),'utf8'));
    if(action==='inspect')console.log(await readFile(`${config.stateDir}/report.json`,'utf8'));
    else{
      const stop=new AbortController();process.once('SIGINT',()=>stop.abort());process.once('SIGTERM',()=>stop.abort());
      const result=await runLiveTask(config,{signal:stop.signal});
      console.log(JSON.stringify({status:result.status,code:result.code,model:result.modelRequested,taskExecutions:result.taskExecutions,
        patchPath:result.patchPath,reportPath:`${config.stateDir}/report.json`,changedFiles:result.changedFiles,sourcePreserved:result.sourcePreserved}));
      process.exitCode=result.status==='completed'?0:1;
    }
  }catch(error){console.error(JSON.stringify({status:'failed',code:/^[A-Z_0-9]+$/.test(error.message)?error.message:'LIVE_CLI_FAILED'}));process.exitCode=1;}
}
