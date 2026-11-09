import {randomBytes,scrypt,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {secureRoot,writeDurable} from './workspace-tools.mjs';

const derive=promisify(scrypt),hash=s=>createHash('sha256').update(s).digest('hex');
export const authError=(code,status=401)=>Object.assign(Error(code),{status});
export async function readPrivateJson(path){
 await secureRoot(dirname(path));const parent=await lstat(dirname(path));
 if(parent.uid!==process.getuid()||(parent.mode&0o077))throw authError('PRIVATE_DIRECTORY_REQUIRED',503);
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid()||(s.mode&0o077)||s.size>1048576)throw authError('PRIVATE_FILE_REQUIRED',503);return JSON.parse(await f.readFile('utf8'));}finally{await f.close();}
}
export async function createPasswordVerifier(password){
 if(typeof password!=='string'||Buffer.byteLength(password)<12||Buffer.byteLength(password)>256)throw authError('PASSWORD_LENGTH',400);
 const salt=randomBytes(32).toString('hex'),key=(await derive(password,salt,32)).toString('hex');return{version:1,salt,key};
}
export async function openAuth({stateDir,verifierPath,secure=true}){
 const file=join(stateDir,'sessions.json'),cookieName=secure?'__Secure-calcifer':'calcifer-local';
 let state={version:1,verifierId:null,sessions:{}},chain=Promise.resolve(),attempts=[],closed=false;
 try{state=await readPrivateJson(file);}catch(e){if(e.code!=='ENOENT')throw e;}
 if(state.version!==1||!state.sessions||typeof state.sessions!=='object')throw authError('AUTH_STATE_INVALID',503);
 const serial=fn=>{const p=chain.then(fn);chain=p.catch(()=>{});return p;};
 const save=()=>writeDurable(file,JSON.stringify(state));
 async function refresh(){
  if(closed)throw authError('AUTH_CLOSED',503);
  const v=await readPrivateJson(verifierPath);
  if(v.version!==1||!/^[a-f0-9]{64}$/.test(v.salt)||!/^[a-f0-9]{64}$/.test(v.key))throw authError('AUTH_VERIFIER_INVALID',503);
  const identity=hash(JSON.stringify(v));if(state.verifierId!==identity){state={version:1,verifierId:identity,sessions:{}};await save();}
  return v;
 }
 await serial(refresh);
 function cookie(token,age=43200){return`${cookieName}=${token}; Path=/calcifer/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;}
 async function authenticate(header){
  return serial(async()=>{await refresh();const matches=String(header??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(cookieName+'='));
   if(matches.length!==1)throw authError('AUTH_REQUIRED');const token=matches[0].slice(cookieName.length+1);
   if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw authError('AUTH_REQUIRED');const id=hash(token),s=state.sessions[id];
   if(!s||!Number.isFinite(s.expiresAt)||s.expiresAt<=Date.now())throw authError('AUTH_REQUIRED');return{...s,id};});
 }
 return{
  cookieName,cookie,authenticate,
  login:input=>serial(async()=>{
   const v=await refresh();attempts=attempts.filter(x=>x>Date.now()-60000);if(attempts.length>=6)throw authError('LOGIN_RATE_LIMIT',429);
   attempts.push(Date.now());const password=input?.password;
   if(typeof password!=='string'||Buffer.byteLength(password)>256||Buffer.byteLength(password)<1)throw authError('LOGIN_FAILED');
   const key=await derive(password,v.salt,32);if(!timingSafeEqual(key,Buffer.from(v.key,'hex')))throw authError('LOGIN_FAILED');
   attempts=[];const token=randomBytes(32).toString('base64url'),id=hash(token),csrf=randomBytes(32).toString('base64url');
   for(const [k,s] of Object.entries(state.sessions))if(s.expiresAt<=Date.now())delete state.sessions[k];
   if(Object.keys(state.sessions).length>=32)throw authError('DEVICE_LIMIT',409);
   const s={csrf,device:typeof input.device==='string'?input.device.replace(/[\x00-\x1f\x7f]/g,'').slice(0,80):'瀏覽器',createdAt:Date.now(),expiresAt:Date.now()+43200000};
   state.sessions[id]=s;await save();return{...s,id,cookie:cookie(token)};
  }),
  csrf(session,value){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value)||!timingSafeEqual(Buffer.from(value),Buffer.from(session.csrf)))throw authError('CSRF_REJECTED',403);},
  revoke:(id,all=false)=>serial(async()=>{await refresh();if(all)state.sessions={};else delete state.sessions[id];await save();}),
  close(){closed=true;}
 };
}
