import {basename,extname} from 'node:path';
import {digest,fail,relativePath} from './workspace-tools.mjs';

const safe = p => typeof p==='string' && relativePath(p) && basename(p)!=='AGENTS.md' && !p.split('/').some(x=>x.startsWith('.')||['node_modules','__pycache__','venv'].includes(x)) && !/[\x00-\x20]/.test(p);
export const LEGACY_PROFILE=Object.freeze({schemaVersion:1,name:'Thor (legacy acceptance project)',sourceFiles:[],writeRules:[{root:'erasebot',extensions:['.py']},{root:'tools',extensions:['.py']},{root:'tests',extensions:['.py']},{root:'docs/development',extensions:['.md']}],check:{kind:'python-unittest',testDir:'tests',timeoutMs:60000}});
export function validateProfile(value){
  if(!value||value.schemaVersion!==1||typeof value.name!=='string'||!value.name.trim()||value.name.length>100||/[\x00-\x1f]/.test(value.name))fail('PROJECT_PROFILE_INVALID');
  const files=value.sourceFiles;
  if(!Array.isArray(files)||files.length<1||files.length>256||new Set(files).size!==files.length||files.some(p=>!safe(p)||/(?:^|\/)(?:credentials?|secrets?|tokens?|passwords?|accounts?|auth)(?:[._-]|$)/i.test(p)))fail('PROJECT_SOURCE_SCOPE_INVALID');
  const rules=value.writeRules;
  if(!Array.isArray(rules)||rules.length<1||rules.length>16||new Set(rules.map(r=>r?.root)).size!==rules.length||rules.some(r=>!r||!safe(r.root)||!/^[A-Za-z0-9_/-]+$/.test(r.root)||!Array.isArray(r.extensions)||r.extensions.length<1||r.extensions.some(e=>!['.py','.md'].includes(e))))fail('PROJECT_WRITE_SCOPE_INVALID');
  const check=value.check;
  if(!check||check.kind!=='python-unittest'||!safe(check.testDir)||!Number.isSafeInteger(check.timeoutMs)||check.timeoutMs<1000||check.timeoutMs>60000)fail('PROJECT_CHECK_UNSUPPORTED');
  const p={schemaVersion:1,name:value.name,sourceFiles:[...files].sort(),writeRules:rules.map(r=>({root:r.root,extensions:[...new Set(r.extensions)].sort()})),check:{kind:check.kind,testDir:check.testDir,timeoutMs:check.timeoutMs}};
  if(!p.sourceFiles.some(f=>f.startsWith(check.testDir+'/')&&f.endsWith('.py')))fail('PROJECT_TEST_SOURCE_REQUIRED');
  return p;
}
export function canEditProject(path,profile=LEGACY_PROFILE){
  return safe(path)&&profile.writeRules.some(r=>path.startsWith(r.root+'/')&&r.extensions.includes(extname(path)));
}
export function projectCheck(profile=LEGACY_PROFILE){
  const c={argv:['-B','-m','unittest','discover','-s',profile.check.testDir],timeoutMs:profile.check.timeoutMs};
  return {...c,definitionHash:digest(c)};
}
