import { lstat, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, dirname, extname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { hash, digest, fail, pathList, relativePath, secureRoot, readText, writeDurable, materializeSnapshot } from './workspace-tools.mjs';
import { LEGACY_PROFILE, canEditProject } from './project-profile.mjs';
import { gitDiff } from './artifact-diff.mjs';

const LIMITS=Object.freeze({maxFiles:256,maxFileBytes:262144,maxTotalBytes:2097152});
const hidden=path=>path.split('/').some(p=>p.startsWith('.'));
function safePath(path){if(!relativePath(path)||hidden(path)||/[\r\n\t]/.test(path))fail('UNSAFE_PROJECT_PATH');}
function textContent(value){if(typeof value!=='string'||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail('BINARY_FILE_REJECTED');return value;}
function snapshot(contents){
  const files=Object.keys(contents).sort().map(path=>{safePath(path);const content=textContent(contents[path]);const bytes=Buffer.byteLength(content);if(bytes>LIMITS.maxFileBytes)fail('FILE_SIZE_LIMIT');return{path,hash:hash(content),bytes};});
  if(files.length>LIMITS.maxFiles)fail('FILE_COUNT_LIMIT');if(files.reduce((n,f)=>n+f.bytes,0)>LIMITS.maxTotalBytes)fail('TOTAL_SIZE_LIMIT');
  return{manifest:{files,hash:digest(files)},contents:{...contents}};
}
function validateSnapshot(value){
  if(!value||!value.contents||!value.manifest)fail('INVALID_PROJECT_SNAPSHOT');
  const computed=snapshot(value.contents);if(digest(computed.manifest)!==digest(value.manifest))fail('PROJECT_SNAPSHOT_HASH_MISMATCH');return computed;
}
async function exists(path){try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function fileContent(root,path){const value=await readText(root,path,{writable:true,limits:LIMITS,anyExtension:true});textContent(value.content);return value.content;}
export async function readSourceSnapshot(repo,sourceFiles){
  await secureRoot(repo);pathList(sourceFiles);if(sourceFiles.length>LIMITS.maxFiles)fail('FILE_COUNT_LIMIT');const contents=Object.create(null);
  for(const path of [...sourceFiles].sort()){safePath(path);contents[path]=await fileContent(repo,path);}return snapshot(contents);
}
export async function readProjectSnapshot(root){
  await secureRoot(root);const contents=Object.create(null);
  async function walk(prefix=''){
    await secureRoot(join(root,prefix));
    for(const entry of (await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=prefix?`${prefix}/${entry.name}`:entry.name;
      if(entry.isSymbolicLink())fail('SYMLINK_REJECTED');
      if(path==='AGENTS.md'||path==='.agents')continue;
      safePath(path);
      if(entry.isDirectory())await walk(path);
      else if(entry.isFile()){if(Object.keys(contents).length>=LIMITS.maxFiles)fail('FILE_COUNT_LIMIT');contents[path]=await fileContent(root,path);}
      else fail('UNAUTHORIZED_WORKSPACE_ENTRY');
    }
  }
  await walk();return snapshot(contents);
}
// Compatibility API for existing Thor state; new projects use an explicit profile.
export async function thorSourceFiles(repo){return(await import('./thor-profile.mjs')).thorSourceFiles(repo);}
export async function prepareProjectWorkspace({repo,stateDir,sourceFiles,seedContents={},profile=LEGACY_PROFILE}){
  await secureRoot(repo);await secureRoot(stateDir);
  if(stateDir===repo||stateDir.startsWith(repo+'/'))fail('STATE_ROOT_INSIDE_SOURCE');
  const initial=await readSourceSnapshot(repo,sourceFiles);
  if(!seedContents||typeof seedContents!=='object'||Array.isArray(seedContents))fail('INVALID_SEED_CONTENTS');
  for(const path of Object.keys(seedContents)){safePath(path);if(!canEditProject(path,profile))fail('IMMUTABLE_SEED_PATH');}
  const seeded=snapshot({...initial.contents,...seedContents});
  const initialDir=join(stateDir,'initial'),workspaceDir=join(stateDir,'workspace');
  if(await exists(initialDir)||await exists(workspaceDir))fail('PROJECT_SNAPSHOT_EXISTS');
  await materializeSnapshot(initialDir,initial);await materializeSnapshot(workspaceDir,seeded);
  return{repo,sourceFiles:[...sourceFiles].sort(),workspaceDir,initialManifest:initial.manifest,seedManifest:seeded.manifest};
}
export function verifyProjectChanges(before,after,profile=LEGACY_PROFILE){
  before=validateSnapshot(before);after=validateSnapshot(after);const result=[];
  for(const path of Object.keys(before.contents))if(!Object.hasOwn(after.contents,path))fail('PROJECT_DELETION_REJECTED');
  for(const file of after.manifest.files){
    const previous=before.manifest.files.find(f=>f.path===file.path);if(previous?.hash===file.hash)continue;
    if(!canEditProject(file.path,profile))fail('IMMUTABLE_PROJECT_FILE');
    result.push({path:file.path,beforeHash:previous?.hash??null,afterHash:file.hash,content:after.contents[file.path]});
  }
  return result;
}
export async function exportProjectPatch({before,after,output,profile=LEGACY_PROFILE}){
  const changes=verifyProjectChanges(before,after,profile);
  if(typeof output!=='string'||resolve(output)!==output)fail('CANONICAL_OUTPUT_REQUIRED');await secureRoot(dirname(output));
  const receiptPath=`${output}.receipt.json`;if(await exists(output)||await exists(receiptPath))fail('PROJECT_EXPORT_EXISTS');
  await secureRoot('/tmp');const scratch=await mkdtemp('/tmp/calcifer-project-export-'),settlement={closed:true};
  try{
    for(const dir of ['a','b','home'])await mkdir(join(scratch,dir),{mode:0o700});
    for(const change of changes)for(const [side,content] of [['a',before.contents[change.path]],['b',after.contents[change.path]]]){
      if(content===undefined)continue;const path=join(scratch,side,change.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeDurable(path,content,true);
    }
    settlement.closed=false;const result=await gitDiff(scratch,spawn,settlement);
    if(changes.length===0?(result.exitCode!==0||result.patch.length!==0):(result.exitCode!==1||result.patch.length===0))fail('EXPORT_GIT_RESULT_MISMATCH');
    const receipt={schemaVersion:1,patchPath:output,patchHash:hash(result.patch),patchBytes:result.patch.length,changedFiles:changes.length,initialManifestHash:before.manifest.hash,finalManifestHash:after.manifest.hash};
    await writeDurable(output,result.patch,true);await writeDurable(receiptPath,JSON.stringify(receipt,null,2)+'\n',true);
    return{patchPath:output,patchHash:receipt.patchHash,patchBytes:receipt.patchBytes,changedFiles:changes.length};
  }finally{if(settlement.closed)await rm(scratch,{recursive:true,force:true});}
}
