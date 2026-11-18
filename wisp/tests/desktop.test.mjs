import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

async function load(){
  let session='chat-a',epoch=1;
  let hookIndex=0;
  const states=[],effects=[],pendingEffects=[],timers=new Set();
  const useState=initial=>{
    const index=hookIndex++;
    if(!(index in states))states[index]=initial;
    return [states[index],next=>{states[index]=typeof next==='function'?next(states[index]):next;}];
  };
  const useEffect=(effect,deps)=>{
    const index=hookIndex++,old=effects[index];
    if(!old||deps.some((value,i)=>value!==old.deps[i]))pendingEffects.push(()=>{
      old?.cleanup?.();effects[index]={deps,cleanup:effect()};
    });
  };
  const atom=get=>({get});
  const sdk={host:{state:{focusedStoredSessionId:atom(()=>session),profile:atom(()=>''),focusedSessionProfile:atom(()=>'')}},gatewayActivationEpoch:()=>epoch,
    useGatewayActivationEpoch:()=>epoch,useValue:a=>a.get(),Button:'button',Textarea:'textarea',TRANSCRIPT_DIRECTIVE_AREA:'transcript.directives'};
  const context=vm.createContext({console,crypto:webcrypto,setTimeout,clearTimeout,setInterval:fn=>{timers.add(fn);return fn;},clearInterval:fn=>timers.delete(fn),URLSearchParams});
  const jsx=(type,props,...children)=>({type,props:{...props,children:children.length?children:props?.children}});
  const modules={
    '@hermes/plugin-sdk':new vm.SyntheticModule(Object.keys(sdk),function(){for(const[k,v]of Object.entries(sdk))this.setExport(k,v);},{context}),
    react:new vm.SyntheticModule(['createElement','useState','useEffect'],function(){this.setExport('createElement',jsx);this.setExport('useState',useState);this.setExport('useEffect',useEffect);},{context})};
  const module=new vm.SourceTextModule(await readFile('wisp/extensions/core/desktop/plugin.js','utf8'),{context});
  await module.link(name=>modules[name]);await module.evaluate();
  const mountElement=element=>({
    render:()=>{hookIndex=0;const tree=element.type(element.props);while(pendingEffects.length)pendingEffects.shift()();return tree;},
    poll:async()=>{for(const timer of timers)await timer();},flush:()=>new Promise(resolve=>setImmediate(resolve))});
  return {api:module.namespace,switchSession:()=>{session='chat-b';epoch++;},mount:ctx=>{
    const contributions=[];module.namespace.default.register({...ctx,register:c=>contributions.push(c)});
    return mountElement(contributions[0].render());
  },mountOverview:ctx=>mountElement({type:module.namespace.SourceOverview,props:{ctx}}),
    mountCard:props=>mountElement({type:module.namespace.TaskCard,props}),
    mountNotes:props=>mountElement({type:module.namespace.TaskNotes,props})};
}

function nodes(tree){return tree&&typeof tree==='object'?[tree,...(tree.props?.children??[]).flatMap(nodes)]:[];}
function content(tree){return nodes(tree).flatMap(node=>(node.props?.children??[]).filter(child=>typeof child==='string')).join(' ');}
function card(tree){return nodes(tree).find(node=>node.props?.task)?.props;}

const overviewFixture={sources:{hermes_default:{provider:'agy',model:'hydrogen'},config_status:'read',
  development_sources:[{id:'hermes-openai-codex',label:'ChatGPT／Codex 訂閱',protocol:'responses'}],authentication_checked:false,
  automatic_fallback:false,platform_supported:true,runtime_configured:true,executor:'OpenCode'},usage:{scope:'current-session',
  task_count:2,requests_used:8,dispatch_committed:7,unknown_tasks:1,unattributed_requests:0,
  request_states:{reserved:0,inflight:0,completed:6,failed:0,unknown:1,cancelled:1,unrecognized:0},
  by_model:[{provider:'hermes-openai-codex',model:'example-model',task_count:2,requests_used:8,dispatch_committed:7}],
  account_quota:null,tokens:null,cost:null}};

test('source and usage panel is a local read with no claim of account quota or integration',async()=>{
  const {api,mountOverview,switchSession}=await load();
  assert.equal(typeof api.SourceOverview,'function');
  const calls=[];const flow=mountOverview({rest:async(...args)=>{calls.push(args);return overviewFixture;}});
  const button=nodes(flow.render()).find(node=>node.type==='button');
  assert.equal(calls.length,0);
  await button.props.onClick();const text=content(flow.render());
  assert.equal(calls.length,1);assert.match(calls[0][0],/overview\?session_id=chat-a/);
  assert.equal(calls[0].length,1);
  for(const pattern of [/hydrogen/,/example-model/,/尚未接通/,/未查詢/,/不是.*帳戶/])assert.match(text,pattern);
  switchSession();assert.doesNotMatch(content(flow.render()),/example-model|hydrogen/);
});

test('a late usage response cannot be displayed in another session',async()=>{
  const {api,mountOverview,switchSession}=await load();
  assert.equal(typeof api.SourceOverview,'function');
  let finish;const flow=mountOverview({rest:()=>new Promise(resolve=>{finish=resolve;})});
  const request=nodes(flow.render()).find(node=>node.type==='button').props.onClick();
  switchSession();flow.render();finish(overviewFixture);await request;
  assert.doesNotMatch(content(flow.render()),/example-model|hydrogen/);
});

test('execution controls fail closed on missing or blocked capability while review and cancel remain available',async()=>{
  const {mountCard}=await load();
  const task={objective_id:'fixture',objective:'fixture',approval_version:1,status:'PROPOSED',provider:'hermes-openai-codex',model:'fixture',
    requests_used:0,limits:{max_requests:8,max_seconds:600},repo:'/fixture',allowed_paths:['app.py'],read_paths:['app.py'],
    allowed_commands:[{id:'test',argv:['python3','app.py']}],requests:[],permissions:[],checks:[],events:[]};
  const disabled={ready:false,issues:[{code:'EXECUTOR_PLATFORM_NOT_VERIFIED',message:'Windows 尚未驗證'}]};
  for(const capabilities of [undefined,{development:disabled,verification:disabled}]){
    const flow=mountCard({task:{...task,capabilities},act:()=>{},busy:false});
    const tree=flow.render();
    assert.equal(nodes(tree).find(n=>n.type==='button'&&content(n)==='批准開發').props.disabled,true);
    assert.equal(nodes(tree).find(n=>n.type==='button'&&content(n)==='拒絕提案').props.disabled,false);
    assert.match(content(tree),/尚未|無法/);
  }
  const ready={ready:true,issues:[],kernel_isolation_verified:false};
  const running=mountCard({task:{...task,status:'RUNNING',capabilities:{development:disabled,verification:disabled}},act:()=>{},busy:false});
  assert.equal(nodes(running.render()).find(n=>n.type==='button'&&content(n)==='取消這個任務').props.disabled,false);
  const good=mountCard({task:{...task,capabilities:{development:ready,verification:ready}},act:()=>{},busy:false});
  assert.equal(nodes(good.render()).find(n=>n.type==='button'&&content(n)==='批准開發').props.disabled,false);
});

test('source overview distinguishes static prerequisites from kernel isolation and reports the blocker',async()=>{
  const {mountOverview}=await load();
  const blocked={ready:false,issues:[{code:'CHECK_ISOLATION_UNAVAILABLE',message:'缺少 bwrap；不會改用無隔離模式。'}],kernel_isolation_verified:false};
  const fixture={...overviewFixture,sources:{...overviewFixture.sources,capabilities:{development:blocked,verification:blocked}}};
  const flow=mountOverview({rest:async()=>fixture});
  await nodes(flow.render()).find(n=>n.type==='button').props.onClick();
  const text=content(flow.render());
  assert.match(text,/bwrap/);assert.match(text,/核心.*尚未|尚未.*核心/);
  assert.doesNotMatch(text,/執行環境已配置/);
});

test('offline verification can proceed without model runtime, while revision remains blocked',async()=>{
  const {mountCard}=await load();
  const task={objective_id:'fixture',objective:'fixture',approval_version:1,status:'FAILED',process_status:'PROCESS_TERMINATED',
    provider:'hermes-openai-codex',model:'fixture',requests_used:1,limits:{max_requests:8,max_seconds:600},repo:'/fixture',
    allowed_paths:['app.py'],read_paths:['app.py'],allowed_commands:[{id:'test',argv:['python3','app.py']}],requests:[],permissions:[],checks:[],events:[],
    capabilities:{development:{ready:false,issues:[{code:'EXECUTOR_RUNTIME_MISSING',message:'尚未配置模型執行環境。'}]},verification:{ready:true,issues:[]}}};
  const actions=[];const flow=mountCard({task,busy:false,act:async(t,action)=>{
    actions.push(action);return {files:['app.py'],max_seconds:120,commands:task.allowed_commands,token:'x'};
  }});
  const button=label=>nodes(flow.render()).find(n=>n.type==='button'&&content(n)===label);
  nodes(flow.render()).find(n=>n.type==='textarea').props.onChange({target:{value:'fix this'}});
  assert.equal(button('批准這次修正').props.disabled,true);
  assert.equal(button('預覽重新驗證').props.disabled,false);
  await button('預覽重新驗證').props.onClick();
  assert.equal(button('批准離線檢查（不呼叫模型）').props.disabled,false);
  task.capabilities.verification={ready:false,issues:[{code:'CHECK_ISOLATION_UNAVAILABLE',message:'缺少隔離工具。'}]};
  assert.equal(button('批准離線檢查（不呼叫模型）').props.disabled,true);
  assert.deepEqual(actions,['preview_verify']);
});

test('notes require explicit save and retain the same operation ID after a lost response',async()=>{
  const {mountNotes}=await load();const calls=[];let success=false;
  const props={task:{objective_id:'fixture',notes:[]},busy:false,act:async(task,action,extra)=>{
    calls.push({action,...extra});return success?{status:'PROPOSED',notes:[]}:null;
  }};
  const flow=mountNotes(props);
  const button=()=>nodes(flow.render()).find(n=>n.type==='button'&&content(n)==='保存這筆紀錄');
  assert.equal(button().props.disabled,true);
  nodes(flow.render()).find(n=>n.type==='textarea').props.onChange({target:{value:'Keep existing login'}});
  assert.equal(calls.length,0);assert.equal(button().props.disabled,false);
  await button().props.onClick();await button().props.onClick();
  assert.equal(calls[0].action,'record_note');assert.match(calls[0].note_id,/^[a-f0-9]{32}$/);
  assert.equal(calls[0].note_id,calls[1].note_id);
  assert.equal(nodes(flow.render()).find(n=>n.type==='textarea').props.value,'Keep existing login');
  success=true;await button().props.onClick();
  assert.equal(nodes(flow.render()).find(n=>n.type==='textarea').props.value,'');
  assert.match(content(flow.render()),/不.*執行.*工作/);
});

test('task note controls preserve withdrawn decisions and only change note status',async()=>{
  const {mountNotes}=await load();const calls=[];
  const source={session_id:'chat-a',objective_id:'fixture',approval_version:1,channel:'gui'};
  const task={objective_id:'fixture',notes:[
    {id:'a'.repeat(32),kind:'todo',status:'open',text:'Need acceptance',revision:2,source,created_at:1},
    {id:'b'.repeat(32),kind:'decision',status:'withdrawn',text:'OLD_DECISION',revision:2,source,created_at:1}]};
  const flow=mountNotes({task,busy:false,act:async(t,action,extra)=>{calls.push({action,...extra});return t;}});
  const tree=flow.render();assert.match(content(tree),/OLD_DECISION/);assert.match(content(tree),/已撤回/);
  const button=nodes(tree).find(n=>n.type==='button'&&content(n)==='標記完成');await button.props.onClick();
  assert.deepEqual(calls,[{action:'update_note',note_id:'a'.repeat(32),note_revision:2,note_status:'done'}]);
  assert.equal(nodes(tree).filter(n=>n.type==='button'&&content(n)==='撤回這筆決策').length,0);
});

test('action failure persists through polling and explains the conflict',async()=>{
  const {mount}=await load();
  const task={objective_id:'x',approval_version:1};
  const flow=mount({rest:async(path,options)=>{if(options)throw Error('SOURCE_CHANGED');return {tasks:[task]};}});
  flow.render();await flow.flush();
  await card(flow.render()).act(task,'apply');
  assert.match(content(flow.render()),/SOURCE_CHANGED/);
  await flow.poll();
  const text=content(flow.render());
  assert.match(text,/SOURCE_CHANGED/);
  assert.match(text,/來源.*變更|來源.*改變/);
  assert.doesNotMatch(text,/後端已啟用/);
});

test('action errors and success notices never leak into the next session',async()=>{
  for(const reject of [true,false]){
    const {mount,switchSession}=await load();
    const task={objective_id:'x',approval_version:1,status:'ACCEPTED',integration:{status:'APPLIED'}};
    const flow=mount({rest:async(path,options)=>{if(options){if(reject)throw Error('CANDIDATE_CHANGED');return task;}return {tasks:[task]};}});
    flow.render();await flow.flush();await card(flow.render()).act(task,'apply');
    assert.match(content(flow.render()),reject?/CANDIDATE_CHANGED/:/已套回/);
    switchSession();
    assert.doesNotMatch(content(flow.render()),/CANDIDATE_CHANGED|已套回/);
  }
});

test('recovered polling clears only fetch errors; an explicit action clears the old action error',async()=>{
  const {mount}=await load();let fetchFails=true,actionFails=true;
  const task={objective_id:'x',approval_version:1};
  const flow=mount({rest:async(path,options)=>{
    if(options){if(actionFails)throw Error('VERSION_CONFLICT');return task;}
    if(fetchFails)throw Error('FETCH_OFFLINE');return {tasks:[task]};
  }});
  flow.render();await flow.flush();assert.match(content(flow.render()),/FETCH_OFFLINE/);
  fetchFails=false;await flow.poll();assert.doesNotMatch(content(flow.render()),/FETCH_OFFLINE/);
  await card(flow.render()).act(task,'approve');assert.match(content(flow.render()),/VERSION_CONFLICT/);
  actionFails=false;await card(flow.render()).act(task,'approve');assert.doesNotMatch(content(flow.render()),/VERSION_CONFLICT/);
});

test('stale session actions cannot send or publish into another session',async()=>{
  const {api,switchSession}=await load();const scope=api.currentScope();let calls=0;
  switchSession();
  await assert.rejects(api.performAction({rest:async()=>{calls++;}},scope,{objective_id:'x',approval_version:1},'approve'),/對話/);
  assert.equal(calls,0);
});

test('unknown and failed checks never enable acceptance',async()=>{
  const {api}=await load();
  const task={status:'REVIEW',approval_version:1,candidate_fingerprint:'one',requests:[],allowed_commands:[{id:'test'}],checks:[{id:'test',version:1,fingerprint:'one',exit_code:0}]};
  assert.equal(api.canAccept(task),true);
  for(const changed of [{...task,status:'TERMINATION_UNKNOWN'},{...task,checks:[]},{...task,candidate_fingerprint:'changed'},
    {...task,requests:[{status:'unknown'}]}])assert.equal(api.canAccept(changed),false);
});

test('desktop registers one same-window pane and one transcript directive',async()=>{
  const {api}=await load();const contributions=[];
  api.default.register({register:c=>contributions.push(c)});
  assert.deepEqual(Array.from(contributions,c=>c.area),['panes','transcript.directives']);
  assert.equal(contributions[0].title,'Wisp 任務');
  assert.equal(contributions[1].data.name,'wisp-task');
});

test('source application requires accepted state and preview matching its version',async()=>{
  const {api}=await load();
  assert.equal(typeof api.canApply,'function');
  const task={objective_id:'x',approval_version:2,status:'ACCEPTED',requests:[]};
  const preview={objective_id:'x',approval_version:2,ready:true,token:'a'.repeat(64)};
  assert.equal(api.canApply(task,preview),true);
  for(const changed of [{...task,status:'REVIEW'},{...task,approval_version:3},{...task,integration:{status:'APPLYING'}},
    {...task,requests:[{status:'unknown'}]}])assert.equal(api.canApply(changed,preview),false);
  assert.equal(api.canApply(task,{...preview,ready:false}),false);
  assert.equal(api.canApply(task,{...preview,objective_id:'other'}),false);
});

test('progress text distinguishes source application from acceptance and budget stop',async()=>{
  const {api}=await load();
  assert.equal(typeof api.integrationMessage,'function');
  assert.match(api.integrationMessage({status:'ACCEPTED'}),/尚未套用/);
  assert.match(api.integrationMessage({integration:{status:'APPLIED'}}),/已套回/);
  assert.match(api.integrationMessage({integration:{status:'RECOVERY_REQUIRED',conflicts:['app.py']}}),/保留/);
  assert.equal(typeof api.failureMessage,'function');
  assert.match(api.failureMessage({error:'REQUEST_LIMIT'}),/額度/);
});

test('long objectives remain readable and offline verification cannot recover unknown requests',async()=>{
  const {api}=await load();
  assert.equal(api.objectivePreview('Short objective'),'Short objective');
  assert.equal(api.objectivePreview('字'.repeat(8000)).length,181);
  const task={status:'FAILED',process_status:'PROCESS_TERMINATED',requests:[{status:'completed'}],completion:null};
  assert.equal(api.canVerify(task),true);
  for(const modified of [{...task,status:'TERMINATION_UNKNOWN'},{...task,status:'VERIFYING'},
    {...task,requests:[{status:'unknown'}]},{...task,completion:{}}])assert.equal(api.canVerify(modified),false);
});

test('verification badges require current version and fingerprint and reflect unknown termination',async()=>{
  const {api}=await load();
  const task={approval_version:2,candidate_fingerprint:'new',verification:{status:'PASSED',approval_version:1,fingerprint:'old'}};
  assert.doesNotMatch(api.verificationMessage(task),/現存候選已通過/);
  task.verification={status:'PASSED',approval_version:2,fingerprint:'new'};
  assert.match(api.verificationMessage(task),/現存候選已通過/);
  task.verification={status:'TERMINATION_UNKNOWN'};
  assert.match(api.verificationMessage(task),/尚未確認/);
  assert.doesNotMatch(api.verificationMessage(task),/正在執行/);
});
