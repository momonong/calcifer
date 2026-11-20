"""Local source/usage visibility does not probe accounts or spend requests."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from test_core import CORE, load_core


class SourcesUsageTests(unittest.TestCase):
    def setUp(self):
        self.Service=load_core()
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.repo=self.root/'repo'; self.repo.mkdir()
        (self.repo/'app.py').write_text('x=1\n')
        self.service=self.Service(self.root/'state',launch=lambda task:None)

    def proposal(self,session='chat-a',model='test-model'):
        return self.service.propose(session,self.repo,{'objective':'fixture','read_paths':['app.py'],
            'allowed_paths':['app.py'],'allowed_commands':[{'id':'test','argv':['python3','-B','app.py']}],
            'provider':'hermes-openai-codex','model':model})

    def dump(self):
        with self.service.store.connection() as db:return list(db.iterdump())

    def test_transport_selection_is_explicit_and_unknown_never_falls_back(self):
        from wisp_test_core import provider
        factory=getattr(provider,'create_transport',None)
        self.assertTrue(callable(factory),'executor needs an explicit provider-bound factory')
        transport=factory('hermes-openai-codex','approved-model')
        self.assertEqual(transport.model,'approved-model')
        self.assertEqual(transport.protocol,'responses')
        with patch.object(provider,'CodexTransport',side_effect=AssertionError('no fallback')):
            for name in ('agy','broker','unknown',''):
                with self.assertRaisesRegex(ValueError,'PROVIDER_NOT_AVAILABLE'):factory(name,'model')

    def test_unsupported_saved_provider_cannot_start_child_or_consume_request(self):
        from wisp_test_core.executor import run_task
        task=self.proposal();ident=task['objective_id'];self.service.approve('chat-a',ident,1)
        self.service.store.update(ident,lambda t:t.update(provider='agy'))
        with patch('wisp_test_core.executor.subprocess.Popen') as child:
            with self.assertRaisesRegex(ValueError,'PROVIDER_NOT_AVAILABLE'):
                run_task(self.service,ident,1,{})
        child.assert_not_called()
        self.assertEqual(self.service.store.load(ident)['requests_used'],0)

    def test_unknown_source_fails_at_real_launch_boundary_without_an_owner_or_unknown_receipt(self):
        from wisp_test_core.executor import launch_worker
        task=self.proposal();ident=task['objective_id']
        self.service.store.update(ident,lambda t:t.update(provider='unavailable-source'))
        runtime={key:str(self.root/key) for key in ('bun','worker','sdk')}
        for path in runtime.values():Path(path).touch()
        self.service.launch=lambda task:launch_worker(self.service,task,runtime,hermes_home=self.root)
        with patch('wisp_test_core.executor._launch_owner') as owner:
            with self.assertRaisesRegex(ValueError,'PROVIDER_NOT_AVAILABLE'):
                self.service.approve('chat-a',ident,1)
        owner.assert_not_called()
        final=self.service.store.load(ident)
        self.assertEqual(final['status'],'FAILED')
        self.assertEqual(final['process_status'],'PROCESS_TERMINATED')
        self.assertEqual(final['requests_used'],0)
        self.assertEqual(final['error'],'PROVIDER_NOT_AVAILABLE')

    def test_source_status_only_reads_allowlisted_config_fields_and_does_not_claim_login(self):
        from wisp_test_core import runtime
        self.assertTrue(callable(getattr(runtime,'source_status',None)))
        config={'model':{'provider':'antigravity-subscription-directsdk','default':'hydrogen-medium',
                'api_key':'SECRET_SENTINEL'},'auth':'OTHER_SECRET'}
        fake=types.ModuleType('hermes_cli.config');fake.load_config_readonly=lambda:config
        with patch.dict(sys.modules,{'hermes_cli.config':fake}):result=runtime.source_status()
        self.assertEqual(result['hermes_default']['provider'],config['model']['provider'])
        self.assertEqual(result['hermes_default']['model'],'hydrogen-medium')
        self.assertFalse(result['authentication_checked'])
        self.assertEqual(result['development_sources'],[
            {'id':'hermes-openai-codex','label':'ChatGPT／Codex 訂閱','protocol':'responses'},
            {'id':'hermes-openai-api','label':'OpenAI API','protocol':'responses'},
        ])
        self.assertFalse(result['automatic_fallback'])
        self.assertNotIn('SECRET',json.dumps(result))

    def test_proposal_persists_configured_provider_even_with_explicit_model(self):
        import wisp_test_core

        brief = {'objective':'fixture', 'read_paths':['app.py'], 'allowed_paths':['app.py'], 'model':'approved-model'}
        config = {'model':{'provider':'openai-api', 'default':'profile-model'},
                  'agent':{'reasoning_effort':{'enabled':True, 'effort':'low'},
                           'reasoning_overrides':{'approved-model':'high'}}}
        fake = types.ModuleType('hermes_cli.config')
        fake.load_config_readonly = lambda: config
        constants = types.ModuleType('hermes_constants')
        constants.resolve_reasoning_config = Mock(return_value={'enabled':True, 'effort':'high'})
        responses = types.ModuleType('agent.transports.codex')
        responses._resolve_reasoning = Mock(return_value=('high', True))
        with patch.dict(sys.modules, {'hermes_cli.config':fake, 'hermes_constants':constants,
                                      'agent.transports.codex':responses}), \
             patch.object(wisp_test_core,'get_service',return_value=self.service), \
             patch.object(wisp_test_core,'current_session',return_value='chat-a'), \
             patch.object(wisp_test_core,'current_project',return_value=str(self.repo)):
            result = json.loads(wisp_test_core.propose(brief))
            self.assertIn('task', result, result)
            self.assertEqual(result['task']['provider'], 'hermes-openai-api')
            self.assertEqual(result['task']['model'], 'approved-model')
            self.assertEqual(result['task']['reasoning_effort'], 'high')
            constants.resolve_reasoning_config.assert_called_once_with(config, 'approved-model')
            config['agent'] = {'reasoning_effort':False}
            constants.resolve_reasoning_config.return_value = {'enabled':False}
            responses._resolve_reasoning.return_value = ('none', False)
            disabled = json.loads(wisp_test_core.propose(brief))
            self.assertEqual(disabled['task']['reasoning_effort'], 'none')
            responses._resolve_reasoning.return_value = (None, False)
            plain = json.loads(wisp_test_core.propose({**brief, 'model':'gpt-4.1'}))
            self.assertNotIn('reasoning_effort', plain['task'])
            config['model']['provider'] = 'unknown'
            self.assertIn('error', json.loads(wisp_test_core.propose(brief)))
        self.assertEqual(len(self.service.store.list('chat-a')), 3)

    def test_usage_counts_all_history_and_never_includes_other_sessions(self):
        self.assertTrue(callable(getattr(self.service,'usage',None)))
        for _ in range(51):self.proposal()
        self.proposal('private-other-session','private-model-sentinel')
        before=self.dump();result=self.service.usage('chat-a')
        self.assertEqual(result['task_count'],51)
        self.assertEqual(result['requests_used'],0)
        self.assertNotIn('private',json.dumps(result))
        self.assertEqual(result['scope'],'current-session')
        self.assertIsNone(result['account_quota'])
        self.assertIsNone(result['tokens'])
        self.assertIsNone(result['cost'])
        self.assertEqual(before,self.dump())

    def test_usage_distinguishes_budget_used_from_dispatch_settlement_and_unknown_tasks(self):
        self.assertTrue(callable(getattr(self.service,'usage',None)))
        a=self.proposal();ident=a['objective_id'];self.service.approve('chat-a',ident,1)
        for i,state in enumerate(['completed','failed','unknown']):
            self.service.reserve_request(ident,1,str(i));self.service.commit_request(ident,1,str(i));self.service.finish_request(ident,1,str(i),state)
        self.service.terminated(ident,1,confirmed=False)
        b=self.proposal(model='other-model');ident=b['objective_id'];self.service.approve('chat-a',ident,1)
        self.service.reserve_request(ident,1,'unsent');self.service.cancel('chat-a',ident,1)
        before=self.dump();result=self.service.usage('chat-a')
        self.assertEqual(result['requests_used'],4)
        self.assertEqual(result['dispatch_committed'],3)
        self.assertEqual(result['unknown_tasks'],1)
        self.assertEqual(result['request_states'],{'reserved':0,'inflight':0,'completed':1,'failed':1,'unknown':1,'cancelled':1,'unrecognized':0})
        self.assertEqual(len(result['by_model']),2)
        self.assertEqual(sum(row['requests_used'] for row in result['by_model']),4)
        self.assertEqual(before,self.dump())

    def test_rest_and_model_overview_are_readonly_and_use_same_current_session(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        import wisp_test_core
        task=self.proposal();self.proposal('other-chat','hidden-model')
        spec=importlib.util.spec_from_file_location('wisp_overview_api',CORE/'dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
        api.get_service=lambda:self.service
        app=FastAPI();app.include_router(api.router);client=TestClient(app)
        before=self.dump()
        result=client.get('/overview',params={'session_id':'chat-a'})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['usage']['task_count'],1)
        self.assertEqual(client.post('/overview',json={'session_id':'chat-a'}).status_code,405)
        self.assertEqual(client.get('/overview').status_code,422)
        with patch.object(wisp_test_core,'get_service',return_value=self.service),patch.object(wisp_test_core,'current_session',return_value='chat-a'):
            model=json.loads(wisp_test_core.status({'overview':True}))
        self.assertEqual(model['overview']['usage'],result.json()['usage'])
        self.assertEqual(before,self.dump())


if __name__=='__main__':unittest.main()
