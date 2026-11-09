import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {gateTool} from '../src/project-tool-gate.mjs';
test('generic file gate uses selected project scope rather than Thor folders',async()=>{
 const workspace=await mkdtemp('/tmp/calcifer-generic-gate-');await mkdir(join(workspace,'taskboard'));
 const profile={schemaVersion:1,name:'Taskboard',sourceFiles:['checks/test.py'],writeRules:[{root:'taskboard',extensions:['.py']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
 const config={workspace,profile,deadlineAt:Date.now()+10000},run=(path,c=config)=>gateTool({workspacePaths:[workspace],toolCall:{name:'write_to_file',args:{TargetFile:join(workspace,path)}}},c);
 assert.equal((await run('taskboard/value.py')).decision,'allow');
 for(const path of ['erasebot/a.py','tools/a.py','README.md','taskboard/data.csv','AGENTS.md','.agents/hooks.json'])assert.equal((await run(path)).decision,'deny',path);
 assert.equal((await run('taskboard/value.py',{...config,profile:undefined})).decision,'deny');
});
test('generic Markdown gate rejects AGENTS.md at every depth for create and edit tools',async()=>{
 const workspace=await mkdtemp('/tmp/calcifer-control-gate-');await mkdir(join(workspace,'checks'));
 const profile={schemaVersion:1,name:'Controls',sourceFiles:['checks/test.py'],writeRules:[{root:'checks',extensions:['.py','.md']}],check:{kind:'python-unittest',testDir:'checks',timeoutMs:10000}};
 const config={workspace,profile,deadlineAt:Date.now()+10000};
 for(const name of ['write_to_file','replace_file_content','multi_replace_file_content'])for(const path of ['AGENTS.md','checks/AGENTS.md','checks/deep/AGENTS.md'])
  assert.equal((await gateTool({workspacePaths:[workspace],toolCall:{name,args:{TargetFile:join(workspace,path)}}},config)).decision,'deny',name+':'+path);
 assert.equal((await gateTool({workspacePaths:[workspace],toolCall:{name:'write_to_file',args:{TargetFile:join(workspace,'checks/notes.md')}}},config)).decision,'allow');
});
