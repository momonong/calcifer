import {lstat,realpath,appendFile,readFile} from 'node:fs/promises';
import {resolve,relative,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';

const FIELDS={view_file:'AbsolutePath',list_dir:'DirectoryPath',find_by_name:'SearchDirectory',grep_search:'SearchPath',write_to_file:'TargetFile',replace_file_content:'TargetFile',multi_replace_file_content:'TargetFile'};
const WRITES=new Set(['write_to_file','replace_file_content','multi_replace_file_content']);
export const canEdit=p=>/^(?:erasebot|tools|tests)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.py$/.test(p)||/^docs\/development\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(p);
export async function gateTool(input,{workspace,deadlineAt}){
  const deny=reason=>({decision:'deny',reason});
  if(!Number.isFinite(deadlineAt)||Date.now()>=deadlineAt)return deny('Calcifer resource window ended; no more tools.');
  if(!Array.isArray(input.workspacePaths)||input.workspacePaths.length!==1||input.workspacePaths[0]!==workspace)return deny('Calcifer workspace identity mismatch.');
  const call=input.toolCall,name=call?.name,field=FIELDS[name];
  if(!field)return deny('Calcifer permits scoped file tools only; host executes tests.');
  const value=call.args?.[field];if(typeof value!=='string'||!value||/[\x00-\x1f]/.test(value))return deny('Missing or invalid file path.');
  const target=resolve(workspace,value),rel=relative(workspace,target);
  if(rel==='..'||rel.startsWith('../')||rel.split('/').some(p=>p.startsWith('.')||p==='node_modules'||p==='__pycache__'))return deny('Path is outside the allowed workspace.');
  if(WRITES.has(name)&&(!canEdit(rel)||call.args?.IsArtifact===true))return deny('Protected input or control file; only Python source/tests and development Markdown are editable.');
  if(await realpath(workspace)!==workspace)return deny('Workspace must not be a symbolic link.');
  let cursor=workspace;
  for(const part of rel.split('/').filter(Boolean)){
    cursor=join(cursor,part);
    try{const stat=await lstat(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink!==1||!stat.isFile()&&!stat.isDirectory())return deny('Unsafe filesystem entry.');}
    catch(error){if(error.code!=='ENOENT'||!WRITES.has(name))return deny('Path is not readable.');break;}
  }
  return {decision:'allow',reason:'Calcifer scoped file operation.'};
}
export async function runGate(configPath,stdin=process.stdin,stdout=process.stdout){
  let input='',config,decision;
  try{
    for await(const chunk of stdin){input+=chunk;if(Buffer.byteLength(input)>1048576)throw new Error('INPUT_LIMIT');}
    config=JSON.parse(await readFile(configPath,'utf8'));const payload=JSON.parse(input);
    decision=await gateTool(payload,config);
    await appendFile(config.auditPath,JSON.stringify({at:new Date().toISOString(),conversationId:payload.conversationId,stepIdx:payload.stepIdx,name:payload.toolCall?.name,decision:decision.decision})+'\n',{mode:0o600});
  }catch{decision={decision:'deny',reason:'Calcifer gate could not verify this operation.'};}
  stdout.write(JSON.stringify(decision)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runGate(process.argv[2]);
