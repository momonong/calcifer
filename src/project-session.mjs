import {mkdir,readFile,readdir,lstat,unlink} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {hash,digest,fail,secureRoot,writeDurable,materializeSnapshot} from './workspace-tools.mjs';
import {prepareProjectWorkspace,readProjectSnapshot,readSourceSnapshot,verifyProjectChanges,exportProjectPatch} from './project-workspace.mjs';
import {bindPythonRuntime,runP1Check} from './p1-check.mjs';
import {AGY_MODEL} from './agy-worker.mjs';
import {LEGACY_PROFILE,validateProfile,canEditProject,projectCheck} from './project-profile.mjs';
import {executionProfile,validateExecution,selectedWorker,MAX_EXECUTION_MINUTES,MAX_PROJECT_CALLS} from './project-execution.mjs';
import {validateRouting,selectRoute,parseGoalPlan,assignGoalPlan,planningPrompt} from './project-routing.mjs';
import {buildPreparedInputContext,completionInstruction,checkPreparedCompletion} from './prepared-inputs.mjs';

const VERSION='1.5.3', UUID=/^[a-f0-9-]{36}$/;
const profileOf=s=>s.profile??LEGACY_PROFILE;
const executionOf=s=>s.execution??executionProfile('agy');
const gateOf=s=>s.schemaVersion===2?fileURLToPath(new URL('./project-tool-gate.mjs',import.meta.url)):GATE;
const GATE=fileURLToPath(new URL('./agy-tool-gate.mjs',import.meta.url));
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=(p,v,exclusive=false)=>writeDurable(p,JSON.stringify(v,null,2)+'\n',exclusive);
const stamp=()=>new Date().toISOString();
const code=e=>/^[A-Z_0-9]+$/.test(e.message)?e.message:'PROJECT_OPERATION_FAILED';
const shell=s=>"'"+s.replaceAll("'","'\\''")+"'";

// Kernel-owned lock is released if the caller exits; pending intent remains durable.
async function withLock(stateDir,fn){
  await secureRoot(stateDir);
  const lock=spawn('/usr/bin/flock',['--exclusive','--nonblock','-E','73',join(stateDir,'session.lock'),process.execPath,'-e',"process.stdout.write('locked\\n');process.stdin.resume();"],{stdio:['pipe','pipe','ignore']});
  await new Promise((ok,no)=>{lock.once('error',no);lock.once('exit',()=>no(new Error('PROJECT_BUSY')));lock.stdout.once('data',()=>ok());});
  try{return await fn();}finally{lock.stdin.end();await new Promise(done=>{if(lock.exitCode!==null)done();else lock.once('exit',done);});}
}
// Bind a remote command to its native completion before returning across HTTP.
// Reading an existing unfinished receipt never dispatches the command again.
async function withRemoteLock(stateDir,action,operationId,fn){
  if(operationId!==null&&!UUID.test(operationId))fail('PROJECT_OPERATION_ID_INVALID');
  return withLock(stateDir,async()=>{
    if(operationId===null)return fn();
    const dir=join(stateDir,'remote-operations'),path=join(dir,operationId+'.json');await mkdir(dir,{recursive:true,mode:0o700});await secureRoot(dir);
    let prior;try{prior=await json(path);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(prior){if(prior.operationId!==operationId||prior.action!==action)fail('PROJECT_OPERATION_CONFLICT');if(prior.phase==='completed')return prior.result;if(prior.phase==='failed')fail(prior.error);fail('PROJECT_OPERATION_UNKNOWN');}
    const receipt={operationId,action,phase:'started',at:stamp()};await save(path,receipt,true);
    let result;try{result=await fn();}catch(e){if(e.known)await save(path,{...receipt,phase:'failed',error:code(e),finishedAt:stamp()});throw e;}
    await save(path,{...receipt,phase:'completed',result,finishedAt:stamp()});return result;
  });
}
async function state(stateDir){
  await secureRoot(stateDir);const s=await json(join(stateDir,'project.json'));
  if(![1,2].includes(s.schemaVersion)||!UUID.test(s.projectId)||s.workspaceDir!==join(stateDir,'workspace'))fail('PROJECT_STATE_INVALID');
  if(s.schemaVersion===1&&s.model!==AGY_MODEL)fail('PROJECT_STATE_INVALID');
  if(s.schemaVersion===2){validateExecution(s.execution);if(digest(validateProfile(s.profile))!==s.profileHash||digest(s.execution)!==s.executionHash||s.model!==s.execution.model||digest(s.sourceFiles)!==digest(s.profile.sourceFiles))fail('PROJECT_STATE_INVALID');}
  if(s.routing&&digest(validateRouting(s.routing))!==s.routingHash)fail('PROJECT_ROUTING_CHANGED');
  return s;
}
async function put(stateDir,s){await save(join(stateDir,'project.json'),s);}
function settled(s){if(s.pending)fail('PROJECT_PENDING');}
async function controls(s){
  for(const [path,expected] of Object.entries(s.controls))if(hash(await readFile(join(s.workspaceDir,path)))!==expected)fail('PROJECT_CONTROL_CHANGED');
  if(s.schemaVersion===1||executionOf(s).backend==='agy'||s.routing){
  const entries=await readdir(join(s.workspaceDir,'.agents'));if(entries.sort().join(',')!=='agents,hooks.json')fail('PROJECT_CONTROL_CHANGED');
  if((await readdir(join(s.workspaceDir,'.agents/agents'))).join(',')!==`${s.schemaVersion===1?'calcifer-thor':'calcifer-worker'}.md`)fail('PROJECT_CONTROL_CHANGED');
  }
  if(hash(await readFile(gateOf(s)))!==s.gateHash)fail('PROJECT_GATE_CHANGED');
  const context=await json(join(dirname(s.workspaceDir),'context.json'));
  if(digest({sources:context.sources,text:context.text})!==context.hash||context.hash!==s.contextHash)fail('PROJECT_CONTEXT_CHANGED');
  for(const source of context.sources)if(hash(await readFile(source.path))!==source.hash)fail('PROJECT_CONTEXT_SOURCE_CHANGED');
  return context;
}
async function snapshots(stateDir,s){
  const before=await readProjectSnapshot(join(stateDir,'initial')),after=await readProjectSnapshot(s.workspaceDir);
  if(before.manifest.hash!==s.initialManifest.hash)fail('PROJECT_INITIAL_CHANGED');
  const changes=verifyProjectChanges(before,after,profileOf(s));return{before,after,changes};
}
async function sourceMatches(s){try{return(await readSourceSnapshot(s.repo,s.sourceFiles)).manifest.hash===s.initialManifest.hash;}catch{return false;}}
async function statusOf(stateDir,s){
  let files=[],changes=[],workspaceError,workspaceManifestHash;
  try{const values=await snapshots(stateDir,s);workspaceManifestHash=values.after.manifest.hash;files=values.after.manifest.files.map(f=>f.path);changes=values.changes.map(f=>({path:f.path,beforeHash:f.beforeHash,afterHash:f.afterHash}));}catch(error){workspaceError=code(error);}
  return {projectId:s.projectId,remoteCommandId:s.remoteCommandId??null,cancellation:s.cancellation??null,projectName:profileOf(s).name,backend:executionOf(s).backend,execution:executionOf(s),profile:profileOf(s),routing:s.routing??null,goal:s.goal??null,status:s.pending?'unknown':workspaceError?'failed':s.status,code:workspaceError??s.code,repo:s.repo,workspaceDir:s.workspaceDir,conversationId:s.conversationId,model:s.model,agyVersion:executionOf(s).backend==='agy'?s.agyVersion:undefined,turnsUsed:s.budget?.used??0,maxTurns:s.budget?.maxTurns??null,maxMinutes:s.budget?.maxMinutes??null,deadlineAt:s.budget?.deadlineAt??null,lastTask:s.lastTask,lastResponse:s.lastTask?.response,lastChecks:s.lastChecks,changedFiles:changes,files,workspaceManifestHash,workspaceError:workspaceError??null,sourceMatches:await sourceMatches(s),contextHash:s.contextHash,pending:s.pending,authorization:s.budget?.note??null};
}
export async function projectStatus({stateDir}){return statusOf(stateDir,await state(stateDir));}

export async function createProject({stateDir,repo,sourceFiles,seedContents={},context,model,effort,agyVersion=VERSION,profile,backend='agy',routing}){
  const legacy=profile===undefined;
  if(routing){routing=validateRouting(routing);if(legacy)fail('ROUTING_REQUIRES_PROJECT_PROFILE');}
  const execution=routing?{...routing.profiles.find(p=>p.id===routing.planner).execution}:executionProfile(backend,{model,effort});
  if(legacy)model??=AGY_MODEL;
  if(resolve(stateDir)!==stateDir||legacy&&(model!==AGY_MODEL||agyVersion!==VERSION||backend!=='agy'))fail('PROJECT_PROFILE_INVALID');
  if(!legacy){profile=validateProfile(profile);if(sourceFiles&&digest([...sourceFiles].sort())!==digest(profile.sourceFiles))fail('PROJECT_SOURCE_SCOPE_INVALID');sourceFiles=profile.sourceFiles;model=execution.model;}
  const selectedProfile=profile??LEGACY_PROFILE,gate=legacy?GATE:fileURLToPath(new URL('./project-tool-gate.mjs',import.meta.url)),agentName=legacy?'calcifer-thor':'calcifer-worker';
  if(!context||typeof context.text!=='string'||!Array.isArray(context.sources)||digest({sources:context.sources,text:context.text})!==context.hash)fail('PROJECT_CONTEXT_INVALID');
  await secureRoot(repo);if(stateDir===repo||stateDir.startsWith(repo+'/')||repo.startsWith(stateDir+'/'))fail('STATE_ROOT_INSIDE_SOURCE');
  await mkdir(dirname(stateDir),{recursive:true,mode:0o700});await secureRoot(dirname(stateDir));
  try{await mkdir(stateDir,{mode:0o700});}catch(error){if(error.code==='EEXIST')fail('PROJECT_EXISTS');throw error;}
  return withLock(stateDir,async()=>{
    const workspace=await prepareProjectWorkspace({repo,stateDir,sourceFiles,seedContents,profile:selectedProfile});
    for(const rule of selectedProfile.writeRules){await mkdir(join(workspace.workspaceDir,rule.root),{recursive:true,mode:0o700});await secureRoot(join(workspace.workspaceDir,rule.root));}
    for(const folder of ['tasks','checks','exports','protected'])await mkdir(join(stateDir,folder),{mode:0o700});
    await save(join(stateDir,'context.json'),context,true);
    const seeded=await readProjectSnapshot(workspace.workspaceDir);
    const protectedTests=Object.fromEntries(Object.entries(seeded.contents).filter(([p])=>p.startsWith(selectedProfile.check.testDir+'/')));
    await save(join(stateDir,'protected/tests.json'),protectedTests,true);
    const agent=`---\nname: ${agentName}\ndescription: Project developer with Calcifer host tests\ntools:\n  - view_file\n  - list_dir\n  - find_by_name\n  - grep_search\n  - write_to_file\n  - replace_file_content\n  - multi_replace_file_content\nmainAgent: true\nsubagent: false\nmodel: inherit\ncommandExecutionPolicy: off\n---\nDevelop only this isolated workspace. Read AGENTS.md and applicable project requirements. Only file tools are available under the Calcifer gate. The host runs Python tests after your turn, so do not claim to have executed them. Preserve input fixtures and frozen rules. Do not use shell, web, MCP, subagents, services, credentials, hardware or other workspaces. Finish when the requested change and relevant tests are written; report concise changes and remaining limitations.\n`;
    const hook={"calcifer-file-scope":{PreToolUse:[{matcher:'*',hooks:[{type:'command',command:`${shell(process.execPath)} ${shell(gate)} ${shell(join(stateDir,'gate.json'))}`,timeout:5}]}]}};
    const controlFiles={'AGENTS.md':context.text,...(execution.backend==='agy'||routing?{[`.agents/agents/${agentName}.md`]:agent,'.agents/hooks.json':JSON.stringify(hook,null,2)+'\n'}:{})};
    for(const[path,text]of Object.entries(controlFiles)){await mkdir(dirname(join(workspace.workspaceDir,path)),{recursive:true,mode:0o700});await writeDurable(join(workspace.workspaceDir,path),text,true);}
    const s={schemaVersion:legacy?1:2,...(!legacy?{profile,profileHash:digest(profile),execution,executionHash:digest(execution)}:{}),...(routing?{routing,routingHash:digest(routing),goal:null}:{}),projectId:randomUUID(),createdAt:stamp(),...workspace,model,...(execution.backend==='agy'?{agyVersion}:{}),conversationId:null,status:'ready',contextHash:context.hash,gateHash:hash(await readFile(gate)),controls:Object.fromEntries(Object.entries(controlFiles).map(([p,t])=>[p,hash(t)])),protectedTestsHash:digest(protectedTests),budget:null,pending:null,tasks:0,lastTask:null,lastChecks:null};
    await put(stateDir,s);return statusOf(stateDir,s);
  });
}
export async function authorizeProject({stateDir,maxTurns,maxMinutes=null,note,allowedProfileIds,operationId=null}){
  if(!Number.isSafeInteger(maxTurns)||maxTurns<1||maxTurns>MAX_PROJECT_CALLS||(maxMinutes!==null&&(!Number.isSafeInteger(maxMinutes)||maxMinutes<1||maxMinutes>MAX_EXECUTION_MINUTES))||typeof note!=='string'||!note.trim()||note.length>4096)fail('AUTHORIZATION_INVALID');
  return withRemoteLock(stateDir,'authorize',operationId,async()=>{const s=await state(stateDir);settled(s);
    if(s.budget&&s.budget.used<s.budget.maxTurns&&(!s.budget.deadlineAt||Date.parse(s.budget.deadlineAt)>Date.now()))fail('AUTHORIZATION_ALREADY_ACTIVE');
    if(s.routing){allowedProfileIds??=s.routing.profiles.filter(p=>p.enabled).map(p=>p.id);if(!Array.isArray(allowedProfileIds)||!allowedProfileIds.length||new Set(allowedProfileIds).size!==allowedProfileIds.length||allowedProfileIds.some(id=>!s.routing.profiles.some(p=>p.id===id)))fail('ROUTING_AUTHORIZATION_INVALID');}
    else if(allowedProfileIds!==undefined)fail('ROUTING_AUTHORIZATION_INVALID');
    s.budget={remoteCommandId:operationId,executionHash:digest(executionOf(s)),profileHash:digest(profileOf(s)),...(s.routing?{routingHash:s.routingHash,allowedProfileIds:[...allowedProfileIds],usedByProfile:{}}:{}),id:randomUUID(),authorizedAt:stamp(),note,maxTurns,maxMinutes,used:0,startedAt:null,deadlineAt:null};await save(join(stateDir,`authorization-${s.budget.id}.json`),s.budget,true);await put(stateDir,s);return statusOf(stateDir,s);
  });
}
function budget(s){if(s.routing?s.budget?.routingHash&&s.budget.routingHash!==s.routingHash:s.budget?.executionHash&&s.budget.executionHash!==digest(executionOf(s)))fail('AUTHORIZATION_SCOPE_CHANGED');if(s.budget?.profileHash&&s.budget.profileHash!==digest(profileOf(s)))fail('AUTHORIZATION_SCOPE_CHANGED');if(!s.budget)fail('AUTHORIZATION_REQUIRED');if(s.budget.used>=s.budget.maxTurns||s.budget.deadlineAt&&Date.parse(s.budget.deadlineAt)<=Date.now())fail('RESOURCE_LIMIT');}
async function checkCurrent(stateDir,s,{signal,force=false,checker=runP1Check}={}){
  await controls(s);const CHECK=projectCheck(profileOf(s));const {after}=await snapshots(stateDir,s),runtime=await bindPythonRuntime('/usr/bin/python3.12');
  const key=digest({manifest:after.manifest.hash,runtime,definition:CHECK,protectedTestsHash:s.protectedTestsHash});
  if(!force&&s.lastChecks?.key===key&&s.lastChecks.status==='passed')return{status:'passed',reused:true,checks:s.lastChecks.checks,key};
  const id=randomUUID(),checkDir=join(stateDir,'checks',id);await mkdir(checkDir,{mode:0o700});
  await materializeSnapshot(join(checkDir,'workspace'),after);
  const checks=[await checker({snapshotDir:join(checkDir,'workspace'),manifest:after.manifest,definition:CHECK,runtime,signal,stage:'project',checkId:'python-unittest'})];
  const originals=await json(join(stateDir,'protected/tests.json'));if(digest(originals)!==s.protectedTestsHash)fail('PROTECTED_TESTS_CHANGED');
  if(Object.entries(originals).some(([p,t])=>after.contents[p]!==t)){
    const protectedSnapshot={contents:{...after.contents,...originals},manifest:null};
    // Materialization only requires file paths; read back computes the actual manifest.
    protectedSnapshot.manifest={files:Object.keys(protectedSnapshot.contents).map(path=>({path}))};
    await materializeSnapshot(join(checkDir,'regression'),protectedSnapshot);
    const regression=await readProjectSnapshot(join(checkDir,'regression'));
    checks.push(await checker({snapshotDir:join(checkDir,'regression'),manifest:regression.manifest,definition:CHECK,runtime,signal,stage:'frozen-regression',checkId:'python-frozen-regression'}));
  }
  const result={status:checks.every(c=>c.status==='passed')?'passed':'failed',reused:false,key,checks,checkedAt:stamp(),manifestHash:after.manifest.hash};
  await save(join(checkDir,'result.json'),result,true);s.lastChecks=result;await put(stateDir,s);return result;
}
export async function testProject({stateDir,signal,force=false,operationId=null},deps={}){return withRemoteLock(stateDir,'test',operationId,async()=>{const s=await state(stateDir);settled(s);return checkCurrent(stateDir,s,{signal,force,...deps});});}

async function finalizeAttempt(stateDir,s,terminal,{signal,onEvent,checker}={}){
  const pending=s.pending;
  if(!terminal||terminal.status!=='SUCCESS'||!UUID.test(terminal.conversation_id)||s.conversationId&&terminal.conversation_id!==s.conversationId||terminal.actualModel&&terminal.actualModel!==s.model||terminal.requestedModel&&terminal.requestedModel!==s.model)fail('PROJECT_RESULT_IDENTITY_UNKNOWN');
  s.conversationId=terminal.conversation_id;pending.phase='checks';s.lastTask.response=terminal.response;
  await save(join(pending.evidenceDir,'accepted-terminal.json'),terminal);await put(stateDir,s);
  if(pending.kind==='plan'){
    await controls(s);const snapshot=await readProjectSnapshot(s.workspaceDir);
    if(snapshot.manifest.hash!==pending.beforeHash)fail('PLANNER_MODIFIED_WORKSPACE');
    s.pending=null;s.status='ready';s.code=null;s.lastTask.status='completed';s.lastTask.checks=[];s.lastTask.finishedAt=stamp();
    if(s.goal){s.goal.planResponse=terminal.response;s.goal.planManifestHash=snapshot.manifest.hash;}
    await save(join(stateDir,'tasks',pending.taskId,'result.json'),s.lastTask);await put(stateDir,s);
    return{status:'completed',taskId:pending.taskId,response:terminal.response,checks:[],attempts:s.lastTask.attempts,changedFiles:[],workspaceDir:s.workspaceDir,code:'PLAN_RECEIVED'};
  }
  onEvent?.({event:'checks',type:'python-unittest'});
  const completion=s.lastTask.inputContext?checkPreparedCompletion(terminal.response,s.lastTask.inputContext):null;
  s.lastTask.completion=completion?.report??null;
  const baseChecked=completion?.status==='failed'?{status:'failed',checks:[]}:await checkCurrent(stateDir,s,{signal,checker});
  const checked={...baseChecked,checks:completion?[...baseChecked.checks,{stage:'model-completion',kind:'self-report',...completion}]:baseChecked.checks};
  const resultCode=completion?.status==='failed'?completion.code:checked.status==='passed'?'CHECKS_PASSED':'CHECKS_FAILED';
  const {after,changes}=await snapshots(stateDir,s);
  s.pending=null;s.status='ready';s.code=null;s.lastTask.status=checked.status==='passed'?'completed':'failed';s.lastTask.checks=checked.checks;s.lastTask.finishedAt=stamp();s.lastTask.finalManifestHash=after.manifest.hash;
  if(s.goal&&pending.goalTaskId&&s.lastTask.status==='completed'&&!s.goal.results.some(r=>r.planTaskId===pending.goalTaskId))s.goal.results.push({planTaskId:pending.goalTaskId,taskId:pending.taskId,profileId:pending.route.profileId,execution:{...executionOf(s)},status:'completed',response:terminal.response,manifestHash:after.manifest.hash,checkKey:checked.key,...(s.lastTask.completion?{completion:s.lastTask.completion}:{})});
  if(s.goal&&pending.goalTaskId){
    if(s.lastTask.status==='completed'){s.goal.resume=null;s.goal.status='working';s.goal.code=null;}
    else{s.goal.status='failed';s.goal.code=resultCode;s.goal.failedBudgetId=s.budget.id;s.goal.resume=failedWorkerCheckpoint(s);}
  }
  await save(join(stateDir,'tasks',pending.taskId,'result.json'),s.lastTask);await put(stateDir,s);
  return{status:s.lastTask.status,taskId:pending.taskId,response:terminal.response,checks:checked.checks,attempts:s.lastTask.attempts,changedFiles:changes.map(c=>c.path),workspaceDir:s.workspaceDir,code:resultCode};
}
async function activateRoute(stateDir,s,route){
  // Native conversation IDs belong to one assigned task, backend and model.
  s.execution={...route.execution};s.executionHash=digest(s.execution);s.model=s.execution.model;s.conversationId=null;
  if(s.execution.backend==='agy')s.agyVersion=s.execution.version;
  await put(stateDir,s);
}
function failedWorkerCheckpoint(s){
  return{planTaskId:s.lastTask.goalTaskId,taskId:s.lastTask.id,execution:{...executionOf(s)},conversationId:s.conversationId,manifestHash:s.lastTask.finalManifestHash,checks:s.lastTask.checks.map(c=>({stage:c.stage,status:c.status,code:c.code,stdout:c.stdout?.slice(0,12000),stderr:c.stderr?.slice(0,12000)}))};
}
async function stopGoal(stateDir,s,result){
  const goal=s.goal;goal.status=result.status;goal.code=result.code;goal.failedBudgetId=s.budget.id;
  if(result.status==='failed'&&s.lastTask?.kind==='work'&&s.lastTask.goalTaskId&&s.lastTask.finalManifestHash&&s.lastTask.status==='failed'&&['CHECKS_FAILED','RESOURCE_LIMIT'].includes(result.code))goal.resume=failedWorkerCheckpoint(s);
  await put(stateDir,s);return{...result,goal};
}
async function runGoal(stateDir,s,{task,signal,onEvent,resume=false},deps){
  if(s.goal&&s.goal.task!==task&&s.goal.status!=='completed')fail('GOAL_INCOMPLETE');
  if(s.goal?.task===task&&s.goal.status==='completed'){
    await controls(s);const {after}=await snapshots(stateDir,s);
    if(after.manifest.hash!==s.goal.finalManifestHash)fail('GOAL_WORKSPACE_CHANGED');
    const checked=await checkCurrent(stateDir,s,{signal,checker:deps.checker});
    return{status:checked.status==='passed'?'completed':'failed',code:checked.status==='passed'?'GOAL_EVIDENCE_REUSED':'CHECKS_FAILED',goal:s.goal,response:s.goal.results.at(-1)?.response,checks:checked.checks,workspaceDir:s.workspaceDir};
  }
  if(!s.goal||s.goal.task!==task){
    budget(s);if(s.budget.maxTurns-s.budget.used<2)fail('GOAL_REQUIRES_PLANNER_AND_WORKER_BUDGET');
    selectRoute({routing:s.routing,kind:'plan',allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});
    s.goal={id:randomUUID(),task,status:'planning',createdAt:stamp(),planResponse:null,plan:null,assignments:[],results:[]};await put(stateDir,s);
  }
  const goal=s.goal;
  if(goal.status==='failed'){
    if(!goal.resume||!resume&&goal.failedBudgetId===s.budget.id)return{status:'failed',code:goal.code,goal,workspaceDir:s.workspaceDir};
    budget(s);goal.resumptions??=[];goal.resumptions.push({at:stamp(),fromTaskId:goal.resume.taskId,fromBudgetId:goal.failedBudgetId,budgetId:s.budget.id});goal.status='working';goal.code=null;await put(stateDir,s);
  }
  if(goal.planResponse===null){
    budget(s);const route=selectRoute({routing:s.routing,kind:'plan',allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});
    const maxTasks=Math.min(s.routing.maxTasks,s.budget.maxTurns-s.budget.used-1);
    if(maxTasks<1)fail('GOAL_REQUIRES_PLANNER_AND_WORKER_BUDGET');
    const files=(await readProjectSnapshot(s.workspaceDir)).manifest.files.map(f=>({path:f.path,bytes:f.bytes}));
    await activateRoute(stateDir,s,route);onEvent?.({event:'route',...route});
    const prompt=planningPrompt({goal:task,routing:s.routing,files,maxTasks,allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:{...s.budget.usedByProfile,[route.profileId]:(s.budget.usedByProfile[route.profileId]??0)+1}});
    const result=await executeTask(stateDir,s,{task:prompt,kind:'plan',route,signal,onEvent},deps);
    if(result.status!=='completed')return stopGoal(stateDir,s,result);
  }
  if(!goal.plan){
    try{
      goal.plan=parseGoalPlan(goal.planResponse,{routing:s.routing,maxTasks:s.budget.maxTurns-s.budget.used});
      goal.assignments=assignGoalPlan(goal.plan,{routing:s.routing,allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});
      goal.planHash=digest({plan:goal.plan,assignments:goal.assignments});goal.status='working';await put(stateDir,s);
    }catch(error){goal.status='failed';goal.code=code(error);s.status='failed';s.code=goal.code;await put(stateDir,s);return{status:'failed',code:goal.code,goal,workspaceDir:s.workspaceDir};}
  }
  if(goal.planHash!==digest({plan:goal.plan,assignments:goal.assignments}))fail('GOAL_PLAN_CHANGED');
  await controls(s);let current=await snapshots(stateDir,s);
  const acceptedHash=goal.resume?.manifestHash??goal.results.at(-1)?.manifestHash??goal.planManifestHash;
  if(current.after.manifest.hash!==acceptedHash)fail('GOAL_WORKSPACE_CHANGED');
  for(const part of goal.plan.tasks){
    if(goal.results.some(r=>r.planTaskId===part.id))continue;
    if(part.dependsOn.some(id=>!goal.results.some(r=>r.planTaskId===id)))fail('GOAL_DEPENDENCY_INCOMPLETE');
    const planned=goal.assignments.find(a=>a.taskId===part.id);
    try{
      budget(s);
      const selected=selectRoute({routing:s.routing,kind:part.kind,preferredProfileId:planned.profileId,allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});
      if(selected.profileId!==planned.profileId)fail('ASSIGNED_MODEL_RESOURCE_LIMIT');
      // A recovered completed task was appended atomically by finalizeAttempt.
      const correction=goal.resume?.planTaskId===part.id?goal.resume:null;
      if(correction){if(digest(correction.execution)!==digest(planned.execution)||s.conversationId!==correction.conversationId)fail('GOAL_RESUME_IDENTITY_CHANGED');}
      else{if(s.lastTask?.goalTaskId===part.id&&s.lastTask.status==='failed')fail(s.code??'GOAL_WORKER_FAILED');await activateRoute(stateDir,s,planned);}
      goal.activeTaskId=part.id;await put(stateDir,s);onEvent?.({event:'route',...planned});
      const request=`Original goal and acceptance (authoritative):\n${task}\n\nAssigned task ${part.id}:\n${part.task}\nAdditional proposed completion conditions: ${JSON.stringify(part.acceptance)}\nModel allocation: ${planned.profileId}; ${part.reason}.\nEarlier accepted task handoff: ${JSON.stringify(goal.results.map(r=>({taskId:r.planTaskId,response:r.response?.slice(0,3000)})))}\n${correction?`Continue the SAME known failed task under explicit correction authority. Diagnose the concrete failure and change the failing hypothesis; preserve tests. Host check evidence: ${JSON.stringify(correction.checks)}\n`:''}Keep the original goal, project scope and host checks. Planner suggestions do not grant new permissions.`;
      const result=await executeTask(stateDir,s,{task:request,route:planned,goalTaskId:part.id,signal,onEvent},deps);
      if(result.status!=='completed')return stopGoal(stateDir,s,result);
      goal.resume=null;await put(stateDir,s);
    }catch(error){if(s.pending)throw error;s.status='failed';s.code=code(error);return stopGoal(stateDir,s,{status:'failed',code:s.code,workspaceDir:s.workspaceDir});}
  }
  current=await snapshots(stateDir,s);
  if(current.after.manifest.hash!==goal.results.at(-1)?.manifestHash)fail('GOAL_WORKSPACE_CHANGED');
  const checked=await checkCurrent(stateDir,s,{signal,checker:deps.checker});
  if(checked.status!=='passed')return stopGoal(stateDir,s,{status:'failed',code:'CHECKS_FAILED',checks:checked.checks,workspaceDir:s.workspaceDir});
  goal.status='completed';goal.finishedAt=stamp();goal.activeTaskId=null;goal.resume=null;goal.finalManifestHash=current.after.manifest.hash;s.status='ready';s.code=null;await put(stateDir,s);
  await save(join(stateDir,`goal-${goal.id}.json`),goal);
  return{status:'completed',code:'GOAL_HOST_CHECKS_PASSED',goal,response:goal.results.at(-1)?.response,checks:s.lastChecks?.checks??[],workspaceDir:s.workspaceDir};
}
export async function workProject({stateDir,task,signal,onEvent,resume=false,operationId=null},deps={}){
  if(operationId!==null&&!UUID.test(operationId))fail('PROJECT_OPERATION_ID_INVALID');
  if(typeof task!=='string'||!task.trim()||Buffer.byteLength(task)>65536)fail('PROJECT_TASK_INVALID');
  return withRemoteLock(stateDir,'work',operationId,async()=>{
    const s=await state(stateDir);settled(s);s.remoteCommandId=operationId;await put(stateDir,s);
    if(s.routing)return runGoal(stateDir,s,{task,signal,onEvent,resume},deps);
    return executeTask(stateDir,s,{task,signal,onEvent},deps);
  });
}
export async function resumeProjectGoal({stateDir,signal,onEvent,operationId=null},deps={}){
  if(operationId!==null&&!UUID.test(operationId))fail('PROJECT_OPERATION_ID_INVALID');
  return withRemoteLock(stateDir,'resume',operationId,async()=>{const s=await state(stateDir);settled(s);if(!s.routing||!s.goal)fail('NO_ROUTED_GOAL');s.remoteCommandId=operationId;await put(stateDir,s);return runGoal(stateDir,s,{task:s.goal.task,signal,onEvent,resume:true},deps);});
}
// A concrete acceptance correction reopens the last assigned worker, never its planner
// or budget. Original completed receipts are archived intact before state changes.
export async function revisePreparedProject({stateDir,note}){
 if(typeof note!=='string'||!note.trim()||note.length>8000)fail('REVISION_REASON_REQUIRED');
 return withLock(stateDir,async()=>{
  const s=await state(stateDir);settled(s);budget(s);await controls(s);
  const prepared=await(await import('./prepared-project.mjs')).readPreparedTask({stateDir});
  if(!prepared||s.goal?.status!=='completed'||s.goal.task!==prepared.task)fail('REVISION_REQUIRES_COMPLETED_PREPARED_GOAL');
  const last=s.goal.results.at(-1);if(!last||s.lastTask.id!==last.taskId||s.lastTask.kind!=='work')fail('REVISION_TASK_MISMATCH');
  const {after}=await snapshots(stateDir,s);if(after.manifest.hash!==s.goal.finalManifestHash)fail('GOAL_WORKSPACE_CHANGED');
  const assignment=s.goal.assignments.find(a=>a.taskId===last.planTaskId);
  const route=selectRoute({routing:s.routing,kind:assignment.kind,preferredProfileId:assignment.profileId,allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});
  if(route.profileId!==assignment.profileId)fail('ASSIGNED_MODEL_RESOURCE_LIMIT');
  const id=randomUUID(),at=stamp();await save(join(stateDir,`revision-${id}.json`),{id,at,note,budgetId:s.budget.id,turnsUsed:s.budget.used,goal:s.goal,lastTask:s.lastTask},true);
  s.goal.revisions??=[];s.goal.revisions.push({id,at,note,previousFinalManifestHash:s.goal.finalManifestHash,previousTaskId:last.taskId});
  s.lastTask={...s.lastTask,status:'failed',checks:[{stage:'acceptance-review',status:'failed',code:'ACCEPTANCE_REVIEW_FAILED',stderr:note}]};
  s.goal.results.pop();s.goal.resume=failedWorkerCheckpoint(s);s.goal.status='failed';s.goal.code='ACCEPTANCE_REVIEW_FAILED';s.goal.failedBudgetId=s.budget.id;s.status='ready';s.code=null;
  await put(stateDir,s);return statusOf(stateDir,s);
 });
}
export async function abandonProjectGoal({stateDir,note,operationId=null}){
  if(typeof note!=='string'||!note.trim()||note.length>4096)fail('GOAL_ABANDON_REASON_REQUIRED');
  return withRemoteLock(stateDir,'abandon',operationId,async()=>{const s=await state(stateDir);settled(s);if(!s.routing||!s.goal||s.goal.status==='completed')fail('NO_INCOMPLETE_GOAL');
    const abandoned={...s.goal,status:'abandoned',abandonedAt:stamp(),note};await save(join(stateDir,`abandoned-goal-${s.goal.id}.json`),abandoned,true);
    s.goal=null;s.lastAbandonCommandId=operationId;s.conversationId=null;s.status='ready';s.code=null;await put(stateDir,s);return statusOf(stateDir,s);
  });
}
async function executeTask(stateDir,s,{task,signal,onEvent,kind='work',route=null,goalTaskId=null},deps={}){
    budget(s);const context=await controls(s);const initial=await snapshots(stateDir,s);
    const prepared=await(await import('./prepared-project.mjs')).readPreparedTask({stateDir});
    const inputs=prepared?buildPreparedInputContext(initial.after,s.sourceFiles):null;
    if(signal?.aborted)fail('PROJECT_CANCELLED_BEFORE_SEND');
    const taskId=`task-${String(++s.tasks).padStart(4,'0')}-${randomUUID().slice(0,8)}`,taskDir=join(stateDir,'tasks',taskId);await mkdir(taskDir,{mode:0o700});await writeDurable(join(taskDir,'task.txt'),task,true);
    s.lastTask={id:taskId,remoteCommandId:s.remoteCommandId??null,task,kind,route,goalTaskId,execution:{...executionOf(s)},status:'preparing',startedAt:stamp(),attempts:0};await put(stateDir,s);
    let prompt=`${s.conversationId?'Continue the same project workspace and prior conversation. The unchanged full Playbook is in AGENTS.md.':`Applicable rules (complete, fixed snapshot):\n${context.text}`}\n\nCURRENT TASK:\n${task}\n\nProject: ${profileOf(s).name}. ${kind==='plan'?'READ-ONLY PLANNING. No file edits or tools; return the requested plan JSON only.':`Editable scope: ${JSON.stringify(profileOf(s).writeRules)}. Other files are read-only inputs. The host will run unittest and frozen regressions after you finish, and provide concrete failures. Do not run tests yourself or claim they ran. ${executionOf(s).backend==='agy'?'Only scoped file tools; no shell.':'Native commands are confined to the configured workspace sandbox.'} Do not use web, MCP, subagents or outside paths. Make the requested scoped change and tests, then return a concise explanation. State explicitly if work is incomplete.`}`;
    if(inputs){
      const {text,...receipt}=inputs;
      await save(join(taskDir,'input-context.json'),receipt,true);
      s.lastTask.inputContext=kind==='work'?receipt:null;
      s.lastTask.preparedTaskHash=prepared.hash;
      prompt+='\n\n'+text+(kind==='work'?'\n\n'+completionInstruction(inputs):'');
    }
    for(let attempt=1;attempt<=3;attempt++){
      budget(s);if(signal?.aborted)fail('PROJECT_CANCELLED_BEFORE_SEND');
      if(route){const checked=selectRoute({routing:s.routing,kind:route.kind,preferredProfileId:route.profileId,allowedProfileIds:s.budget.allowedProfileIds,usedByProfile:s.budget.usedByProfile});if(checked.profileId!==route.profileId)fail('ASSIGNED_MODEL_RESOURCE_LIMIT');}
      if(!s.budget.startedAt){s.budget.startedAt=stamp();s.budget.deadlineAt=s.budget.maxMinutes===null?null:new Date(Date.now()+s.budget.maxMinutes*60000).toISOString();}
      const evidenceDir=join(taskDir,`attempt-${attempt}`);await mkdir(evidenceDir,{mode:0o700});
      const before=await readProjectSnapshot(s.workspaceDir);await materializeSnapshot(join(evidenceDir,'before'),before);
      s.budget.used++;if(route)s.budget.usedByProfile[route.profileId]=(s.budget.usedByProfile[route.profileId]??0)+1;
      s.lastTask.status='working';s.lastTask.attempts=attempt;s.pending={taskId,kind,route,goalTaskId,attempt,evidenceDir,conversationId:s.conversationId,beforeHash:before.manifest.hash,phase:'model',startedAt:stamp()};s.status='unknown';
      await save(join(evidenceDir,'intent.json'),{...s.pending,promptHash:hash(prompt),model:s.model,effort:executionOf(s).effort,backend:executionOf(s).backend,profileHash:digest(profileOf(s)),budgetId:s.budget.id},true);await put(stateDir,s);
      // Frozen gate implementations require a finite numeric cutoff. This sentinel
      // is beyond the maximum JS Date, preserving their hashes without imposing expiry.
      await save(join(stateDir,'gate.json'),{workspace:s.workspaceDir,profile:profileOf(s),deadlineAt:s.budget.deadlineAt===null?Number.MAX_SAFE_INTEGER:Date.parse(s.budget.deadlineAt),auditPath:join(evidenceDir,'tools.jsonl')});
      onEvent?.({event:'dispatch',attempt,used:s.budget.used,max:s.budget.maxTurns,kind,profileId:route?.profileId,model:s.model,effort:executionOf(s).effort});
      let terminal;
      try{
        terminal=await(deps.worker??(r=>selectedWorker(executionOf(s).backend,r)))({prompt,directory:s.workspaceDir,evidenceDir,model:s.model,effort:executionOf(s).effort,expectedVersion:executionOf(s).version,writeRoots:kind==='plan'?[]:profileOf(s).writeRules.map(r=>r.root),readOnlyPaths:before.manifest.files.filter(f=>kind==='plan'||!canEditProject(f.path,profileOf(s))).map(f=>f.path),agentName:s.schemaVersion===1?'calcifer-thor':'calcifer-worker',conversationId:s.conversationId,timeoutMs:s.budget.deadlineAt===null?null:Math.max(1000,Date.parse(s.budget.deadlineAt)-Date.now()),signal,fileTools:kind!=='plan',onEvent});
        await save(join(evidenceDir,'worker-result.json'),terminal,true);
        const result=await finalizeAttempt(stateDir,s,terminal,{signal,onEvent,checker:deps.checker});
        if(result.status==='completed'||result.code==='WORKER_INCOMPLETE')return result;
        if(attempt===3||signal?.aborted||result.checks.some(c=>c.process?.isolationError||c.process?.cancelled))return result;
        try{budget(s);}catch{return{...result,code:'RESOURCE_LIMIT'};}
        prompt=`Same task, correction ${attempt} of at most 2. Files remain as you left them. Diagnose these concrete host test failures, adjust the hypothesis, fix the implementation or add needed tests. Do not remove or weaken existing tests. Stop after the relevant changes.\n${JSON.stringify(result.checks.map(c=>({stage:c.stage,status:c.status,code:c.code,stdout:c.stdout?.slice(0,12000),stderr:c.stderr?.slice(0,12000)})))}`;
        if(inputs&&kind==='work')prompt+='\n'+completionInstruction(inputs);
      }catch(error){
        if(terminal&&s.pending?.phase==='checks'){
          s.pending=null;s.status='failed';s.code=code(error);s.lastTask.status='failed';s.lastTask.code=s.code;await put(stateDir,s);return{status:'failed',code:s.code,taskId,attempts:attempt,response:terminal.response,workspaceDir:s.workspaceDir};
        }
        if(error.dispatched===false){s.budget.used--;if(route)s.budget.usedByProfile[route.profileId]--;s.pending=null;s.status='failed';s.code=code(error);s.lastTask.status='failed';await put(stateDir,s);return{status:'failed',code:s.code,taskId,workspaceDir:s.workspaceDir};}
        s.status='unknown';s.code=code(error);s.lastTask.status='unknown';
        s.cancellation={userStoppedWaiting:signal?.aborted===true,localProcess: error.receipt?.process??null,streamDrained:error.receipt?.process?.closed===true,toolsStopped:'unknown',remoteInference:'unknown'};
        await put(stateDir,s);return{status:'unknown',code:s.code,taskId,attempts:attempt,workspaceDir:s.workspaceDir,cancellation:s.cancellation};
      }
    }
}
export async function reconcileProject({stateDir},deps={}){
  return withLock(stateDir,async()=>{const s=await state(stateDir);if(!s.pending)return statusOf(stateDir,s);
    await controls(s);const p=s.pending;let terminal,processReceipt,session;
    try{terminal=await json(join(p.evidenceDir,'terminal.json'));processReceipt=await json(join(p.evidenceDir,'process.json'));session=await json(join(p.evidenceDir,'session.json'));}catch(error){if(error.code==='ENOENT')return statusOf(stateDir,s);throw error;}
    if(processReceipt.closed!==true||processReceipt.exitCode!==0||processReceipt.signal||processReceipt.spawnError||processReceipt.overflow||processReceipt.parseError||processReceipt.cancelled||processReceipt.timedOut||processReceipt.storageError||processReceipt.turnFailed||terminal.status!=='SUCCESS'||session.conversationId!==terminal.conversation_id||(executionOf(s).backend==='agy'?session.init?.model!==s.model:session.backend!=='codex'||session.requestedModel!==s.model))return statusOf(stateDir,s);
    await finalizeAttempt(stateDir,s,{...terminal,actualModel:session.init?.model??null,requestedModel:session.requestedModel??s.model,modelEvidence:session.modelEvidence??'native model field',process:processReceipt},{checker:deps.checker});
    return statusOf(stateDir,s);
  });
}
export async function exportProject({stateDir,output,operationId=null},deps={}){
  return withRemoteLock(stateDir,'export',operationId,async()=>{const s=await state(stateDir);settled(s);if(s.routing&&s.goal?.status!=='completed')fail('GOAL_INCOMPLETE');const checked=await checkCurrent(stateDir,s,deps);if(checked.status!=='passed')fail('PROJECT_EXPORT_REQUIRES_PASS');const {before,after}=await snapshots(stateDir,s);
    if(s.routing&&after.manifest.hash!==s.goal.finalManifestHash)fail('GOAL_WORKSPACE_CHANGED');
    const patchPath=output??join(stateDir,'exports',operationId?`remote-${operationId}.patch`:`${Date.now()}-${randomUUID().slice(0,8)}.patch`);if(patchPath===s.repo||patchPath.startsWith(s.repo+'/')||patchPath===s.workspaceDir||patchPath.startsWith(s.workspaceDir+'/'))fail('EXPORT_DESTINATION_PROTECTED');
    const result=await exportProjectPatch({before,after,output:patchPath,profile:profileOf(s)});return{...result,checks:checked.checks,sourceMatches:await sourceMatches(s)};
  });
}
export async function recoverRemoteOperation({stateDir,operationId,action}){
  if(!UUID.test(operationId))fail('PROJECT_OPERATION_ID_INVALID');
  return withLock(stateDir,async()=>{
    const s=await state(stateDir);if(s.pending)return{status:'unknown'};
    let receipt;try{receipt=await json(join(stateDir,'remote-operations',operationId+'.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(receipt&&(receipt.operationId!==operationId||receipt.action!==action))fail('PROJECT_OPERATION_CONFLICT');
    if(receipt?.phase==='completed'&&receipt.result?.status!=='unknown')return receipt.result;
    if(receipt?.phase==='failed')return{status:'failed',code:receipt.error};
    if(action==='authorize'&&s.budget?.remoteCommandId===operationId||action==='abandon'&&s.lastAbandonCommandId===operationId)return{status:'completed'};
    if(action==='export'){
      const patchPath=join(stateDir,'exports',`remote-${operationId}.patch`);try{const record=await json(patchPath+'.receipt.json'),bytes=await readFile(patchPath);if(record.patchPath===patchPath&&record.patchHash===hash(bytes))return{status:'completed',patchPath,patchHash:record.patchHash};}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    // No dispatch receipt can mean the host stopped before entering the native API.
    // Local test/export interruption does not prove completion; retain any files.
    if(!receipt||['test','export','authorize','abandon'].includes(action))return{status:'failed',code:receipt?'LOCAL_OPERATION_INTERRUPTED':'OPERATION_NOT_STARTED'};
    return{status:'unknown'};
  });
}
export async function projectDiff({stateDir}){
  return withLock(stateDir,async()=>{const s=await state(stateDir);const {before,after}=await snapshots(stateDir,s),output=join(stateDir,'exports',`inspect-${randomUUID()}.patch`);
    await exportProjectPatch({before,after,output,profile:profileOf(s)});const diff=await readFile(output,'utf8');await unlink(output);await unlink(`${output}.receipt.json`);return diff;
  });
}
