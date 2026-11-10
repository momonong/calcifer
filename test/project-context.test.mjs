import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadProjectContext} from '../src/project-context.mjs';

const CURRENT='a937f9199475f7affdab7545d81b6222f2ae0e5f';
const LEGACY='80a550a2f2efc1c3790935b2b806b1bf0971cdbe';
async function fixture(t,pin=CURRENT){
 const root=await mkdtemp(join(tmpdir(),'calcifer-context-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,'repo'),home=join(root,'codex');
 const corePath=join(home,'AGENTS.md'),playbookRoot=join(home,'agent-playbook/versions',pin);
 await mkdir(repo);await mkdir(join(playbookRoot,'guides'),{recursive:true});
 await writeFile(corePath,'<!-- agent-playbook guides-commit: '+pin+' -->\nKeep original user scope.\n');
 await writeFile(join(playbookRoot,'SOURCE_COMMIT'),pin+'\n');
 for(const name of ['engineering','external-execution','model-selection','collaboration'])
  await writeFile(join(playbookRoot,'guides',name+'.md'),'Verified '+name+' policy.\n');
 return {repo,corePath,playbookRoot,sourceFiles:['main.py']};
}
test('new project loads the immutable guide version pinned by its installed core',async t=>{
 const f=await fixture(t);
 const result=await loadProjectContext({repo:f.repo,corePath:f.corePath,sourceFiles:f.sourceFiles});
 assert.equal(result.playbookCommit,CURRENT);
 assert.equal(result.sources.length,5);
 assert.ok(result.sources.slice(1).every(s=>s.path.startsWith(f.playbookRoot+'/guides/')));
 assert.match(result.text,/Verified external-execution policy/);
});
test('explicit legacy snapshot remains usable with matching legacy core',async t=>{
 const f=await fixture(t,LEGACY);
 const result=await loadProjectContext(f);
 assert.equal(result.playbookCommit,LEGACY);
 assert.equal(result.sources.length,5);
});
test('core must declare exactly one complete pinned commit',async t=>{
 const f=await fixture(t,LEGACY);
 for(const text of ['No pin\n','<!-- agent-playbook guides-commit: main -->\n',
  '<!-- agent-playbook guides-commit: '+LEGACY+' -->\n<!-- agent-playbook guides-commit: '+LEGACY+' -->\n']){
  await writeFile(f.corePath,text);
  await assert.rejects(loadProjectContext(f),/PLAYBOOK_CORE_VERSION_MISMATCH/);
 }
});
test('snapshot identity must match the core pin even when a root is explicitly supplied',async t=>{
 const f=await fixture(t,LEGACY);
 await writeFile(join(f.playbookRoot,'SOURCE_COMMIT'),CURRENT+'\n');
 await assert.rejects(loadProjectContext(f),/PLAYBOOK_VERSION_MISMATCH/);
});
test('a pinned snapshot with a missing required guide fails closed',async t=>{
 const f=await fixture(t,LEGACY);
 await rm(join(f.playbookRoot,'guides','external-execution.md'));
 await assert.rejects(loadProjectContext(f),{code:'ENOENT'});
});
test('source commit marker cannot be supplied through a symbolic link',async t=>{
 const f=await fixture(t,LEGACY),marker=join(f.playbookRoot,'SOURCE_COMMIT');
 const other=join(f.repo,'marker');await writeFile(other,LEGACY+'\n');await rm(marker);await symlink(other,marker);
 await assert.rejects(loadProjectContext(f),/SYMLINK|REGULAR|UNSAFE/);
});
