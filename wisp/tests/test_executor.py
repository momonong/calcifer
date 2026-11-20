from pathlib import Path
import sys
import tempfile
import subprocess
import time
import json
import types
import unittest
from unittest.mock import patch

from test_core import load_core


class ExecutorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        load_core()

    def test_provider_rejects_model_or_endpoint_override_without_call(self):
        from wisp_test_core.provider import CodexTransport
        called = []
        provider = CodexTransport('approved-model', request=lambda *a, **k: called.append((a,k)))
        for data in ({'url':'https://evil.example/responses','body':{'model':'approved-model'}},
                     {'url':'https://wisp.invalid/v1/responses','body':{'model':'other'}}):
            with self.assertRaises(ValueError):
                provider(data, 10)
        self.assertEqual(called, [])

    def test_provider_uses_host_credential_helper_without_returning_headers(self):
        from wisp_test_core.provider import CodexTransport
        seen = []
        class Reply:
            status = 200
            headers = {'content-type':'text/event-stream','set-cookie':'never-forward'}
            body = b'data: [DONE]\n\n'
        def request(*args, **kwargs):
            seen.append((args,kwargs)); return Reply()
        result = CodexTransport('approved-model', request=request)({'url':'https://wisp.invalid/v1/responses',
            'body':{'model':'approved-model','input':[],'store':True,'max_output_tokens':8192}}, 10)
        self.assertEqual(seen[0][0], ('openai-codex','POST','https://chatgpt.com/backend-api/codex/responses'))
        self.assertFalse(seen[0][1]['json']['store'])
        self.assertNotIn('max_output_tokens', seen[0][1]['json'])
        self.assertNotIn('set-cookie', result['headers'])
        self.assertNotIn('Authorization', seen[0][1].get('headers', {}))

    def test_direct_api_uses_profile_key_and_fixed_streaming_responses_endpoint(self):
        import httpx
        from wisp_test_core.provider import create_transport

        requests = []
        def send(request):
            requests.append(request)
            return httpx.Response(200, headers={'content-type':'text/event-stream', 'set-cookie':'private'},
                content=b'data: [DONE]\n\n')

        secrets = types.ModuleType('agent.secret_scope')
        seen_paths = []
        def load_env_file(path):
            seen_paths.append(path)
            return {'OPENAI_API_KEY':'sk-profile-test-key'}
        secrets.load_env_file = load_env_file
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {'agent.secret_scope':secrets}):
            home = Path(tmp) / 'selected'
            transport = create_transport('hermes-openai-api', 'approved-model', hermes_home=home,
                                         reasoning_effort='high')
            self.assertEqual(seen_paths, [home / '.env'])
            client = httpx.Client(transport=httpx.MockTransport(send))
            with patch('httpx.Client', return_value=client):
                with self.assertRaisesRegex(ValueError, 'PROVIDER_ENDPOINT_MISMATCH'):
                    transport({'url':'https://elsewhere.example/v1/responses', 'body':{'model':'approved-model'}}, 10)
                with self.assertRaisesRegex(ValueError, 'PROVIDER_REQUEST_INVALID'):
                    transport({'url':'https://wisp.invalid/v1/responses', 'body':{'model':'other'}}, 10)
                result = transport({'url':'https://wisp.invalid/v1/responses',
                    'body':{'model':'approved-model', 'input':[], 'store':True, 'max_output_tokens':8192,
                            'reasoning':{'effort':'medium', 'summary':'auto'}, 'temperature':0.7}}, 10)

        request, = requests
        self.assertEqual((request.method, str(request.url)), ('POST', 'https://api.openai.com/v1/responses'))
        self.assertEqual(request.headers['authorization'], 'Bearer sk-profile-test-key')
        body = json.loads(request.content)
        self.assertTrue(body['stream'])
        self.assertFalse(body['store'])
        self.assertIn('reasoning.encrypted_content', body['include'])
        self.assertEqual(body['max_output_tokens'], 8192)
        self.assertEqual(body['reasoning'], {'effort':'high', 'summary':'auto'})
        self.assertNotIn('temperature', body)
        self.assertEqual(result, {'status':200, 'headers':{'content-type':'text/event-stream'}, 'body':'data: [DONE]\n\n'})

    def test_direct_api_rejects_redirect_without_forwarding_key_or_provider_error_body(self):
        import httpx
        from wisp_test_core.provider import OpenAIAPITransport

        destinations = []
        def redirect(request):
            destinations.append(str(request.url))
            return httpx.Response(307, headers={'location':'https://elsewhere.example'}, content=b'private response')

        client = httpx.Client(transport=httpx.MockTransport(redirect), follow_redirects=True)
        with patch('httpx.Client', return_value=client):
            result = OpenAIAPITransport('approved-model', 'sk-test-key')({'url':'https://wisp.invalid/v1/responses',
                'body':{'model':'approved-model'}}, 10)
        self.assertEqual(destinations, ['https://api.openai.com/v1/responses'])
        self.assertEqual(result['status'], 307)
        self.assertEqual(result['body'], '')

    def test_direct_api_missing_or_proxy_bound_key_stops_before_owner_launch(self):
        from wisp_test_core.executor import launch_worker

        secrets = types.ModuleType('agent.secret_scope')
        cases = [({}, 'OPENAI_API_KEY_REQUIRED'),
                 ({'OPENAI_API_KEY':'sk-test-key', 'OPENAI_BASE_URL':'https://proxy.example/v1'}, 'OPENAI_API_BASE_URL_REFUSED')]
        with patch.dict(sys.modules, {'agent.secret_scope':secrets}), \
             patch.dict('os.environ', {'OPENAI_API_KEY':'sk-other-profile'}), \
             patch('wisp_test_core.executor.require_support'), patch('wisp_test_core.executor._launch_owner') as owner:
            for values, code in cases:
                secrets.load_env_file = lambda path: values
                with self.assertRaisesRegex(ValueError, code):
                    launch_worker(None, {'provider':'hermes-openai-api'}, {}, hermes_home=Path('/selected-profile'))
            owner.assert_not_called()

    def test_command_boundary_has_no_host_home_or_network_and_candidate_is_readonly(self):
        from wisp_test_core.executor import check_argv
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            args = check_argv(root, ['python3','-B','test.py'], 10)
            self.assertIn('--unshare-all', args)
            self.assertIn('--clearenv', args)
            self.assertNotIn('--share-net', args[args.index('/usr/bin/bwrap'):])
            index=args.index(str(root))
            self.assertEqual(args[index-1], '--ro-bind')
            self.assertEqual(args[index+1], '/workspace')
            self.assertNotIn(str(Path.home()), args)
            self.assertEqual(args[-3:], ['python3','-B','test.py'])

    def test_worker_uses_selected_profile_not_gateway_startup_home(self):
        from wisp_test_core.executor import launch_worker
        seen=[]
        class Store:
            def update(self,*a,**kw): pass
        class Service:
            root=Path('/tmp/task-state')
            store=Store()
        class Child:
            pid=123
            def wait(self): return 0
        def spawn(*args,**kwargs): seen.append(kwargs['env']); return Child()
        with tempfile.TemporaryDirectory() as tmp:
            from test_platform_preflight import pinned_runtime
            runtime=pinned_runtime(Path(tmp)/'runtime')
            with patch.dict('os.environ',{'HERMES_HOME':'/wrong-profile','HERMES_PROFILE':'wrong'}), \
                 patch('wisp_test_core.executor.subprocess.Popen',side_effect=spawn), \
                 patch('wisp_test_core.executor.identity',return_value='1234'):
                launch_worker(Service(),{'objective_id':'x','approval_version':1,'provider':'hermes-openai-codex'},runtime,hermes_home=Path(tmp)/'selected-profile')
            self.assertEqual(seen[0]['HERMES_HOME'],str(Path(tmp)/'selected-profile'))
            self.assertNotIn('HERMES_PROFILE',seen[0])

    def test_zombie_worker_is_not_treated_as_running(self):
        from wisp_test_core.executor import identity
        child=subprocess.Popen([sys.executable,'-c','pass'])
        try:
            deadline=time.monotonic()+3
            while time.monotonic()<deadline:
                fields=Path(f'/proc/{child.pid}/stat').read_text().rsplit(')',1)[1].split()
                if fields[0]=='Z': break
                time.sleep(.01)
            self.assertEqual(fields[0],'Z')
            self.assertIsNone(identity(child.pid))
        finally: child.wait()

    def test_proposal_does_not_advertise_unsupported_check_runtimes(self):
        from wisp_test_core.workspace import commands
        for binary in ('pnpm','bun','pytest','bash'):
            with self.subTest(binary=binary),self.assertRaises(ValueError):
                commands([{'id':'check','argv':[binary,'test']}])

    def test_long_check_output_preserves_head_tail_and_actual_exit_status(self):
        from wisp_test_core.executor import execute_check
        script = "import sys; print('START_DIAGNOSTIC'); print('x'*40000); print('FINAL_FAILURE_SUMMARY'); sys.exit(1)"
        with patch('wisp_test_core.executor.check_argv',return_value=[sys.executable,'-c',script]):
            result = execute_check(Path('/tmp'), ['python3'], 5)
        self.assertEqual(result['exit_code'],1)
        self.assertEqual(result['code'],'CHECK_OUTPUT_TRUNCATED')
        self.assertIn('START_DIAGNOSTIC',result['stdout'])
        self.assertIn('FINAL_FAILURE_SUMMARY',result['stdout'])
        self.assertLessEqual(len(result['stdout'].encode()),16384)

    def test_excessive_check_output_still_hits_a_hard_limit(self):
        from wisp_test_core.executor import execute_check
        script = "import sys; sys.stdout.write('x'*2000000); sys.stdout.flush()"
        with patch('wisp_test_core.executor.check_argv',return_value=[sys.executable,'-c',script]):
            result = execute_check(Path('/tmp'), ['python3'], 5)
        self.assertEqual(result['exit_code'],125)
        self.assertEqual(result['code'],'CHECK_OUTPUT_LIMIT')
        self.assertLessEqual(len(result['stdout'].encode()),16384)


    def test_confirmed_provider_refusal_stops_with_a_settled_candidate(self):
        from wisp_test_core.executor import run_task
        Service = load_core()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo = root / 'repo'
            repo.mkdir()
            (repo / 'app.py').write_text('value = 1\n')
            worker = root / 'worker.py'
            worker.write_text(
                "import sys\nsys.stdin.readline()\n"
                "print('{\"kind\":\"model\",\"id\":\"request\",\"data\":{}}', flush=True)\n"
                "sys.stdin.readline()\n"
            )
            service = Service(root / 'state', launch=lambda task: None)
            for status in (400, 401, 403, 404, 422, 429):
                with self.subTest(status=status):
                    task = service.propose('chat', repo, {
                        'objective': 'Fixture', 'allowed_paths': ['app.py'],
                        'provider': 'hermes-openai-codex' if status == 429 else 'hermes-openai-api',
                        'model': 'fixture',
                    })
                    ident = task['objective_id']
                    service.approve('chat', ident, 1)
                    with patch('wisp_test_core.executor.require_support'):
                        run_task(service, ident, 1, {'bun': sys.executable, 'worker': str(worker), 'sdk': ''},
                                 transport=lambda request, timeout: {'status': status, 'body': 'private-error-fixture'})
                    task = service.store.load(ident)
                    self.assertEqual(task['status'], 'FAILED')
                    self.assertEqual(task['process_status'], 'PROCESS_TERMINATED')
                    self.assertEqual(task['error'], f'PROVIDER_REFUSED_{status}')
                    self.assertEqual([request['status'] for request in task['requests']], ['failed'])
                    self.assertNotIn('private-error-fixture', json.dumps(task))


if __name__ == '__main__': unittest.main()
