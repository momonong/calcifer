import test from 'node:test';
import assert from 'node:assert/strict';
import {parseArgs} from '../src/calcifer-cli.mjs';
test('routed project initialization needs a policy instead of a fixed backend',()=>{
 const r=parseArgs(['init','--project','another-project','--repo','/tmp/source','--profile','/tmp/project.json','--routing','/tmp/routing.json']);
 assert.equal(r.opts['--routing'],'/tmp/routing.json');assert.equal(r.opts['--backend'],undefined);
 assert.throws(()=>parseArgs(['init','--project','p','--repo','/tmp/source','--profile','/tmp/project.json','--routing','/tmp/routing.json','--backend','codex']),/不能|不可|衝突/);
});
test('explicit model and effort are accepted independently of the backend',()=>{
 const r=parseArgs(['init','--project','p','--repo','/tmp/source','--profile','/tmp/project.json','--backend','codex','--model','gpt-6-astra','--effort','high']);
 assert.equal(r.opts['--model'],'gpt-6-astra');assert.equal(r.opts['--effort'],'high');
});
test('CLI offers explicit bounded resume and receipt-preserving abandon',()=>{
 assert.equal(parseArgs(['resume','--project','p']).command,'resume');
 assert.equal(parseArgs(['abandon','--project','p','--note','Replace invalid plan']).command,'abandon');
 assert.throws(()=>parseArgs(['abandon','--project','p']),/note|原因/);
});
