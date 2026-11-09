export const MAX_PROJECT_CALLS=32;
import {fail} from './workspace-tools.mjs';

// Optional finite execution deadlines must fit Node's native timer range.
export const MAX_EXECUTION_TIMEOUT_MS=2147483647;
export const MAX_EXECUTION_MINUTES=Math.floor(MAX_EXECUTION_TIMEOUT_MS/60000);

// Verified CLI model IDs only. Model tiers and CLI reasoning effort are independent.
export const EXECUTION_MODELS=Object.freeze({
 agy:Object.freeze(['gemini-4-argon-low','gemini-4-argon-medium','gemini-4-argon-high']),
 codex:Object.freeze(['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna']),
});
export const EXECUTION_EFFORTS=Object.freeze(['low','medium','high','xhigh','max']);
export const EXECUTIONS=Object.freeze({
 agy:Object.freeze({backend:'agy',model:'gemini-4-argon-medium',version:'1.5.3',effort:'medium'}),
 codex:Object.freeze({backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'}),
});
// Version admission is explicit; existing profiles and defaults keep their hashes.
export const EXECUTION_VERSIONS=Object.freeze({
 agy:Object.freeze(['1.5.3']),
 codex:Object.freeze(['0.166.0-alpha.6','0.167.0-alpha.3.2']),
});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
export function executionProfile(backend='agy',options={}){
 if(typeof backend!=='string'||!Object.hasOwn(EXECUTIONS,backend))fail('PROJECT_BACKEND_UNSUPPORTED');
 if(!record(options)||Reflect.ownKeys(options).some(key=>!['model','effort'].includes(key)))fail('PROJECT_EXECUTION_INVALID');
 const {model=EXECUTIONS[backend].model,effort=EXECUTIONS[backend].effort}=options;
 return validateExecution({...EXECUTIONS[backend],model,effort});
}
export function validateExecution(p){
 const keys=['backend','model','version','effort'];
 if(!record(p)||Reflect.ownKeys(p).length!==keys.length||keys.some(key=>!Object.hasOwn(p,key))||
   typeof p.backend!=='string'||!Object.hasOwn(EXECUTIONS,p.backend)||!EXECUTION_VERSIONS[p.backend].includes(p.version)||
   !EXECUTION_MODELS[p.backend].includes(p.model)||!EXECUTION_EFFORTS.includes(p.effort))fail('PROJECT_EXECUTION_INVALID');
 // Return the original profile: existing schema-2 execution hashes remain unchanged.
 return p;
}
export async function selectedWorker(backend,request){
 if(backend==='agy')return(await import('./agy-worker.mjs')).runAgyWorker(request);
 if(backend==='codex')return(await import('./codex-worker.mjs')).runCodexWorker(request);
 fail('PROJECT_BACKEND_UNSUPPORTED');
}
