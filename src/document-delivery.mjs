import {spawn} from 'node:child_process';
import {mkdir,readFile,stat,copyFile} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fail,hash,relativePath,secureRoot,readText,writeDurable} from './workspace-tools.mjs';
import {projectStatus,exportProject} from './project-session.mjs';
import {readProjectSnapshot} from './project-workspace.mjs';
import {readPreparedTask} from './prepared-project.mjs';

const builder=fileURLToPath(new URL('../scripts/document_delivery.py',import.meta.url));
export function validateDocumentOptions(d){
 if(!d||!relativePath(d.source)||!d.source.endsWith('.md')||!isAbsolute(d.python??'')||!isAbsolute(d.renderer??'')||d.maxPages!==10||d.maxBytes!==20971520)fail('DOCUMENT_OPTIONS_INVALID');
 return d;
}
export function inspectPdfInfo(info,maxPages){
 const pages=Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
 const size=info.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
 if(!Number.isSafeInteger(pages)||pages<1||!size)fail('DOCUMENT_PDF_INVALID');
 if(pages>maxPages)fail('DOCUMENT_PAGE_LIMIT');
 if(Math.abs(Number(size[1])-595.276)>1||Math.abs(Number(size[2])-841.89)>1)fail('DOCUMENT_NOT_A4');
 return pages;
}
// Bounded local converters. Cancellation kills the owned process group; never a model retry.
function command(executable,args,{cwd,env,signal,timeoutMs=180000}={}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(new DOMException('Cancelled','AbortError'));
  const child=spawn(executable,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});
  let stdout='',stderr='',timer,killTimer,reason;
  const stop=why=>{if(reason)return;reason=why;try{process.kill(-child.pid,'SIGTERM');}catch{}killTimer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);};
  const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>stop('timeout'),timeoutMs);
  const add=(type,chunk)=>{if(type==='stdout')stdout+=chunk;else stderr+=chunk;if(stdout.length+stderr.length>262144)stop('output limit');};
  child.stdout.on('data',c=>add('stdout',c));child.stderr.on('data',c=>add('stderr',c));
  const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
  child.once('error',e=>{cleanup();reject(e);});
  child.once('close',(code,sig)=>{if(reason){try{process.kill(-child.pid,'SIGKILL');}catch{}}cleanup();resolve({code,signal:sig,reason,stdout,stderr});});
 });
}
export async function renderDocumentBundle({workspaceDir,directory,documents,signal}){
 const d=validateDocumentOptions(documents);await secureRoot(workspaceDir);await secureRoot(directory);
 const source=(await readText(workspaceDir,d.source,{limits:{maxFileBytes:131072}})).content;
 const input=join(directory,'proposal.md'),docxPath=join(directory,'proposal-draft.docx'),renders=join(directory,'render');
 await writeDurable(input,source,true);
 // The selected bundled Python determines the matching bundled converters.
 const runtime=dirname(dirname(d.python)),dependencies=dirname(runtime);
 const env={...process.env,PATH:join(dependencies,'bin/override')+':'+(process.env.PATH??''),PYTHONDONTWRITEBYTECODE:'1'};
 const logs=[];
 async function run(executable,args){const r=await command(executable,args,{cwd:directory,env,signal});logs.push({executable,args,...r});await writeDurable(join(directory,'conversion.json'),JSON.stringify(logs,null,2)+'\n');if(r.code!==0||r.reason){if(r.reason==='cancelled')throw new DOMException('Cancelled','AbortError');fail('DOCUMENT_RENDER_FAILED');}return r.stdout;}
 await run(d.python,[builder,input,docxPath]);
 await run(d.python,[d.renderer,docxPath,'--output_dir',renders,'--emit_pdf']);
 const pdfPath=join(directory,'proposal-draft.pdf');await copyFile(join(renders,'proposal-draft.pdf'),pdfPath);
 const pages=inspectPdfInfo(await run(join(dependencies,'bin/override/pdfinfo'),[pdfPath]),d.maxPages);
 if((await stat(pdfPath)).size>d.maxBytes)fail('DOCUMENT_SIZE_LIMIT');
 await run(d.python,['-c',"from pypdf import PdfReader; from pathlib import Path; import sys; Path(sys.argv[2]).write_text(chr(10).join(p.extract_text() or '' for p in PdfReader(sys.argv[1]).pages), encoding='utf-8')",pdfPath,join(directory,'proposal-extracted.txt')]);
 const receipt={schemaVersion:1,status:'draft',pages,directory,docxPath,pdfPath,sourceHash:hash(source),files:{},automatedChecks:{a4:true,pageLimit:true,sizeLimit:true},visualReview:'pending',semanticReview:'pending',submitted:false};
 for(const name of ['proposal.md','proposal-draft.docx','proposal-draft.pdf'])receipt.files[name]=hash(await readFile(join(directory,name)));
 await writeDurable(join(directory,'document-receipt.json'),JSON.stringify(receipt,null,2)+'\n',true);
 return receipt;
}
export async function deliverProjectDocuments({stateDir,signal}){
 const prepared=await readPreparedTask({stateDir});if(!prepared)fail('PREPARED_TASK_REQUIRED');
 const status=await projectStatus({stateDir});if(status.pending)fail('PROJECT_PENDING');
 if(status.goal?.status!=='completed'||status.goal.task!==prepared.task)fail('GOAL_INCOMPLETE');
 if(!status.goal.results?.length||status.goal.results.some(r=>r.completion?.status!=='complete'||!r.completion.inputContextHash))fail('DOCUMENT_SOURCE_ACK_REQUIRED');
 // Export verifies original controls, frozen checks and accepted workspace manifest.
 const patch=await exportProject({stateDir});
 const snapshot=await readProjectSnapshot(status.workspaceDir);
 const patchReceipt=JSON.parse(await readFile(patch.patchPath+'.receipt.json','utf8'));
 if(snapshot.manifest.hash!==status.goal.finalManifestHash||snapshot.manifest.hash!==patchReceipt.finalManifestHash)fail('DELIVERY_WORKSPACE_CHANGED');
 const parent=join(stateDir,'deliveries');await mkdir(parent,{recursive:true,mode:0o700});await secureRoot(parent);
 const directory=join(parent,`${Date.now()}-${randomUUID().slice(0,8)}`);await mkdir(directory,{mode:0o700});
 const inputs=join(directory,'inputs');await mkdir(inputs,{mode:0o700});
 for(const source of [prepared.documents.source,...['evidence.md','gaps.md'].map(name=>join(dirname(prepared.documents.source),name))]){
  if(typeof snapshot.contents[source]!=='string')fail('DOCUMENT_INPUT_MISSING');
  const target=join(inputs,source);await mkdir(dirname(target),{recursive:true,mode:0o700});await writeDurable(target,snapshot.contents[source],true);
 }
 const result=await renderDocumentBundle({workspaceDir:inputs,directory,documents:prepared.documents,signal});
 await copyFile(patch.patchPath,join(directory,'changes.patch'));
 for(const name of ['evidence.md','gaps.md']){
  const text=snapshot.contents[join(dirname(prepared.documents.source),name)];
  await writeDurable(join(directory,name),text,true);
 }
 for(const name of ['changes.patch','evidence.md','gaps.md'])result.files[name]=hash(await readFile(join(directory,name)));
 const receipt={...result,patch,projectId:status.projectId,goalId:status.goal.id,preparedTaskHash:prepared.hash,turnsUsed:status.turnsUsed,maxTurns:status.maxTurns,checks:status.lastChecks,completedAt:new Date().toISOString()};
 await writeDurable(join(directory,'delivery-receipt.json'),JSON.stringify(receipt,null,2)+'\n',true);
 await writeDurable(join(stateDir,'latest-delivery.json'),JSON.stringify({directory,preparedTaskHash:prepared.hash,sourceHash:result.sourceHash,status:'draft'},null,2)+'\n');
 return receipt;
}
