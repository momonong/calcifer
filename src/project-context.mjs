import { lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { digest, hash, fail, readText } from './workspace-tools.mjs';

// Historical export retained for callers; new contexts follow the installed core's pin.
export const PLAYBOOK_COMMIT = '80a550a2f2efc1c3790935b2b806b1bf0971cdbe';
export async function loadProjectContext({repo,sourceFiles,playbookRoot,corePath=join(homedir(),'.codex/AGENTS.md')}) {
  const options={limits:{maxFileBytes:131072},anyExtension:true};
  const core=await readText(dirname(corePath),corePath.split('/').at(-1),options);
  const pins=[...core.content.matchAll(/^<!-- agent-playbook guides-commit: ([0-9a-f]{40}) -->\r?$/gm)];
  if(pins.length!==1)fail('PLAYBOOK_CORE_VERSION_MISMATCH');
  const playbookCommit=pins[0][1];
  playbookRoot??=join(dirname(corePath),'agent-playbook/versions',playbookCommit);
  const marker=await readText(playbookRoot,'SOURCE_COMMIT',{limits:{maxFileBytes:128},anyExtension:true});
  if(marker.content.trim()!==playbookCommit)fail('PLAYBOOK_VERSION_MISMATCH');
  const paths=[corePath,...['engineering','external-execution','model-selection','collaboration'].map(n=>join(playbookRoot,'guides',n+'.md'))];
  const projectRules=new Set([join(repo,'AGENTS.md')]);
  for(const file of sourceFiles){let dir=dirname(file);while(dir!=='.'){projectRules.add(join(repo,dir,'AGENTS.md'));dir=dirname(dir);}}
  for(const path of projectRules){try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())fail('PROJECT_RULE_UNSAFE');paths.push(path);}catch(error){if(error.code!=='ENOENT')throw error;}}
  const parts=[],sources=[];
  for(const path of paths){const {content}=path===corePath?core:await readText(dirname(path),path.split('/').at(-1),options);
    sources.push({path,hash:hash(content)});parts.push(`## Source: ${path}\n\n${content}`);
  }
  const text=parts.join('\n\n');if(Buffer.byteLength(text)>524288)fail('PROJECT_CONTEXT_LIMIT');
  return {text,sources,hash:digest({sources,text}),playbookCommit};
}
