import {createServer} from 'node:http';
import {readFile,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openController,commandId} from './remote-controller.mjs';
import {openAuth,authError} from './remote-auth.mjs';
import {secureFile} from './workspace-tools.mjs';

const PREFIX='/calcifer/',JSON_TYPE='application/json; charset=utf-8';
const CSP="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function respond(res,status,body,type=JSON_TYPE){res.writeHead(status,{'Content-Type':type});res.end(typeof body==='string'||Buffer.isBuffer(body)?body:JSON.stringify(body));}
async function body(req){
 if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')throw authError('JSON_REQUIRED',415);
 if(Number(req.headers['content-length'])>32768)throw authError('BODY_TOO_LARGE',413);
 let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw authError('BODY_TOO_LARGE',413);chunks.push(chunk);}
 try{const v=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!v||typeof v!=='object'||Array.isArray(v))throw Error();return v;}catch{throw authError('INVALID_JSON',400);}
}
export async function createRemoteServer(config,{api}={}){
 const allowed=new URL(config.origin);
 if(allowed.username||allowed.password||allowed.pathname!=='/'||allowed.search||allowed.hash||
   (allowed.protocol!=='https:'&&!(config.allowHttp===true&&allowed.protocol==='http:'&&['127.0.0.1','localhost'].includes(allowed.hostname))))throw Error('HTTPS_ORIGIN_REQUIRED');
 const controller=await openController({...config,api:api??await import('./project-session.mjs')});
 let auth;try{auth=await openAuth({...config,secure:allowed.protocol==='https:'});}catch(e){await controller.close();throw e;}
 const streams=new Set(),assets=config.assetsDir??fileURLToPath(new URL('../web/remote/',import.meta.url));let closing=false;
 const cookieSession=s=>({csrf:s.csrf,device:s.device,expiresAt:s.expiresAt,hostLabel:config.hostLabel??'卡西法開發機'});
 const app=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',CSP);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  try{
   if(closing)throw authError('HOST_STOPPING',503);
   if(req.headers.host!==allowed.host||req.headers.origin&&req.headers.origin!==allowed.origin)throw authError('ORIGIN_REJECTED',403);
   if(allowed.protocol==='https:'&&req.headers['x-forwarded-proto']!=='https')throw authError('HTTPS_REQUIRED',403);
   if(req.headers['sec-fetch-site']==='cross-site')throw authError('ORIGIN_REJECTED',403);
   if(req.method==='POST'&&req.headers.origin!==allowed.origin)throw authError('ORIGIN_REJECTED',403);
   const url=new URL(req.url,allowed);if(!url.pathname.startsWith(PREFIX)){respond(res,404,{error:'NOT_FOUND'});return;}
   const route=url.pathname.slice(PREFIX.length);
   if(req.method==='GET'&&route==='health'){respond(res,200,{service:'calcifer',ready:!closing&&controller.snapshot().storageHealthy});return;}
   const staticFiles={'':['index.html','text/html; charset=utf-8'],'app.mjs':['app.mjs','text/javascript; charset=utf-8'],'app.css':['app.css','text/css; charset=utf-8']};
   if(req.method==='GET'&&Object.hasOwn(staticFiles,route)){const [file,type]=staticFiles[route];respond(res,200,await readFile(join(assets,file)),type);return;}
   if(!route.startsWith('api/')){respond(res,404,{error:'NOT_FOUND'});return;}
   const endpoint=route.slice(4);
   if(req.method==='POST'&&endpoint==='login'){const s=await auth.login(await body(req));res.setHeader('Set-Cookie',s.cookie);respond(res,200,cookieSession(s));return;}
   // A request that was still uploading when its login was revoked is not authorized.
   const input=req.method==='POST'?await body(req):null;
   const session=await auth.authenticate(req.headers.cookie);
   if(req.method==='POST')auth.csrf(session,req.headers['x-csrf-token']);
   if(req.method==='GET'&&endpoint==='session'){respond(res,200,cookieSession(session));return;}
   if(req.method==='POST'&&['logout','logout-all'].includes(endpoint)){
    await auth.revoke(session.id,endpoint==='logout-all');res.setHeader('Set-Cookie',auth.cookie('',0));
    for(const s of streams)if(endpoint==='logout-all'||s.id===session.id)s.res.end();respond(res,200,{loggedOut:true});return;
   }
   if(req.method==='GET'&&endpoint==='snapshot'){respond(res,200,{...await controller.sync(),hostLabel:config.hostLabel??'卡西法開發機'});return;}
   if(req.method==='GET'&&endpoint==='projects'){respond(res,200,controller.snapshot().projects);return;}
   if(req.method==='POST'&&endpoint==='commands'){respond(res,202,await controller.submit(input));return;}
   const match=endpoint.match(/^commands\/([^/]+)(?:\/(cancel|patch))?$/);
   if(match){
    const [,id,action]=match;if(!commandId(id))throw authError('COMMAND_INVALID',400);
    const command=controller.command(id);if(!command)throw authError('COMMAND_NOT_FOUND',404);
    if(req.method==='GET'&&!action){respond(res,200,command);return;}
    if(req.method==='POST'&&action==='cancel'){respond(res,200,await controller.cancel(id));return;}
    if(req.method==='GET'&&action==='patch'){
     const artifact=controller.artifact(id),project=controller.project(command.project);if(!artifact)throw authError('PATCH_NOT_READY',409);
     try{
      const root=join(project.stateDir,'exports'),path=await secureFile(root,relative(root,artifact.path),true);
      const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes;
      try{const stat=await f.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>16777216)throw Error();bytes=await f.readFile();}finally{await f.close();}
      if(bytes.length>16777216||createHash('sha256').update(bytes).digest('hex')!==artifact.hash)throw Error();
      res.setHeader('Content-Disposition',`attachment; filename="calcifer-${command.project}-${id.slice(0,8)}.patch"`);respond(res,200,bytes,'text/plain; charset=utf-8');return;
     }catch{throw authError('PATCH_CHANGED_OR_UNSAFE',409);}
    }
   }
   if(req.method==='GET'&&endpoint==='events'){
    const raw=req.headers['last-event-id']??url.searchParams.get('after')??'0';if(!/^\d{1,12}$/.test(raw))throw authError('CURSOR_INVALID',400);let cursor=Number(raw);
    if(streams.size>=32)throw authError('STREAM_LIMIT',429);
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});
    const client={id:session.id,res};streams.add(client);let sending=false;
    const send=async(heartbeat=false)=>{if(sending||res.destroyed||res.writableEnded)return;sending=true;try{
     await auth.authenticate(req.headers.cookie);const batch=controller.events(cursor);
     if(batch.cursor!==cursor||batch.reset||heartbeat){const frame=`id: ${batch.cursor}\nevent: update\ndata: ${JSON.stringify(batch)}\n\n`;if(!res.write(frame)){res.end();return;}cursor=batch.cursor;}
    }catch{res.end();}finally{sending=false;}};
    const off=controller.subscribe(()=>{void send();}),timer=setInterval(()=>{void send(true);},15000);timer.unref();
    res.on('close',()=>{off();clearInterval(timer);streams.delete(client);});await send(true);return;
   }
   respond(res,404,{error:'NOT_FOUND'});
  }catch(e){
   if(res.headersSent){res.end();return;}
   const name=/^[A-Z][A-Z0-9_]{1,80}$/.test(e.message)?e.message:'REMOTE_REQUEST_FAILED';
   const status=e.status??({COMMAND_INVALID:400,PROJECT_NOT_REGISTERED:404,COMMAND_NOT_FOUND:404,COMMAND_CONFLICT:409,PROJECT_UNKNOWN:409,PROJECT_BUSY:409,COMMAND_LIMIT:409,REMOTE_CLOSED:503}[name]??500);
   respond(res,status,{error:name});
  }
 });
 app.requestTimeout=15000;app.headersTimeout=10000;app.maxHeadersCount=40;app.keepAliveTimeout=5000;
 try{await new Promise((ok,no)=>{app.once('error',no);app.listen(config.port??18470,'127.0.0.1',ok);});}catch(e){auth.close();await controller.close();throw e;}
 if(allowed.port==='0'&&config.allowHttp)allowed.port=String(app.address().port);
 return{controller,url:allowed.origin+PREFIX,port:app.address().port,
  async close(){if(closing)return;closing=true;for(const s of streams)s.res.end();await controller.close();auth.close();app.closeAllConnections();await new Promise(r=>app.close(r));}
 };
}
