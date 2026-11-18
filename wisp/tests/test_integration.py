"""Real OpenCode + controller + Linux check sandbox, synthetic inference only."""
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import unittest
from unittest.mock import patch

from test_core import WorkflowTests, load_core

REPO = Path(__file__).resolve().parents[2]
RUNTIME = {'bun': str(REPO/'node_modules/.bin/bun'), 'sdk': str(REPO/'node_modules/@opencode/sdk/dist/index.js'),
    'worker': str(REPO/'wisp/executors/opencode-worker.mjs'), 'protocol': 'responses',
    'bun_version':'1.4.4', 'opencode_version':'2.1.4'}


def response(index, args=None):
    """Recorded wire shape, not a provider call or a model-quality evaluation."""
    ident = f'resp_{index}'
    item = ({'id':f'fc_{index}', 'type':'function_call', 'call_id':f'call_{index}', 'name':'wisp_workspace',
        'arguments':json.dumps(args), 'status':'completed'} if args else
        {'id':f'msg_{index}', 'type':'message', 'role':'assistant', 'status':'completed',
        'content':[{'type':'output_text','text':'Candidate prepared; review the check evidence.', 'annotations':[]}]})
    base = {'id':ident,'object':'response','created_at':1,'model':'test-model','status':'in_progress','output':[]}
    events = [{'type':'response.created','response':base},
        {'type':'response.output_item.added','output_index':0,'item':{**item, 'arguments':''} if args else item}]
    if args:
        events += [{'type':'response.function_call_arguments.delta','item_id':item['id'],'output_index':0,'delta':item['arguments']},
            {'type':'response.function_call_arguments.done','item_id':item['id'],'output_index':0,'arguments':item['arguments']}]
    else:
        events += [{'type':'response.output_text.delta','item_id':item['id'],'output_index':0,'content_index':0,
            'delta':item['content'][0]['text']}]
    events += [{'type':'response.output_item.done','output_index':0,'item':item},
        {'type':'response.completed','response':{**base,'status':'completed','output':[item],
            'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}}}]
    return {'status':200, 'headers':{'content-type':'text/event-stream'},
        'body':''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events)}


@unittest.skipUnless(os.getenv('WISP_OFFLINE_INTEGRATION') == '1', 'explicit offline subprocess/sandbox integration opt-in')
class IntegrationTests(WorkflowTests):
    # Reuse fixture helpers without rerunning the inherited unit-test suite here.
    def setUp(self):
        super().setUp()
        (self.repo/'test.py').write_text('from app import answer\nassert answer == 2\nprint("check passed")\n')
        self.threads=[]
    def tearDown(self):
        for thread in self.threads: thread.join(5)
        super().tearDown()

    def start(self, transport, *, max_requests=None):
        from wisp_test_core.executor import run_task
        def launch(task):
            thread=threading.Thread(target=run_task,args=(self.service,task['objective_id'],task['approval_version'],RUNTIME,transport))
            thread.start(); self.threads.append(thread)
        self.service.launch=launch
        task=self.proposal()
        if max_requests is not None:
            self.service.store.update(task['objective_id'], lambda t: t['limits'].update(max_requests=max_requests), event='fixture-limit')
        self.service.approve('chat-a',task['objective_id'],1)
        return task['objective_id']

    def test_request_limit_stops_before_next_dispatch_and_preserves_candidate_diff(self):
        calls=[]
        def fixture(data,timeout):
            calls.append(data)
            return response(len(calls),{'action':'replace','path':'app.py','old_text':'answer = 1','new_text':'answer = 2'})
        ident=self.start(fixture,max_requests=1)
        task=self.wait_for(ident,{'FAILED','TERMINATION_UNKNOWN','REVIEW'})
        self.assertEqual(task['status'],'FAILED',task)
        self.assertEqual(task['error'],'REQUEST_LIMIT')
        self.assertEqual(task['process_status'],'PROCESS_TERMINATED')
        self.assertEqual(len(calls),1)
        self.assertEqual(task['requests'][0]['status'],'completed')
        self.assertIn('+answer = 2',task['diff'])
        self.assertEqual(self.Service(self.root/'state').snapshot('chat-a',ident)['status'],'FAILED')
        with self.assertRaisesRegex(ValueError,'BUDGET_EXHAUSTED'):
            self.service.revise('chat-a',ident,1,'Please continue')

    def test_sdk_receives_remaining_budget_and_single_file_batch_edits(self):
        calls=[]
        def fixture(data,timeout):
            calls.append(data['body'])
            steps=[{'action':'read','path':'app.py'},
                {'action':'replace_many','path':'app.py','edits':[
                    {'old_text':'answer = 1','new_text':'answer = 2'},
                    {'old_text':'answer = 2','new_text':'# batch edit\nanswer = 2'}]},
                {'action':'check','command_id':'test'},None]
            return response(len(calls),steps[len(calls)-1])
        ident=self.start(fixture,max_requests=4)
        task=self.wait_for(ident,{'WAITING_APPROVAL','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'WAITING_APPROVAL',task)
        self.service.decide_check('chat-a',ident,1,task['permissions'][-1]['id'],True)
        task=self.wait_for(ident,{'REVIEW','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'REVIEW',task)
        self.assertEqual(task['requests_used'],4)
        self.assertEqual((self.service.candidate(ident)/'app.py').read_text(),'# batch edit\nanswer = 2\n')
        self.assertEqual((self.repo/'app.py').read_text(),'answer = 1\n')
        # Inspect only the synthetic wire payload; no real provider calls.
        def budgets(value):
            if isinstance(value,str):
                try: return budgets(json.loads(value))
                except (ValueError,TypeError): return []
            if isinstance(value,list): return [b for v in value for b in budgets(v)]
            if isinstance(value,dict):
                found=[value['budget']] if isinstance(value.get('budget'),dict) else []
                return found+[b for v in value.values() for b in budgets(v)]
            return []
        history=budgets(calls[-1])
        self.assertTrue(any(b['requests_remaining']==3 for b in history),history)
        self.assertTrue(any(b['requests_remaining']==1 for b in history),history)

    def wait_for(self, ident, states, timeout=15):
        until=time.monotonic()+timeout
        while time.monotonic()<until:
            task=self.service.snapshot('chat-a',ident)
            if task['status'] in states: return task
            time.sleep(.05)
        self.fail('No expected state: '+json.dumps(self.service.snapshot('chat-a',ident)))

    def test_real_responses_sdk_check_approval_revision_and_reopen(self):
        calls=[]
        def fixture(data, timeout):
            self.assertEqual(data['url'],'https://wisp.invalid/v1/responses')
            calls.append(data['body'])
            # The same native session performs a second approved revision.
            steps=[{'action':'read','path':'app.py'}, {'action':'edit','path':'app.py','content':'answer = 2\n'},
                {'action':'check','command_id':'test'}, None,
                {'action':'edit','path':'app.py','content':'# reviewed\nanswer = 2\n'}, {'action':'check','command_id':'test'},None]
            return response(len(calls),steps[len(calls)-1])
        ident=self.start(fixture)
        task=self.wait_for(ident,{'WAITING_APPROVAL','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'WAITING_APPROVAL',json.dumps(task))
        self.assertEqual(task['checks'],[])
        self.service.decide_check('chat-a',ident,1,task['permissions'][-1]['id'],True)
        task=self.wait_for(ident,{'REVIEW','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'REVIEW',json.dumps(task))
        self.assertEqual(task['checks'][0]['exit_code'],0,task['checks'])
        native=task['native_session']
        self.service.revise('chat-a',ident,1,'Add a short review comment and rerun the check.')
        self.assertEqual(self.service.snapshot('chat-a',ident)['checks'],[])
        task=self.wait_for(ident,{'WAITING_APPROVAL','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'WAITING_APPROVAL',json.dumps(task))
        self.service.decide_check('chat-a',ident,2,task['permissions'][-1]['id'],True)
        task=self.wait_for(ident,{'REVIEW','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'REVIEW',json.dumps(task))
        accepted=self.service.accept('chat-a',ident,2)
        self.assertEqual(accepted['native_session'],native)
        self.assertEqual(accepted['requests_used'],7)
        self.assertEqual(accepted['completion']['source']['approval_version'],2)
        self.assertEqual((self.repo/'app.py').read_text(),'answer = 1\n')
        reopened=self.Service(self.root/'state').snapshot('chat-a',ident)
        self.assertEqual(reopened['status'],'ACCEPTED')
        self.assertIn('+# reviewed',reopened['diff'])

    def test_cancel_while_provider_outcome_unknown_never_redispatches(self):
        entered=threading.Event(); release=threading.Event(); calls=[]
        def fixture(data, timeout):
            calls.append(data); entered.set(); release.wait(5)
            raise TimeoutError('simulated unknown result')
        ident=self.start(fixture)
        try:
            self.assertTrue(entered.wait(10))
            self.service.cancel('chat-a',ident,1)
            task=self.wait_for(ident,{'TERMINATION_UNKNOWN'})
            self.assertEqual(task['process_status'],'PROCESS_TERMINATED')
            with self.assertRaises(ValueError): self.service.revise('chat-a',ident,1,'retry')
        finally: release.set()
        self.threads[-1].join(5)
        self.assertEqual(len(calls),1)
        task=self.Service(self.root/'state').snapshot('chat-a',ident)
        self.assertEqual(task['status'],'TERMINATION_UNKNOWN')
        self.assertEqual(task['requests'][0]['status'],'unknown')

    def test_cancel_waiting_for_command_has_confirmed_process_exit(self):
        ident=self.start(lambda data,timeout:response(1,{'action':'check','command_id':'test'}))
        task=self.wait_for(ident,{'WAITING_APPROVAL','FAILED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'WAITING_APPROVAL',json.dumps(task))
        self.service.cancel('chat-a',ident,1)
        task=self.wait_for(ident,{'PROCESS_TERMINATED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'PROCESS_TERMINATED',json.dumps(task))
        self.assertEqual(task['checks'],[])

    def test_cancel_between_reservation_and_commit_sends_zero_model_calls(self):
        reserve=self.service.reserve_request; calls=[]
        def barrier(ident,version,request):
            result=reserve(ident,version,request)
            self.service.cancel('chat-a',ident,version)
            return result
        self.service.reserve_request=barrier
        ident=self.start(lambda data,timeout:calls.append(data))
        task=self.wait_for(ident,{'PROCESS_TERMINATED','TERMINATION_UNKNOWN'})
        self.assertEqual(task['status'],'PROCESS_TERMINATED',json.dumps(task))
        self.assertEqual(calls,[])
        self.assertEqual(task['requests'][0]['status'],'cancelled')

    def test_cancel_during_check_preparation_cannot_spawn_after_stopping(self):
        from wisp_test_core import executor
        request=self.service.request_check; original=executor.check_argv; spawned=[]; popen=subprocess.Popen
        def auto_allow(ident,version,command):
            value=request(ident,version,command)
            self.service.decide_check('chat-a',ident,version,value['id'],True)
            return value
        def barrier(candidate,argv,seconds):
            ident=candidate.parent.name
            self.service.cancel('chat-a',ident,1)
            self.wait_for(ident,{'PROCESS_TERMINATED'})
            return original(candidate,argv,seconds)
        def observe(argv,**kw):
            if argv[0]=='/usr/bin/timeout': spawned.append(argv)
            return popen(argv,**kw)
        self.service.request_check=auto_allow
        with patch.object(executor,'check_argv',side_effect=barrier),patch.object(executor.subprocess,'Popen',side_effect=observe):
            ident=self.start(lambda data,timeout:response(1,{'action':'check','command_id':'test'}))
            self.threads[-1].join(10)
            self.assertFalse(self.threads[-1].is_alive())
        self.assertEqual(spawned,[])
        self.assertEqual(self.service.snapshot('chat-a',ident)['status'],'PROCESS_TERMINATED')


# unittest otherwise inherits the fixture's unit test methods a second time.
for name in vars(WorkflowTests):
    if name.startswith('test_'): setattr(IntegrationTests,name,None)
del WorkflowTests

if __name__=='__main__': unittest.main()
