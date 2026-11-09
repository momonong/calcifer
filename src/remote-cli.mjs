import {mkdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {spawn} from 'node:child_process';
import {readPrivateJson,createPasswordVerifier} from './remote-auth.mjs';
import {secureRoot,writeDurable} from './workspace-tools.mjs';

const HELP=`Calcifer 遠端工作台
  calcifer remote configure --config /私密目錄/remote.json --origin https://workbench.example.com
      --project 專案ID --state /既有專案工作階段 [--label 名稱] [--host-label 主機名稱]
      [--control-state /私密控制目錄] [--port 18470]
  calcifer remote password --config /私密目錄/remote.json
  calcifer remote serve --config /私密目錄/remote.json
configure 只登錄既有專案；不授權模型。password 須在私人的本機互動終端輸入，變更後所有舊登入失效。
serve 僅監聽 127.0.0.1，正式使用須透過已設定的 HTTPS 入口。停止服務保留進度；未知工作不自動重送。`;
const invalid=()=>{throw Error('REMOTE_OPTIONS_INVALID');};
export async function loadRemoteConfig(path){
 if(!isAbsolute(path))invalid();const c=await readPrivateJson(path);
 let u;try{u=new URL(c.origin);}catch{invalid();}
 if(c.version!==1||u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||
  !isAbsolute(c.stateDir??'')||!isAbsolute(c.verifierPath??'')||!Number.isInteger(c.port)||c.port<1024||c.port>65535||
  !Array.isArray(c.projects)||!c.projects.length||c.projects.some(p=>!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.id)||!isAbsolute(p.stateDir??'')))invalid();
 return c;
}
async function privateDirectory(path){await mkdir(path,{recursive:true,mode:0o700});await secureRoot(path);const s=await lstat(path);if(s.uid!==process.getuid()||(s.mode&0o077))throw Error('PRIVATE_DIRECTORY_REQUIRED');}
async function passwordFromTerminal(){
 // getpass opens /dev/tty; stdout is a private pipe to this process, never a log or argv.
 return new Promise((resolve,reject)=>{
  const script="import getpass,sys\na=getpass.getpass('卡西法遠端密碼（至少 12 bytes）：')\nb=getpass.getpass('再輸入一次：')\nif a!=b: sys.exit(2)\nsys.stdout.write(a)";
  const p=spawn('/usr/bin/python3',['-c',script],{stdio:['inherit','pipe','inherit']});let bytes=[];
  p.stdout.on('data',v=>bytes.push(v));p.on('error',reject);p.on('exit',code=>code===0?resolve(Buffer.concat(bytes).toString('utf8')):reject(Error('PASSWORD_NOT_CHANGED')));
 });
}
export async function remoteMain(argv=process.argv.slice(3),io={}){
 const out=io.stdout??process.stdout,err=io.stderr??process.stderr,input=io.stdin??process.stdin;
 try{
  const [command,...rest]=argv;if(!command||['help','--help','-h'].includes(command)){out.write(HELP+'\n');return 0;}
  if(!['configure','serve','password'].includes(command))invalid();const options={};
  const allowed=command==='configure'?['config','origin','project','state','control-state','port','label','host-label']:['config'];
  for(let i=0;i<rest.length;i+=2){const k=rest[i].slice(2),v=rest[i+1];if(!rest[i].startsWith('--')||!allowed.includes(k)||!v||v.startsWith('--')||options[k]!==undefined)invalid();options[k]=v;}
  const path=options.config;if(!path||!isAbsolute(path))invalid();
  if(command==='configure'){
   if(!isAbsolute(options.state??'')||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.project??''))invalid();
   let origin;try{origin=new URL(options.origin);}catch{invalid();}if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)invalid();
   const stateDir=options['control-state']??join(homedir(),'.local/state/calcifer-remote'),port=Number(options.port??18470);
   if(!isAbsolute(stateDir)||!Number.isInteger(port)||port<1024||port>65535)invalid();
   const c={version:1,origin:origin.origin,port,hostLabel:options['host-label']??'卡西法開發機',stateDir,verifierPath:join(dirname(path),'password.json'),projects:[{id:options.project,label:options.label??options.project,stateDir:options.state}]};
   await privateDirectory(dirname(path));await privateDirectory(stateDir);
   let f;try{f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if(e.code==='EEXIST')throw Error('CONFIG_ALREADY_EXISTS');throw e;}
   try{await f.writeFile(JSON.stringify(c,null,2)+'\n');await f.sync();}finally{await f.close();}
   out.write('遠端設定已保存；尚未設定登入密碼或啟動服務，模型授權未變動。\n');return 0;
  }
  const c=await loadRemoteConfig(path);
  if(command==='password'){
   if(!input.isTTY||(io.stderr??process.stderr).isTTY===false)throw Error('PRIVATE_TTY_REQUIRED');
   const verifier=await createPasswordVerifier(await passwordFromTerminal());await writeDurable(c.verifierPath,JSON.stringify(verifier)+'\n');
   out.write('密碼已更新；所有舊裝置登入立即失效，請在 HTTPS 頁面重新登入。\n');return 0;
  }
  const {createRemoteServer}=await import('./remote-server.mjs');const server=await createRemoteServer(c);
  out.write(`卡西法遠端主機已啟動（loopback:${server.port}）；HTTPS：${server.url}\n`);
  await new Promise(resolve=>{let stopping=false;const stop=()=>{if(stopping)return;stopping=true;server.close().then(resolve).catch(()=>{err.write('REMOTE_CLOSE_FAILED\n');resolve();});};process.once('SIGINT',stop);process.once('SIGTERM',stop);});return 0;
 }catch(e){err.write((/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'REMOTE_SETUP_FAILED')+'\n');return 1;}
}
