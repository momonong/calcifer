import { spawn } from 'node:child_process';
import { readFile, readdir, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { digest, hash, fail, pathList, secureRoot, readText, snapshotWorkspace, writeDurable } from './workspace-tools.mjs';
import { normalizeJsonCliDefinition, jsonCliValue, nodeRuntimeIdentity, nodeJsonCliProtocol, verifyJsonCliEvidence } from './json-cli-check.mjs';

const implementationHash=hash(await readFile(new URL(import.meta.url)));
const TEST_SCRIPT='node --test test/contract.test.mjs';
const NPM_ARGS=['--offline','--ignore-scripts','--cache=/tmp/npm-cache','--userconfig=/config/user.npmrc','--globalconfig=/config/global.npmrc','--script-shell=/usr/bin/sh','--no-audit','--no-fund','--update-notifier=false','--workspaces=false','--logs-max=0','test'];
const ENV={PATH:'/runtime:/usr/bin',HOME:'/tmp/home',TMPDIR:'/tmp',LANG:'C'};
const invocation=()=>({executable:'/runtime/node',npmArgv:['/runtime/npm/bin/npm-cli.js',...NPM_ARGS],testScript:TEST_SCRIPT,shell:'/usr/bin/sh',environment:{...ENV},userConfig:'/config/user.npmrc',globalConfig:'/config/global.npmrc',configSource:'empty-readonly-regular-file'});
export const npmRepoProtocol=()=>({kind:'node-npm-repo',version:1,implementationHash,jsonProtocol:nodeJsonCliProtocol(),npmObservation:'normal-exit-not-assertion-attestation',acceptance:'npm-normal-exit0-and-all-host-json-cases'});
const objectKeys=(value,allowed)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const configName=name=>name==='.npmrc'||name==='npmrc'||name==='.env'||name.startsWith('.env.');
export async function npmRuntimeIdentity(root){
  await secureRoot(root);const records=[],maskedConfigs=[];let files=0,bytes=0;
  const walk=async(base,prefix='')=>{
    for(const name of (await readdir(base)).sort()){
      const path=join(base,name),relative=prefix+name,info=await lstat(path);
      if(info.isSymbolicLink())fail('NPM_RUNTIME_SYMLINK_REJECTED');
      if(info.isDirectory()){records.push({path:relative,type:'directory'});await walk(path,relative+'/');}
      else if(info.isFile()&&info.nlink===1){
        if(++files>4096)fail('NPM_RUNTIME_LIMIT');
        if(configName(name)){maskedConfigs.push(relative);records.push({path:relative,type:'masked-config'});continue;}
        bytes+=info.size;if(bytes>16777216)fail('NPM_RUNTIME_LIMIT');
        records.push({path:relative,type:'file',bytes:info.size,hash:hash(await readFile(path))});
      }else fail('NPM_RUNTIME_FILE_REJECTED');
    }
  };
  await walk(root);
  const pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  if(pkg.name!=='npm'||pkg.version!=='10.9.7')fail('NPM_RUNTIME_VERSION_UNSUPPORTED');
  return{root,version:pkg.version,hash:digest(records),files,bytesExcludingMaskedConfigs:bytes,maskedConfigs};
}
async function runtimeIdentity(binary){
  const node=await nodeRuntimeIdentity(binary),npm=await npmRuntimeIdentity(resolve(dirname(node.path),'../lib/node_modules/npm'));
  const path=await realpath('/usr/bin/sh');await access(path,constants.X_OK);const bytes=await readFile(path);
  return{node,npm,shell:{path:'/usr/bin/sh',resolvedPath:path,hash:hash(bytes),bytes:bytes.length}};
}
function normalize(value,scope){
  if(!objectKeys(value,['kind','entryPath','cases','npmTimeoutMs','caseTimeoutMs','timeoutMs','maxOutputBytes'])||value.kind!=='node-npm-repo')fail('INVALID_CHECK_DEFINITION');
  const timeoutMs=value.timeoutMs??7000,npmTimeoutMs=value.npmTimeoutMs??2000;
  const json=normalizeJsonCliDefinition({kind:'node-json-cli',entryPath:value.entryPath,cases:value.cases,caseTimeoutMs:value.caseTimeoutMs,maxOutputBytes:value.maxOutputBytes,timeoutMs:Math.min(timeoutMs,5000)},scope);
  if(!Number.isInteger(npmTimeoutMs)||npmTimeoutMs<50||npmTimeoutMs>2000||!Number.isInteger(timeoutMs)||timeoutMs<npmTimeoutMs||timeoutMs<json.caseTimeoutMs||timeoutMs>7000)fail('INVALID_CHECK_LIMITS');
  return{kind:'node-npm-repo',entryPath:json.entryPath,cases:json.cases,npmTimeoutMs,caseTimeoutMs:json.caseTimeoutMs,timeoutMs,maxOutputBytes:json.maxOutputBytes};
}
function packageContract(contents,entryPath,sourceFiles){
  let pkg;try{pkg=JSON.parse(contents['package.json']);}catch{fail('INVALID_REPO_PACKAGE');}
  if(!objectKeys(pkg,['name','version','private','type','scripts'])||typeof pkg.name!=='string'||!pkg.name||typeof pkg.version!=='string'||pkg.private!==true||pkg.type!=='module'
    ||!objectKeys(pkg.scripts,['test','pretest','posttest'])||pkg.scripts.test!==TEST_SCRIPT
    ||pkg.scripts.pretest!==undefined&&pkg.scripts.pretest!=='node hook.mjs pretest'||pkg.scripts.posttest!==undefined&&pkg.scripts.posttest!=='node hook.mjs posttest'
    ||(pkg.scripts.pretest||pkg.scripts.posttest)&&!sourceFiles.includes('hook.mjs'))fail('INVALID_REPO_PACKAGE');
  if(sourceFiles.includes('package-lock.json')){
    let lock;try{lock=JSON.parse(contents['package-lock.json']);}catch{fail('INVALID_REPO_LOCK');}
    const root=lock?.packages?.[''];
    if(!objectKeys(lock,['name','version','lockfileVersion','requires','packages'])||lock.name!==pkg.name||lock.version!==pkg.version||lock.lockfileVersion!==3
      ||lock.requires!==true||!objectKeys(lock.packages,[''])||!objectKeys(root,['name','version'])||root.name!==pkg.name||root.version!==pkg.version)fail('INVALID_REPO_LOCK');
  }
  if(!sourceFiles.includes(entryPath))fail('INVALID_REPO_SCOPE');
}
export async function bindNpmRepoDefinition(value,scope,binary){
  const config=normalize(value,{...scope,maxOutputBytes:scope.limits?.maxOutputBytes});
  const sourceFiles=[...scope.sourceFiles].sort(),implementationPaths=[...scope.allowedPaths].sort();pathList(sourceFiles);pathList(implementationPaths);
  if(sourceFiles.length>16||['package.json','test/contract.test.mjs',config.entryPath].some(path=>!sourceFiles.includes(path))
    ||sourceFiles.some(path=>!['package.json','package-lock.json','test/contract.test.mjs',config.entryPath,'hook.mjs'].includes(path)&&!/^src\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs$/.test(path))
    ||sourceFiles.some(path=>path.split('/').some(part=>part==='node_modules'||configName(part)))
    ||implementationPaths.some(path=>!sourceFiles.includes(path)||!path.startsWith('src/')||!path.endsWith('.mjs')))fail('INVALID_REPO_SCOPE');
  const snapshot=await snapshotWorkspace(scope.sourceDir,sourceFiles,{writablePaths:sourceFiles,limits:scope.limits});
  if(snapshot.manifest.files.reduce((sum,item)=>sum+item.bytes,0)>131072)fail('REPO_SIZE_LIMIT');
  packageContract(snapshot.contents,config.entryPath,sourceFiles);
  const protectedFiles=snapshot.manifest.files.filter(file=>!implementationPaths.includes(file.path));
  const definition={...config,sourceFiles,implementationPaths,protectedFiles,runtime:await runtimeIdentity(binary),invocation:invocation(),protocol:npmRepoProtocol()};
  return{...definition,definitionHash:digest(definition)};
}
export async function verifyNpmRepoDefinition(definition){
  const {definitionHash,...body}=definition;
  if(digest(body)!==definitionHash)fail('CHECK_DEFINITION_CHANGED');
  if(digest(definition.protocol)!==digest(npmRepoProtocol())||digest(definition.invocation)!==digest(invocation()))fail('CHECK_PROTOCOL_MISMATCH');
  if(digest(definition.runtime)!==digest(await runtimeIdentity(definition.runtime?.node?.path)))fail('CHECK_RUNTIME_MISMATCH');
}
export function verifyNpmRepoSnapshot(manifest,definition){
  if(!manifest||digest(manifest.files)!==manifest.hash||digest(manifest.files.map(file=>file.path))!==digest(definition.sourceFiles))fail('CHECK_MANIFEST_MISMATCH');
  for(const fixed of definition.protectedFiles)if(digest(manifest.files.find(file=>file.path===fixed.path))!==digest(fixed))fail('PROTECTED_REPO_FILE_CHANGED');
}
function oracleDefinition(definition){
  const value={kind:'node-json-cli',entryPath:definition.entryPath,cases:definition.cases,caseTimeoutMs:definition.caseTimeoutMs,timeoutMs:Math.min(5000,definition.timeoutMs),maxOutputBytes:definition.maxOutputBytes,protocol:definition.protocol.jsonProtocol,runtime:definition.runtime.node};
  return{...value,definitionHash:digest(value)};
}
const outputBytes=item=>Buffer.from(item.stdoutBase64,'base64').length+Buffer.from(item.stderrBase64,'base64').length;
function normal(item){
  const p=item?.process;return p?.closed===true&&Number.isInteger(p.exitCode)&&p.exitCode>=0&&p.signal===null&&!p.spawnError&&!p.isolationError&&!p.outputLimit&&!p.cancelled&&!p.timedOut;
}
function stopCode(item){
  const p=item.process;if(p.spawnError||p.isolationError)return'CHECK_ISOLATION_UNAVAILABLE';if(p.outputLimit)return'CHECK_OUTPUT_LIMIT';if(p.cancelled)return'CHECK_CANCELLED';return'CHECK_TIMEOUT_OR_TERMINATED';
}
function compare(item,expected){
  if(!normal(item))return{status:'failed',code:stopCode(item),comparison:false};
  if(item.process.exitCode!==0)return{status:'failed',code:'CHECK_NONZERO_EXIT',comparison:false};
  let text,value;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.from(item.stdoutBase64,'base64'));}catch{return{status:'failed',code:'CHECK_UTF8_INVALID',comparison:false};}
  try{value=JSON.parse(text);}catch{return{status:'failed',code:'CHECK_JSON_INVALID',comparison:false};}
  try{jsonCliValue(value);}catch{return{status:'failed',code:'CHECK_JSON_DOMAIN',comparison:false};}
  const comparison=isDeepStrictEqual(value,expected);return{status:comparison?'passed':'failed',code:comparison?'CHECK_PASSED':'CHECK_VALUE_MISMATCH',comparison};
}
// Fixed-purpose npm/oracle lifecycle. No caller-provided executable, argv or mount DSL.
async function runStep({mode,snapshotDir,emptyFile,definition,input='',timeoutMs,outputBudget,signal}){
  const args=['--signal=TERM','--kill-after=0.2s',`${timeoutMs/1000}s`,'/usr/bin/unshare','--user','--map-root-user','--net','--fork','--kill-child=KILL','/usr/bin/bwrap',
    '--unshare-user','--unshare-all','--share-net','--die-with-parent','--new-session','--cap-drop','ALL','--disable-userns','--assert-userns-disabled','--clearenv',
    '--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--dir','/runtime','--ro-bind',definition.runtime.node.path,'/runtime/node'];
  if(mode==='npm'){
    args.push('--ro-bind',definition.runtime.npm.root,'/runtime/npm');
    for(const path of definition.runtime.npm.maskedConfigs)args.push('--ro-bind',emptyFile,join('/runtime/npm',path));
    args.push('--dir','/config','--ro-bind',emptyFile,'/config/user.npmrc','--ro-bind',emptyFile,'/config/global.npmrc');
  }
  args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--dir','/tmp/home','--dir','/tmp/npm-cache','--ro-bind',snapshotDir,'/workspace','--chdir','/workspace');
  for(const [key,value]of Object.entries(ENV))args.push('--setenv',key,value);
  args.push('--remount-ro','/','--','/runtime/node',...(mode==='npm'?['/runtime/npm/bin/npm-cli.js',...NPM_ARGS]:['/workspace/'+definition.entryPath]));
  return new Promise((accept,reject)=>{
    const child=spawn('/usr/bin/timeout',args,{env:{PATH:'/usr/bin:/bin'},detached:true,stdio:['pipe','pipe','pipe']});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),outputLimit=false,cancelled=false,spawnError=null,closed=false,killTimer;
    const kill=sig=>{if(child.pid)try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')spawnError=error.code;}};
    const stop=()=>{kill('SIGTERM');killTimer??=setTimeout(()=>kill('SIGKILL'),200);};
    const abort=()=>{cancelled=true;stop();};
    const capture=stream=>bytes=>{const left=outputBudget-stdout.length-stderr.length,part=bytes.subarray(0,Math.max(0,left));if(stream==='stdout')stdout=Buffer.concat([stdout,part]);else stderr=Buffer.concat([stderr,part]);if(bytes.length>left&&!outputLimit){outputLimit=true;stop();}};
    child.stdout.on('data',capture('stdout'));child.stderr.on('data',capture('stderr'));child.stdin.on('error',()=>{});child.once('error',error=>{spawnError=error.code;});
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(()=>{if(!closed){stop();reject(new Error('CHECK_SETTLEMENT_UNKNOWN'));}},timeoutMs+1500);
    child.once('close',(exitCode,exitSignal)=>{closed=true;clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);
      accept({stdoutBase64:stdout.toString('base64'),stderrBase64:stderr.toString('base64'),stdoutHash:hash(stdout),stderrHash:hash(stderr),
        process:{closed:true,exitCode,signal:exitSignal,spawnError,outputLimit,cancelled,timedOut:exitCode===124||exitCode===137,isolationError:exitCode!==0&&/(?:unshare|bwrap):/.test(stderr.toString('utf8'))}});
    });child.stdin.end(input);
  });
}
function verifyRaw(item){
  if(item?.process?.closed!==true)fail('CHECK_SETTLEMENT_UNKNOWN');
  for(const stream of ['stdout','stderr']){const bytes=Buffer.from(item[stream+'Base64']??'','base64');if(bytes.toString('base64')!==item[stream+'Base64']||hash(bytes)!==item[stream+'Hash'])fail('CHECK_OUTPUT_MISMATCH');}
}
export function verifyNpmRepoEvidence(evidence,definition){
  if(evidence.emptyConfigHash!==hash('')||evidence.kind!=='node-npm-repo'||evidence.definitionHash!==definition.definitionHash||digest(evidence.runtime)!==digest(definition.runtime)
    ||digest(evidence.protocol)!==digest(definition.protocol)||digest(evidence.invocation)!==digest(definition.invocation))fail('CHECK_EVIDENCE_MISMATCH');
  verifyNpmRepoSnapshot(evidence.sourceManifest,definition);if(evidence.manifestHash!==evidence.sourceManifest.hash)fail('CHECK_MANIFEST_MISMATCH');
  verifyRaw(evidence.npm);
  if(evidence.npm.manifestHash!==evidence.manifestHash||evidence.npm.definitionHash!==definition.definitionHash)fail('CHECK_EVIDENCE_MISMATCH');
  const canRun=normal(evidence.npm);
  if(canRun){if(!evidence.oracle)fail('CHECK_ORACLE_MISSING');verifyJsonCliEvidence(evidence.oracle,oracleDefinition(definition));if(evidence.oracle.manifestHash!==evidence.manifestHash)fail('CHECK_MANIFEST_MISMATCH');}
  else if(evidence.oracle!==null)fail('CHECK_ORACLE_AFTER_UNSETTLED_NPM');
  const total=outputBytes(evidence.npm)+(evidence.oracle?.cases??[]).reduce((sum,item)=>sum+outputBytes(item),0);if(total>definition.maxOutputBytes)fail('CHECK_OUTPUT_LIMIT');
  const passed=canRun&&evidence.npm.process.exitCode===0&&evidence.oracle?.status==='passed'&&!evidence.stopped;
  const code=evidence.stopped??(!canRun?stopCode(evidence.npm):evidence.oracle?.status!=='passed'?evidence.oracle.code:evidence.npm.process.exitCode!==0?'NPM_COMMAND_NONZERO':'CHECK_PASSED');
  if(evidence.stopped&&evidence.stopped!=='CHECK_OVERALL_TIMEOUT')fail('CHECK_EVIDENCE_MISMATCH');
  if(evidence.status!==(passed?'passed':'failed')||evidence.code!==code)fail('CHECK_COMPARISON_MISMATCH');return true;
}
export async function runNpmRepoCheck({snapshotDir,definition,signal,journal}){
  if(typeof journal!=='function')fail('HOST_JOURNAL_REQUIRED');
  await verifyNpmRepoDefinition(definition);
  if(process.platform!=='linux')fail('CHECK_ISOLATION_UNAVAILABLE');
  for(const file of ['/usr/bin/timeout','/usr/bin/unshare','/usr/bin/bwrap'])await access(file,constants.X_OK);
  const snapshot=await snapshotWorkspace(snapshotDir,definition.sourceFiles,{writablePaths:definition.sourceFiles,complete:true});verifyNpmRepoSnapshot(snapshot.manifest,definition);
  const emptyFile=snapshotDir+'.empty-config';await writeDurable(emptyFile,'',true);
  const observedStep=async(mode,options,caseId)=>{
    const id=randomUUID();
    await journal('intent',{id,kind:'repo-command',stage:mode,...(caseId?{caseId}:{}),manifestHash:snapshot.manifest.hash,definitionHash:definition.definitionHash,inputHash:hash(options.input??'')});
    const raw=await runStep({mode,snapshotDir,emptyFile,definition,signal,...options});
    const observation={...raw,intentId:id,manifestHash:snapshot.manifest.hash,definitionHash:definition.definitionHash};
    await journal('completed',{id,resultHash:digest(observation),repoStep:{stage:mode,...(caseId?{caseId}:{}),observation}});
    return observation;
  };
  const started=Date.now(),npm=await observedStep('npm',{timeoutMs:definition.npmTimeoutMs,outputBudget:definition.maxOutputBytes});
  let oracle=null,stopped;
  if(normal(npm)){
    const cases=[],derived=oracleDefinition(definition);let total=outputBytes(npm),oracleStop;
    for(const spec of definition.cases){
      if(signal?.aborted){oracleStop='CHECK_CANCELLED';break;}
      const left=definition.timeoutMs-(Date.now()-started);if(left<=0){oracleStop='CHECK_OVERALL_TIMEOUT';stopped=oracleStop;break;}
      const raw=await observedStep('oracle',{input:JSON.stringify(spec.input),timeoutMs:Math.min(definition.caseTimeoutMs,left),outputBudget:definition.maxOutputBytes-total},spec.id);
      total+=outputBytes(raw);const result=compare(raw,spec.expected);cases.push({id:spec.id,inputHash:hash(JSON.stringify(spec.input)),expectedHash:hash(JSON.stringify(spec.expected)),...raw,...result});
      if(result.status!=='passed')break;
      if(Date.now()-started>definition.timeoutMs){oracleStop='CHECK_OVERALL_TIMEOUT';stopped=oracleStop;break;}
    }
    const complete=cases.length===definition.cases.length&&cases.every(item=>item.status==='passed')&&!oracleStop;
    oracle={kind:'node-json-cli',status:complete?'passed':'failed',code:oracleStop??(complete?'CHECK_PASSED':cases.at(-1)?.code??'CHECK_CASES_INCOMPLETE'),...(oracleStop?{stopped:oracleStop}:{}),
      entryHash:snapshot.manifest.files.find(file=>file.path===definition.entryPath).hash,sourceManifest:snapshot.manifest,manifestHash:snapshot.manifest.hash,definitionHash:derived.definitionHash,protocol:derived.protocol,runtime:derived.runtime,cases,remainingCaseIds:definition.cases.slice(cases.length).map(item=>item.id)};
  }
  const after=await snapshotWorkspace(snapshotDir,definition.sourceFiles,{complete:true});if(after.manifest.hash!==snapshot.manifest.hash)fail('CHECK_MANIFEST_CHANGED');
  const passed=normal(npm)&&npm.process.exitCode===0&&oracle?.status==='passed'&&!stopped;
  const evidence={kind:'node-npm-repo',status:passed?'passed':'failed',code:stopped??(!normal(npm)?stopCode(npm):oracle?.status!=='passed'?oracle.code:npm.process.exitCode!==0?'NPM_COMMAND_NONZERO':'CHECK_PASSED'),...(stopped?{stopped}:{}),
    emptyConfigHash:hash(''),emptyConfigFile:basename(emptyFile),runtime:definition.runtime,protocol:definition.protocol,invocation:definition.invocation,sourceManifest:snapshot.manifest,manifestHash:snapshot.manifest.hash,definitionHash:definition.definitionHash,npm,oracle};
  verifyNpmRepoEvidence(evidence,definition);return evidence;
}
