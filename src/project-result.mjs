import {readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {projectStatus} from './project-session.mjs';
import {readText,secureRoot,secureFile,relativePath,fail} from './workspace-tools.mjs';
import {statusView,errorCode} from './cli-protocol.mjs';

async function json(root,path){return JSON.parse((await readText(root,path,{limits:{maxFileBytes:2*1024*1024}})).content);}
async function fileHash(root,path,maxBytes){
 const file=await open(await secureFile(root,path),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();if(!info.isFile()||info.size>maxBytes)fail('ARTIFACT_SIZE_LIMIT');
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let size=0;
  for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>maxBytes)fail('ARTIFACT_SIZE_LIMIT');hash.update(buffer.subarray(0,bytesRead));}
  return hash.digest('hex');
 }finally{await file.close();}
}
async function artifacts(stateDir,s){
 const result={patches:[],documents:null,warnings:[]};
 const current=manifest=>Boolean(!s.pending&&s.status!=='failed'&&s.workspaceManifestHash&&s.workspaceManifestHash===manifest&&(!s.goal||s.goal.status==='completed'&&s.goal.finalManifestHash===manifest));
 const folder=join(stateDir,'exports');let files=[];
 try{await secureRoot(folder);files=await readdir(folder);}catch(e){if(e.code!=='ENOENT')result.warnings.push({kind:'patches',code:errorCode(e)});}
 const receipts=files.filter(f=>f.endsWith('.patch.receipt.json')&&!f.startsWith('inspect-')).sort().reverse();
 // Limit inspection work; this is not a recursive scan or a validation rerun.
 if(receipts.length>100)result.warnings.push({kind:'patches',code:'ARTIFACT_LIST_TRUNCATED'});
 for(const name of receipts.slice(0,100)){
  const patchPath=join(folder,name.slice(0,-13));
  try{
   const r=await json(folder,name);if(r.schemaVersion!==1||r.patchPath!==patchPath||typeof r.finalManifestHash!=='string')fail('ARTIFACT_RECEIPT_INVALID');
   if(await fileHash(folder,name.slice(0,-13),16*1024*1024)!==r.patchHash)fail('ARTIFACT_HASH_MISMATCH');
   result.patches.push({patchPath,patchHash:r.patchHash,changedFiles:r.changedFiles,verified:true,current:current(r.finalManifestHash)});
  }catch(e){result.patches.push({patchPath,verified:false,current:false,code:errorCode(e)});}
 }
 let hasDelivery=false;
 try{
  const latest=await json(stateDir,'latest-delivery.json');hasDelivery=true;
  if(typeof latest.directory!=='string')fail('ARTIFACT_POINTER_INVALID');
  const rel=relative(join(stateDir,'deliveries'),latest.directory);
  if(!relativePath(rel)||rel.includes('/'))fail('ARTIFACT_POINTER_INVALID');
  const root=join(stateDir,'deliveries',rel),r=await json(root,'delivery-receipt.json');
  if(r.schemaVersion!==1||r.directory!==root||r.projectId!==s.projectId||r.preparedTaskHash!==latest.preparedTaskHash||r.sourceHash!==latest.sourceHash)fail('ARTIFACT_RECEIPT_INVALID');
  const names=['proposal.md','proposal-draft.docx','proposal-draft.pdf','changes.patch','evidence.md','gaps.md'];
  for(const name of names){if(typeof r.files?.[name]!=='string'||await fileHash(root,name,20*1024*1024)!==r.files[name])fail('ARTIFACT_HASH_MISMATCH');}
  const prepared=await json(stateDir,'prepared-task.json');
  const documentCurrent=Boolean(!s.pending&&s.goal?.status==='completed'&&s.goal.id===r.goalId&&prepared.hash===r.preparedTaskHash&&r.checks?.manifestHash&&current(r.checks.manifestHash));
  result.documents={directory:root,docxPath:join(root,'proposal-draft.docx'),pdfPath:join(root,'proposal-draft.pdf'),pages:r.pages,status:r.status,verified:true,current:documentCurrent,automatedChecks:r.automatedChecks,visualReview:r.visualReview,semanticReview:r.semanticReview,submitted:r.submitted};
 }catch(e){if(e.code!=='ENOENT'||hasDelivery)result.warnings.push({kind:'documents',code:e.code==='ENOENT'?'ARTIFACT_MISSING':errorCode(e)});}
 return result;
}
export async function readProjectResult({stateDir}){
 const s=await projectStatus({stateDir});
 return {...statusView(s),artifacts:await artifacts(stateDir,s),humanAccepted:'unknown',integrationStatus:'unknown'};
}
