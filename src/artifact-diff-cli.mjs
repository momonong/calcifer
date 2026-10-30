import { resolve } from 'node:path';
import { exportArtifactDiff } from './artifact-diff.mjs';
try{
  if(process.versions.bun)throw new Error('NODE_EXPORT_CLI_REQUIRED');
  const args=process.argv.slice(2),options=new Map();
  for(let index=0;index<args.length;index+=2){
    const key=args[index],value=args[index+1];
    if(!['--state-root','--run-id'].includes(key)||options.has(key)||!value||value.startsWith('--'))throw new Error('INVALID_ARGUMENTS');
    options.set(key,value);
  }
  const stateRoot=options.get('--state-root'),runID=options.get('--run-id');
  if(!stateRoot||resolve(stateRoot)!==stateRoot||!runID)throw new Error('INVALID_ARGUMENTS');
  const{patch,receipt}=await exportArtifactDiff({stateRoot,runID});
  await new Promise((accept,reject)=>process.stdout.write(patch,error=>error?reject(error):accept()));
  process.stderr.write(JSON.stringify(receipt)+'\n');
}catch(error){
  process.stderr.write(JSON.stringify({schemaVersion:1,status:'rejected',code:/^[A-Z_]+$/.test(error.message)?error.message:'EXPORT_FAILED',noInferencePerformed:true})+'\n');process.exitCode=1;
}
