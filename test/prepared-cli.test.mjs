import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {main,parseArgs} from '../src/calcifer-cli.mjs';
const task={task:'Finish the proposal and evidence',maxTurns:24,note:'Prepared proposal phase; existing credits allowed',title:'Thor proposal'};
function harness(extra={}){
 let out='',err='';const calls=[];const s={projectId:'p',projectName:'Thor proposal',backend:'codex',model:'gpt-6-astra',status:'ready',maxTurns:null,turnsUsed:0,pending:null,goal:null};
 const h={home:'/home/test',stdin:{isTTY:false},stdout:{isTTY:false,write:x=>out+=x},stderr:{write:x=>err+=x},process:new EventEmitter(),api:{lookupProject:async()=>null,readPreparedTask:async()=>task,projectStatus:async()=>s,authorizeProject:async p=>{calls.push(['authorize',p]);s.maxTurns=p.maxTurns;s.authorization=p.note;return s;},workProject:async p=>{calls.push(['work',p]);return {status:'completed'};},resumeProjectGoal:async p=>{calls.push(['resume',p]);return {status:'completed'};},deliverProjectDocuments:async p=>{calls.push(['deliver',p]);return {status:'draft',directory:'/delivery',docxPath:'/delivery/proposal.docx',pdfPath:'/delivery/proposal.pdf',pages:8};},...extra},calls,s,result:()=>({out,err})};return h;
}
test('explicit 24-call phase is accepted without a deadline and ceiling remains bounded',()=>{
 assert.equal(parseArgs(['authorize','--project','p','--turns','24','--note','night']).opts['--turns'],'24');
 assert.throws(()=>parseArgs(['authorize','--project','p','--turns','33','--note','too much']),/32/);
});
test('start never silently authorizes a noninteractive process',async()=>{
 const h=harness();assert.equal(await main(['start','--project','p'],h),2);assert.deepEqual(h.calls,[]);assert.match(h.result().err,/yes/);
});
test('one explicit start authorizes precise prepared phase, works and delivers',async()=>{
 const h=harness();assert.equal(await main(['start','--project','p','--yes'],h),0);
 assert.deepEqual(h.calls.map(x=>x[0]),['authorize','work','deliver']);assert.equal(h.calls[0][1].maxTurns,24);assert.equal(h.calls[0][1].maxMinutes,null);assert.equal(h.calls[1][1].task,task.task);
});
test('pending result stops before approval, work and delivery',async()=>{
 const h=harness();h.s.pending={id:'original'};h.s.status='unknown';assert.equal(await main(['start','--project','p','--yes'],h),1);assert.deepEqual(h.calls,[]);
});
test('already authorized prepared phase does not reset counters',async()=>{
 const h=harness();Object.assign(h.s,{maxTurns:24,turnsUsed:12,authorization:task.note});
 assert.equal(await main(['start','--project','p'],h),0);assert.deepEqual(h.calls.map(x=>x[0]),['work','deliver']);assert.equal(h.s.turnsUsed,12);
});
test('completed matching goal goes directly to delivery without a model dispatch',async()=>{
 const h=harness();h.s.goal={task:task.task,status:'completed'};
 assert.equal(await main(['start','--project','p'],h),0);assert.deepEqual(h.calls.map(x=>x[0]),['deliver']);
});
test('failed work does not export and conversion failure does not replay work',async()=>{
 const h=harness({workProject:async()=>({status:'failed',code:'CHECKS_FAILED'})});
 assert.equal(await main(['start','--project','p','--yes'],h),1);assert.deepEqual(h.calls.map(x=>x[0]),['authorize']);
 const d=harness({deliverProjectDocuments:async()=>{throw new Error('DOCUMENT_RENDER_FAILED');}});d.s.goal={task:task.task,status:'completed'};
 assert.equal(await main(['start','--project','p'],d),1);assert.deepEqual(d.calls,[]);
});
