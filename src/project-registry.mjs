import {mkdir,readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,isAbsolute} from 'node:path';
import {fail,secureRoot,readText,writeDurable} from './workspace-tools.mjs';

const NAME=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID=/^[a-f0-9-]{36}$/;
const rootOf=home=>join(home,'.local','state','calcifer');
const nameOf=name=>{if(!NAME.test(name??''))fail('REGISTRY_NAME_INVALID');return name;};
async function readJson(root,file,maxFileBytes=16384){
  return JSON.parse((await readText(root,file,{limits:{maxFileBytes}})).content);
}
async function identity(stateDir){
  const s=await readJson(stateDir,'project.json',2*1024*1024);
  if(![1,2].includes(s.schemaVersion)||!UUID.test(s.projectId)||s.workspaceDir!==join(stateDir,'workspace'))fail('PROJECT_STATE_INVALID');
  return s.projectId;
}
async function children(dir){
  try{await secureRoot(dir);return await readdir(dir,{withFileTypes:true});}
  catch(e){if(e.code==='ENOENT')return [];throw e;}
}
async function registered(home,project){
  let entry;
  try{entry=await readJson(join(rootOf(home),'.registry'),nameOf(project)+'.json');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  if(entry?.schemaVersion!==1||entry.project!==project||typeof entry.stateDir!=='string'||!isAbsolute(entry.stateDir)||resolve(entry.stateDir)!==entry.stateDir||!UUID.test(entry.projectId))fail('REGISTRY_ENTRY_INVALID');
  // An existing name must never silently move to a replacement session.
  if(await identity(entry.stateDir)!==entry.projectId)fail('REGISTRY_IDENTITY_CHANGED');
  return entry;
}
async function defaultIdentity(home,project){
  try{return await identity(join(rootOf(home),project));}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export async function lookupProject({home=homedir(),project}){
  const entry=await registered(home,project);
  if(entry&&entry.stateDir!==join(rootOf(home),project)&&await defaultIdentity(home,project)!==null)fail('REGISTRY_NAME_CONFLICT');
  return entry;
}
export async function registerProject({home=homedir(),project,stateDir}){
  nameOf(project);
  const projectId=await identity(stateDir);
  const existing=await lookupProject({home,project});
  if(existing){if(existing.stateDir!==stateDir||existing.projectId!==projectId)fail('REGISTRY_NAME_CONFLICT');return existing;}
  if(stateDir!==join(rootOf(home),project)&&await defaultIdentity(home,project)!==null)fail('REGISTRY_NAME_CONFLICT');
  await secureRoot(home);
  let dir=home;
  for(const part of ['.local','state','calcifer','.registry']){
    dir=join(dir,part);try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    await secureRoot(dir);
  }
  const entry={schemaVersion:1,project,stateDir,projectId};
  try{await writeDurable(join(dir,project+'.json'),JSON.stringify(entry,null,2)+'\n',true);}
  catch(e){
    if(e.code!=='EEXIST')throw e;
    const concurrent=await lookupProject({home,project});
    if(concurrent?.stateDir!==stateDir||concurrent.projectId!==projectId)fail('REGISTRY_NAME_CONFLICT');
  }
  return entry;
}
export async function discoverProjects({home=homedir()}={}){
  const root=rootOf(home),entries=new Map();
  for(const item of await children(root)){
    if(!NAME.test(item.name)||!item.isDirectory()&&!item.isSymbolicLink())continue;
    const stateDir=join(root,item.name);
    try{entries.set(item.name,{project:item.name,stateDir,projectId:await identity(stateDir)});}
    catch(e){if(e.code!=='ENOENT')entries.set(item.name,{project:item.name,stateDir,error:e.message});}
  }
  for(const item of await children(join(root,'.registry'))){
    if(!item.name.endsWith('.json')||!NAME.test(item.name.slice(0,-5)))continue;
    const project=item.name.slice(0,-5);
    try{entries.set(project,await lookupProject({home,project}));}
    catch(e){entries.set(project,{project,error:e.code==='ENOENT'?'REGISTRY_STATE_MISSING':e.message});}
  }
  const seen=new Set();
  return [...entries.values()].filter(Boolean).sort((a,b)=>a.project.localeCompare(b.project)).filter(entry=>{
    if(entry.error)return true;
    if(seen.has(entry.stateDir))return false;
    seen.add(entry.stateDir);return true;
  });
}
