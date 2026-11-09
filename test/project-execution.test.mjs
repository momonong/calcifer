import test from 'node:test';
import assert from 'node:assert/strict';
import {executionProfile,validateExecution} from '../src/project-execution.mjs';

test('new defaults select Astra high while legacy Sol medium execution stays readable',()=>{
 assert.deepEqual(executionProfile('codex'),{backend:'codex',model:'gpt-6-astra',version:'0.167.0-alpha.3.2',effort:'high'});
 const legacy={backend:'codex',model:'gpt-6.1-sol',version:'0.166.0-alpha.6',effort:'medium'};
 assert.equal(validateExecution(legacy),legacy);
 assert.deepEqual(executionProfile(),{backend:'agy',model:'gemini-4-argon-medium',version:'1.5.3',effort:'medium'});
});
test('verified models select explicit effort independently of model ID tier',()=>{
 for(const [backend,models] of [['codex',['gpt-6-astra','gpt-6.1-sol','gpt-6.1-terra','gpt-6-luna']],['agy',['gemini-4-argon-low','gemini-4-argon-medium','gemini-4-argon-high']]])
  for(const model of models)for(const effort of ['low','medium','high','xhigh','max']){
   const profile=executionProfile(backend,{model,effort});
   assert.equal(profile.model,model);assert.equal(profile.effort,effort);assert.equal(validateExecution(profile),profile);
  }
});
test('profiles reject unknown registry entries, keys, effort and version before dispatch',()=>{
 for(const backend of ['unknown','toString','constructor','__proto__',null])assert.throws(()=>executionProfile(backend),/PROJECT_BACKEND_UNSUPPORTED/);
 for(const options of [{model:'gpt-unknown'},{model:'gemini-4-argon-high'},{effort:'ultra'},{effort:null},{extra:true},null,[]])assert.throws(()=>executionProfile('codex',options),/PROJECT_EXECUTION_INVALID/);
 const good={backend:'codex',model:'gpt-6.1-sol',version:'0.166.0-alpha.6',effort:'medium'};
 for(const profile of [null,[],{...good,version:'0.0.0'},{...good,backend:'constructor'},{...good,model:'gpt-unknown'},{...good,effort:'ultra'},{...good,extra:true},{backend:good.backend,model:good.model,version:good.version}])assert.throws(()=>validateExecution(profile),/PROJECT_EXECUTION_INVALID/);
});
