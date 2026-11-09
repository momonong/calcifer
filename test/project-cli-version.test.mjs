import test from 'node:test';
import assert from 'node:assert/strict';
import {validateExecution,executionProfile} from '../src/project-execution.mjs';

test('explicit current CLI profile is accepted without rewriting legacy execution identity',()=>{
 const current={backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'};
 assert.equal(validateExecution(current),current);
 const legacy={...current,version:'0.166.0-alpha.6'};
 assert.equal(validateExecution(legacy),legacy);
 assert.equal(executionProfile('codex').version,'0.167.0-alpha.3.2');
});
test('new version support remains exact and backend-specific',()=>{
 for(const version of ['0.167.0-alpha.3.3','latest','0.167.0'])
  assert.throws(()=>validateExecution({backend:'codex',model:'gpt-6-astra',version,effort:'high'}),/PROJECT_EXECUTION_INVALID/);
 assert.throws(()=>validateExecution({backend:'agy',model:'gemini-4-argon-high',version:'0.167.0-alpha.3.2',effort:'high'}),/PROJECT_EXECUTION_INVALID/);
});
