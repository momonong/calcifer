import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureRoot } from '../../src/workspace-tools.mjs';

// Explicit synthetic fixture preparation. No goal matching or product dispatch logic.
export async function prepareTaskboard(directory, caseName='t1'){
  if(!['t1','t2'].includes(caseName)||resolve(directory)!==directory)throw new Error('INVALID_FIXTURE_ARGUMENTS');
  await secureRoot(dirname(directory));await mkdir(directory,{mode:0o700});
  const fixtures=fileURLToPath(new URL('./',import.meta.url)),repo=join(directory,'taskboard-cli'),stateRoot=join(directory,'state');
  await cp(join(fixtures,caseName),repo,{recursive:true});
  const acceptance=join(directory,'host-acceptance.mjs'),mockScript=join(directory,'provider.json'),goalFile=join(directory,'goal.txt'),configPath=join(directory,'host.json');
  await cp(join(fixtures,caseName+'-acceptance.mjs'),acceptance);await cp(join(fixtures,'provider',caseName+'.json'),mockScript);
  const files=['AGENTS.md','README.md','UNRELATED.md','data/tasks.json','package.json','src/cli.mjs','src/taskboard.mjs','test/contract.test.mjs'];
  const config={schemaVersion:1,stateRoot,sourceFiles:files,readPaths:files,writePaths:caseName==='t2'?['README.md','src/taskboard.mjs']:['README.md','src/taskboard.mjs','test/contract.test.mjs'],createPaths:['src/status.mjs'],commands:{test:{argv:['--test','test/contract.test.mjs'],timeoutMs:1500}},acceptance:{scriptPath:acceptance,timeoutMs:2000},limits:{maxToolCalls:32,maxOutputBytes:32768}};
  const goal=caseName==='t1'?'Implement list --status done filtering, add the necessary module, documentation and focused test; preserve unrelated content.':'Fix the inclusive before-date boundary, excluding missing dates; retain the same existing regression and verify red to green.';
  await writeFile(configPath,JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});await writeFile(goalFile,goal+'\n',{flag:'wx',mode:0o600});
  return{directory,repo,stateRoot,configPath,mockScript,goalFile,caseName,runArgs:['run','--repo',repo,'--config',configPath,'--state-root',stateRoot,'--goal-file',goalFile,'--harness','opencode','--profile','mock-loopback','--mock-script',mockScript]};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--directory'||args[2]!=='--case')throw new Error('Use --directory /absolute/new-directory --case t1|t2');console.log(JSON.stringify(await prepareTaskboard(args[1],args[3]),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
