// Compatibility preset only: Thor is an acceptance project, not the project core.
import {lstat,readdir} from 'node:fs/promises';
import {join,extname} from 'node:path';
import {secureRoot,fail} from './workspace-tools.mjs';
import {readSourceSnapshot} from './project-workspace.mjs';
const LIMITS={maxFiles:256};
const TEXT_EXTENSIONS=new Set(['.py','.md','.toml','.lock','.csv','.json','.txt','.yaml','.yml','.ini','.cfg']);
const CACHE_NAMES=new Set(['__pycache__','node_modules','venv','env']);
const DRAFT='docs/drafts/liner-preparation-2026-11-07';
async function exists(path){try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function fileContent(repo,path){await readSourceSnapshot(repo,[path]);}
export async function thorSourceFiles(repo){
  await secureRoot(repo);const paths=[];
  const secret=path=>/(?:^|\/)(?:credentials?|secrets?|tokens?|passwords?|accounts?|auth)(?:[._-]|$)/i.test(path);
  async function walk(prefix){
    if(!await exists(join(repo,prefix)))return;await secureRoot(join(repo,prefix));
    for(const entry of await readdir(join(repo,prefix),{withFileTypes:true})){
      const path=`${prefix}/${entry.name}`;
      if(entry.name.startsWith('.')||CACHE_NAMES.has(entry.name)||secret(path))continue;
      if(entry.isSymbolicLink())fail('SYMLINK_REJECTED');
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile()&&TEXT_EXTENSIONS.has(extname(path))&&entry.name!=='AGENTS.md'){await fileContent(repo,path);paths.push(path);if(paths.length>LIMITS.maxFiles)fail('FILE_COUNT_LIMIT');}
    }
  }
  for(const folder of ['erasebot','tests','fixtures','tools'])await walk(folder);
  for(const path of ['pyproject.toml','uv.lock',`${DRAFT}/README.md`,`${DRAFT}/trial-plan.csv`,`${DRAFT}/results-template.csv`])if(await exists(join(repo,path))){await fileContent(repo,path);paths.push(path);}
  const sorted=paths.sort();await readSourceSnapshot(repo,sorted);return sorted;
}
