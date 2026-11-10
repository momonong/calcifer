import { createServer } from 'node:http';
import { readText, hash, fail } from './workspace-tools.mjs';
import { dirname, basename } from 'node:path';
import { MODEL_ID } from './goal-request-gate.mjs';

export async function readMockScript(path){
  const file=await readText(dirname(path),basename(path),{limits:{maxFileBytes:131072}});let script;
  try{script=JSON.parse(file.content);}catch{fail('INVALID_MOCK_SCRIPT');}
  if(script?.schemaVersion!==1||Object.keys(script).sort().join(',')!=='responses,schemaVersion'||!Array.isArray(script.responses)||!script.responses.length||script.responses.length>25)fail('INVALID_MOCK_SCRIPT');
  for(const r of script.responses){
    if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).some(k=>!['text','calls','mode','status','delayMs'].includes(k)))fail('INVALID_MOCK_SCRIPT');
    if(r.text!==undefined&&typeof r.text!=='string'||r.calls!==undefined&&(!Array.isArray(r.calls)||!r.calls.length||r.calls.length>8)||r.mode!==undefined&&!['partial','error-frame','redirect'].includes(r.mode)||r.status!==undefined&&![200,400,503].includes(r.status)||r.delayMs!==undefined&&(!Number.isInteger(r.delayMs)||r.delayMs<0||r.delayMs>10000))fail('INVALID_MOCK_SCRIPT');
    if(r.calls?.some(c=>!c||typeof c!=='object'||Object.keys(c).sort().join(',')!=='action,args'||typeof c.action!=='string'||!c.args||typeof c.args!=='object'))fail('INVALID_MOCK_SCRIPT');
  }
  return{script,scriptHash:file.hash};
}
function streamResponse(response,index){
  const frame=(delta,finish=null)=>'data: '+JSON.stringify({id:`mock-${index}`,object:'chat.completion.chunk',created:0,model:MODEL_ID,choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
  let text=frame({role:'assistant'});
  if(response.calls)text+=frame({tool_calls:response.calls.map((input,i)=>({index:i,id:`mock-${index}-${i}`,type:'function',function:{name:'calcifer_tool',arguments:JSON.stringify(input)}}))});
  else text+=frame({content:response.text??'Mock response complete.'});
  if(response.mode==='error-frame')return text+'data: {"error":{"message":"synthetic error"}}\n\n';
  if(response.mode==='partial')return text;
  return text+frame({},response.calls?'tool_calls':'stop')+'data: [DONE]\n\n';
}
// Fixture data only. This server never inspects a goal to choose a patch or tool.
export async function startP1Mock({script,runID,onRequest}){
  const received=[],rejections=[],timers=new Set(),pending=new Set();let closed=false,closing=false;
  const server=createServer((request,response)=>{
    if(request.method!=='POST'||request.url!=='/v1/chat/completions'||request.headers['x-calcifer-mock-run']!==runID||request.headers.host!==`127.0.0.1:${server.address().port}`){rejections.push('MOCK_HTTP_IDENTITY_REJECTED');response.writeHead(403);response.end();return;}
    let body=Buffer.alloc(0);request.on('data',part=>{body=Buffer.concat([body,part]);if(body.length>131072){request.destroy();}});
    request.on('end',()=>{
      let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{response.writeHead(400);response.end();return;}
      const index=received.length,entry={index,method:request.method,path:request.url,bodyHash:hash(body),body:payload,runID};received.push(entry);
      const item=script.responses[index];if(!item){response.writeHead(503);response.end();return;}
      const send=()=>{
        if(item.mode==='redirect'){response.writeHead(302,{location:'http://example.invalid/forbidden'});response.end();return;}
        response.writeHead(item.status??200,{'content-type':'text/event-stream','x-calcifer-mock-run':runID,'x-request-id':`mock-${index}`});response.end(streamResponse(item,index));
      };
      const deliver=async()=>{
        // Record actual receipt separately from the gate's earlier admission intent.
        await onRequest?.({index,bodyHash:entry.bodyHash,runID});
        if(closing||closed||response.destroyed)return;
        if(item.delayMs){const timer=setTimeout(()=>{timers.delete(timer);send();},item.delayMs);timers.add(timer);response.once('close',()=>{clearTimeout(timer);timers.delete(timer);});}else send();
      };
      const delivery=deliver().catch(()=>{rejections.push('MOCK_RECEIPT_FAILED');if(!response.destroyed){response.writeHead(500);response.end();}});
      pending.add(delivery);delivery.then(()=>pending.delete(delivery));
    });
  });
  await new Promise((accept,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',accept);});
  const endpoint=`http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  return{endpoint,received,rejections,get closed(){return closed;},async close(){closing=true;for(const t of timers)clearTimeout(t);timers.clear();server.closeAllConnections();await Promise.all([...pending]);await new Promise((accept,reject)=>server.close(error=>error?reject(error):accept()));closed=true;}};
}
