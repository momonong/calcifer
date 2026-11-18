import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const worker = resolve('wisp/executors/opencode-worker.mjs');
const bun = resolve('node_modules/.bin/bun');

function sse(index, args) {
  const delta = args ? {role:'assistant',tool_calls:[{index:0,id:`call_${index}`,type:'function',function:{name:'wisp_workspace',arguments:JSON.stringify(args)}}]} : {role:'assistant',content:'The candidate was changed and its test passed.'};
  return `data: ${JSON.stringify({id:`response_${index}`,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\n` +
    `data: ${JSON.stringify({id:`response_${index}`,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:args?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:15,total_tokens:35}})}\n\ndata: [DONE]\n\n`;
}

test('official SDK performs read/edit/check and settles, with host-owned transport and no credentials', {timeout:30000}, async () => {
  const root = await mkdtemp(join(tmpdir(),'wisp-sdk-'));
  const directory=join(root,'candidate'); await mkdir(directory);
  await writeFile(join(directory,'app.py'),'answer = 1\n');
  let stderr='', requests=0, settled, failure;
  const tools=[];
  const child=spawn(bun,[worker],{env:{PATH:process.env.PATH, SHOULD_NOT_REACH_SDK:'secret-canary'},stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',b=>stderr+=b.toString());
  const done = new Promise((res,rej)=>{child.on('error',rej);child.on('close',code=>res(code));});
  const lines=createInterface({input:child.stdout});
  const processing=(async()=>{
    for await(const line of lines){
      const msg=JSON.parse(line);
      if(msg.kind==='model'){
        requests++;
        assert.equal(msg.data.url,'https://wisp.invalid/v1/chat/completions');
        assert.ok(!JSON.stringify(msg).includes('secret-canary'));
        const steps=[{action:'read',path:'app.py'},{action:'edit',path:'app.py',content:'answer = 2\n'},{action:'check',command_id:'test'}];
        child.stdin.write(JSON.stringify({reply:msg.id,result:{status:200,headers:{'content-type':'text/event-stream'},body:sse(requests,steps[requests-1])}})+'\n');
      }else if(msg.kind==='tool'){
        tools.push(msg.data.action);
        let result;
        if(msg.data.action==='read')result={content:await readFile(join(directory,'app.py'),'utf8')};
        else if(msg.data.action==='edit'){await writeFile(join(directory,'app.py'),msg.data.content);result={written:true};}
        else result={exit_code:0,stdout:'1 passed'};
        child.stdin.write(JSON.stringify({reply:msg.id,result})+'\n');
      }else if(msg.kind==='settled')settled=msg.data;
      else if(msg.kind==='fatal')failure=msg.data;
    }
  })();
  child.stdin.write(JSON.stringify({kind:'start',data:{directory,control_dir:join(root,'control'),model:'fixture-model',protocol:'chat',objective:'Fix the answer and check it.',allowed_paths:['app.py'],read_paths:['app.py'],allowed_commands:[{id:'test',argv:['python3','-B','test.py']}],native_session:null}})+'\n');
  try{
    const code=await done;await processing;
    assert.equal(code,0,JSON.stringify({stderr,failure,settled}));
    assert.equal(settled?.success,true,JSON.stringify({settled,failure,stderr}));
    assert.deepEqual(tools,['read','edit','check']);
    assert.equal(requests,4);
    assert.ok(settled.native_session);
    assert.equal(await readFile(join(directory,'app.py'),'utf8'),'answer = 2\n');
  }finally{child.kill('SIGKILL');await rm(root,{recursive:true,force:true});}
});
