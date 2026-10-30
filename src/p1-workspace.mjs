import { mkdir, lstat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedP1CheckSummary } from './p1-check.mjs';
import { boundedLimits, digest, fail, hash, pathList, relativePath, readText, secureRoot, snapshotWorkspace, writeDurable, snapshotContents } from './workspace-tools.mjs';

const exact = (value, keys, required=keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)) || required.some(k=>!Object.hasOwn(value,k))) fail('INVALID_HOST_CONFIG');
};
export async function bindP1({repo, config, stateRoot, goal, harness, profile}) {
  if (typeof goal!=='string'||!goal.trim()||Buffer.byteLength(goal)>8192) fail('INVALID_GOAL');
  if (!['opencode','pi'].includes(harness)||profile!=='mock-loopback') fail('MOCK_PROFILE_REQUIRED');
  await secureRoot(repo);
  if (typeof stateRoot!=='string'||resolve(stateRoot)!==stateRoot||stateRoot===repo||stateRoot.startsWith(repo+'/')||repo.startsWith(stateRoot+'/')) fail('INVALID_STATE_ROOT');
  exact(config,['schemaVersion','stateRoot','sourceFiles','readPaths','writePaths','createPaths','commands','acceptance','limits'],['schemaVersion','stateRoot','sourceFiles','readPaths','writePaths','createPaths','commands','acceptance']);
  if(config.schemaVersion!==1)fail('INVALID_HOST_CONFIG');
  if(config.stateRoot!==stateRoot)fail('CONFIG_STATE_ROOT_MISMATCH');
  for(const key of ['sourceFiles','readPaths','writePaths','createPaths'])pathList(config[key]);
  if(!config.sourceFiles.length||!config.readPaths.length||config.readPaths.some(p=>!config.sourceFiles.includes(p))||config.writePaths.some(p=>!config.readPaths.includes(p))||config.createPaths.some(p=>config.sourceFiles.includes(p)))fail('INVALID_HOST_SCOPE');
  for(const p of [...config.sourceFiles,...config.createPaths])if(p.split('/').some(s=>s.startsWith('.')||s==='node_modules'))fail('PROTECTED_METADATA_PATH');
  const limits=boundedLimits(config.limits);
  if(config.sourceFiles.length+config.createPaths.length>limits.maxFiles)fail('FILE_COUNT_LIMIT');
  if(config.sourceFiles.includes('AGENTS.md')&&!config.readPaths.includes('AGENTS.md'))fail('REPO_RULES_MUST_BE_READABLE');
  exact(config.commands,Object.keys(config.commands));
  if(!Object.keys(config.commands).length||Object.keys(config.commands).length>8)fail('INVALID_COMMANDS');
  const commands={};
  for(const [id,c]of Object.entries(config.commands)){
    if(!/^[a-zA-Z0-9_-]{1,40}$/.test(id))fail('INVALID_COMMAND_ID');exact(c,['argv','timeoutMs']);
    if(!Array.isArray(c.argv)||c.argv.length!==2||c.argv[0]!=='--test'||!config.readPaths.includes(c.argv[1])||!c.argv[1].endsWith('.mjs')||!Number.isInteger(c.timeoutMs)||c.timeoutMs<50||c.timeoutMs>3000)fail('INVALID_COMMAND');
    commands[id]={...c,definitionHash:digest(c)};
  }
  exact(config.acceptance,['scriptPath','timeoutMs']);const a=config.acceptance;
  if(typeof a.scriptPath!=='string'||resolve(a.scriptPath)!==a.scriptPath||a.scriptPath.startsWith(repo+'/')||a.scriptPath.startsWith(stateRoot+'/')||!Number.isInteger(a.timeoutMs)||a.timeoutMs<50||a.timeoutMs>3000)fail('INVALID_ACCEPTANCE');
  const script=await readText(dirname(a.scriptPath),a.scriptPath.split('/').at(-1),{limits});
  const initial=await snapshotWorkspace(repo,config.sourceFiles,{writablePaths:config.sourceFiles,limits,complete:true});
  for(const p of config.createPaths){try{await lstat(join(repo,p));fail('CREATE_PATH_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
  const context={goal,repoRules:initial.contents['AGENTS.md']??null,files:config.readPaths.map(path=>({path,...initial.manifest.files.find(f=>f.path===path)})),scope:{readPaths:config.readPaths,writePaths:config.writePaths,createPaths:config.createPaths,checkIds:Object.keys(commands)},acceptance:'Host runs protected final acceptance over delivered snapshot; do not edit host evidence.'};
  return{initial,limits,commands,context,acceptance:{...a,scriptHash:script.hash,definitionHash:digest({...a,scriptHash:script.hash})},acceptanceContent:script.content,authorityHash:digest({repo,stateRoot,config,harness,profile})};
}
export async function p1Snapshot(root, config, limits) {
  const files=[...config.sourceFiles];
  for(const path of config.createPaths){try{await lstat(join(root,path));files.push(path);}catch(e){if(e.code!=='ENOENT')throw e;}}
  return snapshotWorkspace(root,files.sort(),{writablePaths:files,limits,complete:true});
}
export function p1Artifacts(before, after, config) {
  const artifacts=[];
  for(const file of before.manifest.files)if(!after.manifest.files.some(f=>f.path===file.path))fail('ARTIFACT_MEMBERSHIP_MISMATCH');
  for(const file of after.manifest.files){
    const old=before.manifest.files.find(f=>f.path===file.path);
    if(!old&&!config.createPaths.includes(file.path))fail('UNAUTHORIZED_WORKSPACE_ENTRY');
    if(old?.hash===file.hash)continue;
    if(old&&!config.writePaths.includes(file.path))fail('PROTECTED_FILE_CHANGED');
    artifacts.push({path:file.path,beforeHash:old?.hash??null,afterHash:file.hash,content:after.contents[file.path]});
  }
  return artifacts;
}
export function createP1Tools({root,config,limits,journal,check,signal,admitted=()=>true}) {
  let accepting=true,unknown=false,queue=Promise.resolve(),calls=0;
  const stopped=()=>{if(unknown)fail('TOOL_OUTCOME_UNKNOWN');if(!accepting||signal?.aborted||!admitted())fail('TOOLS_CLOSED');};
  const dispatch=request=>{
    if(!accepting||unknown||signal?.aborted)return Promise.reject(Object.assign(new Error(unknown?'TOOL_OUTCOME_UNKNOWN':'TOOLS_CLOSED'),{known:true}));
    const operation=queue.then(async()=>{
      stopped();exact(request,['action','args']);const {action,args}=request;
      const schemas={read:['path'],search:['query'],edit:['path','expectedHash','content'],create:['path','content'],check:['checkId']};
      if(!Object.hasOwn(schemas,action))fail('UNKNOWN_TOOL_ACTION');exact(args,schemas[action]);
      if(++calls>limits.maxToolCalls)fail('TOOL_CALL_LIMIT');
      if(['read','edit','create'].includes(action)){
        const paths=action==='read'?[...config.readPaths,...config.createPaths]:action==='edit'?[...config.writePaths,...config.createPaths]:config.createPaths;
        if(!relativePath(args.path)||!paths.includes(args.path))fail('TOOL_PATH_NOT_ALLOWED');
      }
      if(action==='search'&&(typeof args.query!=='string'||!args.query.length||args.query.length>256))fail('INVALID_SEARCH_QUERY');
      if(['edit','create'].includes(action)&&(typeof args.content!=='string'||args.content.includes('\0')||Buffer.byteLength(args.content)>limits.maxFileBytes))fail('INVALID_EDIT_ARGUMENTS');
      if(action==='edit'&&!/^[a-f0-9]{64}$/.test(args.expectedHash))fail('INVALID_EDIT_ARGUMENTS');
      if(action==='check'&&!Object.hasOwn(config.commands,args.checkId))fail('CHECK_NOT_ALLOWED');
      const id=randomUUID();let intent=false,sideEffect=false,confirmedCheck=false,acknowledging=false;
      try{
        await journal({type:'intent',data:{id,kind:'tool:'+action,path:args.path,checkId:args.checkId}});intent=true;stopped();
        let result;
        if(action==='read'){try{result=await readText(root,args.path,{limits,writable:true});}catch(error){if(error.code==='ENOENT')fail('FILE_NOT_FOUND');throw error;}}
        if(action==='search'){
          const current=await p1Snapshot(root,config,limits),matches=[];let truncated=false;
          for(const path of [...config.readPaths,...config.createPaths].filter(p=>p in current.contents))for(const [index,line]of current.contents[path].split('\n').entries())if(line.includes(args.query)){
            const hit={path,line:index+1,text:line.slice(0,256)};if(Buffer.byteLength(JSON.stringify([...matches,hit]))<limits.maxOutputBytes-128)matches.push(hit);else truncated=true;
          }result={matches,truncated};
        }
        if(action==='edit'){
          const before=await readText(root,args.path,{limits,writable:true});if(before.hash!==args.expectedHash)fail('STALE_EXPECTED_HASH');stopped();
          const contents=(await p1Snapshot(root,config,limits)).contents;contents[args.path]=args.content;snapshotContents(contents,limits);
          stopped();sideEffect=true;await writeDurable(join(root,args.path),args.content);result={path:args.path,beforeHash:before.hash,hash:hash(args.content)};
        }
        if(action==='create'){
          const contents=(await p1Snapshot(root,config,limits)).contents;if(Object.hasOwn(contents,args.path))fail('CREATE_PATH_ALREADY_EXISTS');contents[args.path]=args.content;snapshotContents(contents,limits);
          let cursor=root;for(const part of args.path.split('/').slice(0,-1)){cursor=join(cursor,part);try{await secureRoot(cursor);}catch(e){if(e.code!=='ENOENT')throw e;stopped();await mkdir(cursor,{mode:0o700});await secureRoot(cursor);}}
          stopped();sideEffect=true;await writeDurable(join(root,args.path),args.content,true);result={path:args.path,beforeHash:null,hash:hash(args.content)};
        }
        if(action==='check'){stopped();sideEffect=true;const receipt=await check(args.checkId);confirmedCheck=receipt?.process?.closed===true;result=receipt?.kind==='node-project-command'?boundedP1CheckSummary(receipt,limits.maxOutputBytes):receipt;}
        if(Buffer.byteLength(JSON.stringify(result))>limits.maxOutputBytes)throw new Error('TOOL_OUTPUT_ACK_UNKNOWN');
        acknowledging=true;await journal({type:'completed',data:{id,resultHash:digest(result)}});acknowledging=false;return result;
      }catch(error){
        if(intent&&error.known&&!acknowledging&&(!sideEffect||confirmedCheck)){try{await journal({type:'completed',data:{id,failed:true,code:error.message}});}catch(journalError){unknown=true;accepting=false;throw journalError;}}
        else if(intent){unknown=true;accepting=false;}
        throw error;
      }
    });queue=operation.catch(()=>{});return operation;
  };
  return{dispatch,seal(){accepting=false;},async drain(){await queue;if(unknown)fail('TOOL_OUTCOME_UNKNOWN');},get calls(){return calls;}};
}
