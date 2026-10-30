import { readText } from './workspace-tools.mjs';
import { dirname, basename } from 'node:path';
import { runP1 } from './p1-runner.mjs';
const controller=new AbortController();process.on('SIGTERM',()=>controller.abort());process.on('SIGINT',()=>controller.abort());
try{
  const [inputPath]=process.argv.slice(2),input=JSON.parse((await readText(dirname(inputPath),basename(inputPath),{limits:{maxFileBytes:32768}})).content);
  const config=JSON.parse((await readText(dirname(input.configPath),basename(input.configPath),{limits:{maxFileBytes:32768}})).content);
  const result=await runP1({...input,config,signal:controller.signal});
  console.log('CALCIFER_P1_RESULT='+JSON.stringify({runID:result.runID,status:result.status,code:result.code}));process.exit(result.status==='completed'?0:1);
}catch(error){console.log('CALCIFER_P1_RESULT='+JSON.stringify({status:'rejected',code:/^[A-Z_0-9]+$/.test(error.message)?error.message:'P1_RUN_FAILED'}));process.exit(1);}
