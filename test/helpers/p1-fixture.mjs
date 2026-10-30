import { mkdtemp, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
export const root = resolve(new URL('../../', import.meta.url).pathname);
export async function freshP1(caseName = 't1') {
  const base = await mkdtemp(join(tmpdir(), 'calcifer-p1-')), repo = join(base,'taskboard-cli'), stateRoot=join(base,'state');
  await cp(join(root,'fixtures/taskboard-cli',caseName),repo,{recursive:true});
  const files=[]; const walk=async(prefix='')=>{for(const entry of await readdir(join(repo,prefix),{withFileTypes:true})){const path=prefix?prefix+'/'+entry.name:entry.name;if(entry.isDirectory())await walk(path);else files.push(path);}};await walk();
  const config={schemaVersion:1,stateRoot,sourceFiles:files.sort(),readPaths:files.sort(),writePaths:caseName==='t2'?['README.md','src/taskboard.mjs']:['README.md','src/taskboard.mjs','test/contract.test.mjs'],createPaths:['src/status.mjs'],commands:{test:{argv:['--test','test/contract.test.mjs'],timeoutMs:1500}},acceptance:{scriptPath:join(root,'fixtures/taskboard-cli',caseName+'-acceptance.mjs'),timeoutMs:2000},limits:{maxToolCalls:32,maxOutputBytes:32768}};
  const configPath=join(base,'host.json');await writeFile(configPath,JSON.stringify(config));
  return{base,repo,stateRoot,config,configPath,mockScript:join(root,'fixtures/taskboard-cli/provider',caseName+'.json')};
}
