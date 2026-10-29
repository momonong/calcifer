import { spawn } from 'node:child_process';
import { createReadStream, constants } from 'node:fs';
import { readFile, realpath, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { digest, hash, fail, secureFile, readText } from './workspace-tools.mjs';

const implementationHash = hash(await readFile(new URL(import.meta.url)));
export const nodeJsonCliProtocol = () => ({ kind: 'node-json-cli', version: 1, implementationHash,
  domain: 'plain-json-safe-integers-depth8-nodes1024-bytes8192-no-negative-zero', duplicateKeys: 'JSON.parse-last-value', comparison: 'deep-strict-equal', workerCodeExecution: true });
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
export function jsonCliValue(value) {
  let nodes = 0;
  const walk = (item, depth) => {
    if (++nodes > 1024 || depth > 8) fail('CHECK_JSON_DOMAIN');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number' && Number.isSafeInteger(item) && !Object.is(item, -0)) return;
    if (!item || typeof item !== 'object' || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) fail('CHECK_JSON_DOMAIN');
    if (Object.getOwnPropertySymbols(item).length || Array.isArray(item) && (Object.keys(item).length !== item.length || Object.keys(item).some((key,index) => key !== String(index)))) fail('CHECK_JSON_DOMAIN');
    for (const child of Object.values(item)) walk(child, depth + 1);
  };
  walk(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 8192) fail('CHECK_JSON_DOMAIN');
  return text;
}
export function normalizeJsonCliDefinition(value, scope) {
  if (!keys(value,['kind','entryPath','cases','caseTimeoutMs','timeoutMs','maxOutputBytes']) || value.kind !== 'node-json-cli'
    || typeof value.entryPath !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/.test(value.entryPath)
    || !scope.sourceFiles.includes(value.entryPath) || !scope.readPaths.includes(value.entryPath)) fail('INVALID_CHECK_DEFINITION');
  if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 4) fail('INVALID_CHECK_CASES');
  const seen = new Set(), cases = value.cases.map(item => {
    if (!keys(item,['id','input','expected']) || Object.keys(item).length !== 3 || typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(item.id) || seen.has(item.id)) fail('INVALID_CHECK_CASES');
    seen.add(item.id);
    return { id: item.id, input: JSON.parse(jsonCliValue(item.input)), expected: JSON.parse(jsonCliValue(item.expected)) };
  });
  const caseTimeoutMs = value.caseTimeoutMs ?? 1000, timeoutMs = value.timeoutMs ?? 5000, maxOutputBytes = value.maxOutputBytes ?? 8192;
  if (!Number.isInteger(caseTimeoutMs) || caseTimeoutMs < 50 || caseTimeoutMs > 1000 || !Number.isInteger(timeoutMs) || timeoutMs < caseTimeoutMs || timeoutMs > 5000
    || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > Math.min(8192,scope.maxOutputBytes ?? 8192)) fail('INVALID_CHECK_LIMITS');
  return { kind: 'node-json-cli', entryPath: value.entryPath, cases, caseTimeoutMs, timeoutMs, maxOutputBytes };
}
export async function nodeRuntimeIdentity(binary) {
  if (typeof binary !== 'string' || !binary.startsWith('/') || !binary.endsWith('/node')) fail('HOST_NODE_BINARY_REQUIRED');
  await secureFile(dirname(binary),basename(binary)); await access(binary,constants.X_OK);
  const path = await realpath(binary), sha = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { sha.update(chunk); bytes += chunk.length; }
  return { path, hash: sha.digest('hex'), bytes };
}
export async function bindJsonCliDefinition(value, scope, binary) {
  const definition = { ...normalizeJsonCliDefinition(value,scope), protocol: nodeJsonCliProtocol(), runtime: await nodeRuntimeIdentity(binary) };
  return { ...definition, definitionHash: digest(definition) };
}
export async function verifyJsonCliDefinition(definition) {
  const { definitionHash, protocol, runtime, ...config } = definition;
  normalizeJsonCliDefinition(config,{sourceFiles:[config.entryPath],readPaths:[config.entryPath]});
  if (digest({ ...config, protocol, runtime }) !== definitionHash) fail('CHECK_DEFINITION_CHANGED');
  if (digest(protocol) !== digest(nodeJsonCliProtocol())) fail('CHECK_PROTOCOL_MISMATCH');
  if (digest(runtime) !== digest(await nodeRuntimeIdentity(runtime?.path))) fail('CHECK_RUNTIME_MISMATCH');
}
function classify(item, expected) {
  const process = item.process;
  if (process?.closed !== true) fail('CHECK_SETTLEMENT_UNKNOWN');
  if (process.spawnError || process.isolationError) return { status:'failed',code:'CHECK_ISOLATION_UNAVAILABLE',comparison:false };
  if (process.outputLimit) return { status:'failed',code:'CHECK_OUTPUT_LIMIT',comparison:false };
  if (process.cancelled) return { status:'failed',code:'CHECK_CANCELLED',comparison:false };
  if (process.timedOut || process.signal) return { status:'failed',code:'CHECK_TIMEOUT_OR_TERMINATED',comparison:false };
  if (process.exitCode !== 0) return { status:'failed',code:'CHECK_NONZERO_EXIT',comparison:false };
  let value;
  try {
    const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(item.stdoutBase64,'base64'));
    try { value = JSON.parse(text); } catch { return {status:'failed',code:'CHECK_JSON_INVALID',comparison:false}; }
    try { jsonCliValue(value); } catch { return {status:'failed',code:'CHECK_JSON_DOMAIN',comparison:false}; }
  } catch { return {status:'failed',code:'CHECK_UTF8_INVALID',comparison:false}; }
  const comparison = isDeepStrictEqual(value,expected);
  return {status:comparison?'passed':'failed',code:comparison?'CHECK_PASSED':'CHECK_VALUE_MISMATCH',comparison};
}
async function runCase({entryFile,definition,input,timeoutMs,outputBudget,signal}) {
  const args=['--signal=TERM','--kill-after=0.2s',`${timeoutMs/1000}s`,'/usr/bin/unshare','--user','--map-root-user','--net','--fork','--kill-child=KILL','/usr/bin/bwrap',
    '--unshare-user','--unshare-all','--share-net','--die-with-parent','--new-session','--cap-drop','ALL','--disable-userns','--assert-userns-disabled','--clearenv',
    '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--dir','/runtime','--ro-bind',definition.runtime.path,'/runtime/node',
    '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/workspace','--ro-bind',entryFile,'/workspace/entry.mjs','--chdir','/workspace','--remount-ro','/','--','/runtime/node','/workspace/entry.mjs'];
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/timeout',args,{env:{PATH:'/usr/bin:/bin'},detached:true,stdio:['pipe','pipe','pipe']});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),outputLimit=false,cancelled=false,spawnError,killTimer,closed=false;
    const kill = sig => { if(child.pid)try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')spawnError=error.code;} };
    const stop = () => { kill('SIGTERM'); killTimer ??= setTimeout(()=>kill('SIGKILL'),200); };
    const abort = () => {cancelled=true;stop();};
    const capture = which => bytes => {
      const remaining=outputBudget-stdout.length-stderr.length, part=bytes.subarray(0,Math.max(0,remaining));
      if(which==='stdout')stdout=Buffer.concat([stdout,part]);else stderr=Buffer.concat([stderr,part]);
      if(bytes.length>remaining&&!outputLimit){outputLimit=true;stop();}
    };
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));
    child.stdin.on('error',()=>{}); child.once('error',error=>{spawnError=error.code;});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    // A close event includes both output pipes. An exit event alone is never completion.
    const settlement=setTimeout(()=>{if(!closed){stop();reject(new Error('CHECK_SETTLEMENT_UNKNOWN'));}},timeoutMs+1500);
    child.once('close',(exitCode,exitSignal)=>{
      closed=true;clearTimeout(settlement);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      resolve({stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64'),stdoutHash:hash(stdout),stderrHash:hash(stderr),
        process:{closed:true,exitCode,signal:exitSignal,spawnError:spawnError??null,outputLimit,cancelled,
          timedOut:exitCode===124||exitCode===137,isolationError:exitCode!==0&&/(?:unshare|bwrap):/.test(stderr.toString('utf8'))}});
    });
    child.stdin.end(input);
  });
}
export function verifyJsonCliEvidence(evidence, definition) {
  if (evidence.kind!=='node-json-cli'||evidence.definitionHash!==definition.definitionHash||digest(evidence.protocol)!==digest(definition.protocol)
    ||digest(evidence.runtime)!==digest(definition.runtime)||!evidence.sourceManifest||digest(evidence.sourceManifest.files)!==evidence.sourceManifest.hash
    ||evidence.sourceManifest.hash!==evidence.manifestHash||!Array.isArray(evidence.cases)||evidence.cases.length>definition.cases.length) fail('CHECK_EVIDENCE_MISMATCH');
  const member=evidence.sourceManifest.files.find(item=>item.path===definition.entryPath);
  if(!member||member.hash!==evidence.entryHash)fail('CHECK_ENTRY_MISMATCH');
  let total=0,failed=false;
  for(let index=0;index<evidence.cases.length;index++){
    const item=evidence.cases[index],spec=definition.cases[index];
    if(failed||item.id!==spec.id||item.inputHash!==hash(JSON.stringify(spec.input))||item.expectedHash!==hash(JSON.stringify(spec.expected)))fail('CHECK_CASE_MISMATCH');
    for(const stream of ['stdout','stderr']){
      const bytes=Buffer.from(item[`${stream}Base64`]??'','base64');
      if(bytes.toString('base64')!==item[`${stream}Base64`]||hash(bytes)!==item[`${stream}Hash`])fail('CHECK_OUTPUT_MISMATCH');total+=bytes.length;
    }
    const result=classify(item,spec.expected);
    if(item.status!==result.status||item.code!==result.code||item.comparison!==result.comparison)fail('CHECK_COMPARISON_MISMATCH');
    failed=result.status!=='passed';
  }
  if(total>definition.maxOutputBytes||digest(evidence.remainingCaseIds)!==digest(definition.cases.slice(evidence.cases.length).map(item=>item.id)))fail('CHECK_CASE_MISMATCH');
  const complete=evidence.cases.length===definition.cases.length&&!failed&&!evidence.stopped;
  const code=evidence.stopped??(failed?evidence.cases.at(-1).code:complete?'CHECK_PASSED':'CHECK_CASES_INCOMPLETE');
  if(evidence.stopped&&!['CHECK_CANCELLED','CHECK_OVERALL_TIMEOUT'].includes(evidence.stopped))fail('CHECK_EVIDENCE_MISMATCH');
  if(evidence.status!==(complete?'passed':'failed')||evidence.code!==code)fail('CHECK_COMPARISON_MISMATCH');
  return true;
}
export async function runNodeJsonCliCheck({entryFile,definition,sourceManifest,signal}) {
  if(process.platform!=='linux')fail('CHECK_ISOLATION_UNAVAILABLE');
  await verifyJsonCliDefinition(definition);
  for(const path of ['/usr/bin/timeout','/usr/bin/unshare','/usr/bin/bwrap'])await access(path,constants.X_OK);
  const entry=await readText(dirname(entryFile),basename(entryFile));
  const member=sourceManifest.files.find(item=>item.path===definition.entryPath);
  if(!member||member.hash!==entry.hash||member.bytes!==entry.bytes)fail('CHECK_ENTRY_MISMATCH');
  const start=Date.now(),cases=[];let total=0,stopped;
  for(const spec of definition.cases){
    if(signal?.aborted){stopped='CHECK_CANCELLED';break;}
    const remaining=definition.timeoutMs-(Date.now()-start);
    if(remaining<=0){stopped='CHECK_OVERALL_TIMEOUT';break;}
    const raw=await runCase({entryFile,definition,input:JSON.stringify(spec.input),timeoutMs:Math.min(definition.caseTimeoutMs,remaining),outputBudget:definition.maxOutputBytes-total,signal});
    total+=Buffer.from(raw.stdoutBase64,'base64').length+Buffer.from(raw.stderrBase64,'base64').length;
    const result=classify(raw,spec.expected);
    cases.push({id:spec.id,inputHash:hash(JSON.stringify(spec.input)),expectedHash:hash(JSON.stringify(spec.expected)),...raw,...result});
    if(result.status!=='passed')break;
    if(Date.now()-start>definition.timeoutMs){stopped='CHECK_OVERALL_TIMEOUT';break;}
  }
  if((await readText(dirname(entryFile),basename(entryFile))).hash!==entry.hash)fail('CHECK_ENTRY_MISMATCH');
  const complete=cases.length===definition.cases.length&&cases.every(item=>item.status==='passed')&&!stopped;
  const evidence={kind:'node-json-cli',status:complete?'passed':'failed',code:stopped??(complete?'CHECK_PASSED':cases.at(-1)?.code??'CHECK_CASES_INCOMPLETE'),
    ...(stopped?{stopped}:{}),entryHash:entry.hash,sourceManifest,manifestHash:sourceManifest.hash,definitionHash:definition.definitionHash,
    protocol:definition.protocol,runtime:definition.runtime,cases,remainingCaseIds:definition.cases.slice(cases.length).map(item=>item.id)};
  verifyJsonCliEvidence(evidence,definition);return evidence;
}
