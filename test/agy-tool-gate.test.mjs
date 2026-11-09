import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,link,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable,Writable} from 'node:stream';
import {gateTool,runGate} from '../src/agy-tool-gate.mjs';

test('native file gate rejects external tools, traversal, controls and linked files',async()=>{
 const workspace=await mkdtemp('/tmp/calcifer-gate-test-');await mkdir(join(workspace,'tools'));await writeFile(join(workspace,'tools/a.py'),'x');await symlink('/etc/passwd',join(workspace,'tools/link.py'));await link(join(workspace,'tools/a.py'),join(workspace,'tools/hard.py'));
 const config={workspace,deadlineAt:Date.now()+10000},run=(name,args)=>gateTool({workspacePaths:[workspace],toolCall:{name,args}},config);
 for(const [name,args] of [['run_command',{CommandLine:'true'}],['search_web',{query:'x'}],['invoke_subagent',{}],['view_file',{AbsolutePath:'/etc/passwd'}],['write_to_file',{TargetFile:join(workspace,'.agents/hooks.json')}],['view_file',{AbsolutePath:join(workspace,'tools/link.py')}],['view_file',{AbsolutePath:join(workspace,'tools/hard.py')}],['write_to_file',{TargetFile:join(workspace,'tools/new.py'),IsArtifact:true}]])assert.equal((await run(name,args)).decision,'deny',name);
 assert.equal((await run('write_to_file',{TargetFile:join(workspace,'tools/new.py')})).decision,'allow');
 assert.equal((await run('list_dir',{DirectoryPath:workspace})).decision,'allow');
 assert.equal((await gateTool({workspacePaths:[workspace],toolCall:{name:'list_dir',args:{DirectoryPath:workspace}}},{...config,deadlineAt:0})).decision,'deny');
});
test('hook follows official camelCase payload, records no file contents, and fails closed',async()=>{
 const workspace=await mkdtemp('/tmp/calcifer-gate-payload-');await writeFile(join(workspace,'pyproject.toml'),'example');
 const configPath=join(workspace,'config.json'),auditPath=join(workspace,'audit.jsonl');await writeFile(configPath,JSON.stringify({workspace,deadlineAt:Date.now()+10000,auditPath}));
 let output='';const sink=new Writable({write(chunk,encoding,done){output+=chunk;done();}});
 await runGate(configPath,Readable.from([JSON.stringify({conversationId:'id',workspacePaths:[workspace],stepIdx:1,toolCall:{name:'view_file',args:{AbsolutePath:join(workspace,'pyproject.toml')}}})]),sink);
 assert.equal(JSON.parse(output).decision,'allow');assert.equal(JSON.parse(await readFile(auditPath,'utf8')).name,'view_file');assert.doesNotMatch(await readFile(auditPath,'utf8'),/example|AbsolutePath/);
 output='';await runGate('/missing',Readable.from(['bad']),sink);assert.equal(JSON.parse(output).decision,'deny');
});
