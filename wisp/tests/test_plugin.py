import importlib.util
from pathlib import Path
import tempfile
import unittest

from test_core import load_core, CORE


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.Service = load_core()
        self.tmp=tempfile.TemporaryDirectory()
        root=Path(self.tmp.name); self.repo=root/'repo'; self.repo.mkdir()
        (self.repo/'app.py').write_text('x = 1\n')
        self.launched=[]
        self.service=self.Service(root/'state',launch=lambda t:self.launched.append(t['objective_id']))
        self.task=self.service.propose('chat-a',str(self.repo),{'objective':'Fix x','read_paths':['app.py'],'allowed_paths':['app.py'],
            'allowed_commands':[{'id':'test','argv':['python3','-B','app.py']}],'model':'test-model','provider':'hermes-openai-codex'})

    def tearDown(self): self.tmp.cleanup()

    def test_model_receives_only_propose_and_status_tools(self):
        import wisp_test_core
        class Context:
            tools=[]
            def register_tool(self,**kw): self.tools.append(kw)
            def register_hook(self,*a,**kw): pass
            def register_system_prompt_section(self,*a,**kw): pass
        ctx=Context(); wisp_test_core.register(ctx)
        self.assertEqual({t['name'] for t in ctx.tools},{'wisp_propose','wisp_status'})
        self.assertTrue(all('approve' not in t['schema']['parameters'].get('properties',{}) for t in ctx.tools))

    def test_rest_requires_matching_session_and_version_and_rejects_extra_fields(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        spec=importlib.util.spec_from_file_location('wisp_test_api',CORE/'dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
        api.get_service=lambda:self.service
        app=FastAPI(); app.include_router(api.router)
        client=TestClient(app)
        payload={'session_id':'chat-b','task_id':self.task['objective_id'],'version':1,'action':'approve'}
        self.assertEqual(client.post('/action',json=payload).status_code,409)
        payload['session_id']='chat-a'; payload['version']=2
        self.assertEqual(client.post('/action',json=payload).status_code,409)
        payload['version']=1; payload['max_requests']=100
        self.assertEqual(client.post('/action',json=payload).status_code,422)
        del payload['max_requests']
        self.assertEqual(client.post('/action',json=payload).status_code,200)
        self.assertEqual(client.post('/action',json=payload).status_code,409)
        self.assertEqual(len(self.launched),1)
        self.assertEqual(client.get('/tasks',params={'session_id':'chat-b'}).json()['tasks'],[])

    def test_rest_apply_preview_confirm_reopen_rollback_and_project_sharing(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        spec=importlib.util.spec_from_file_location('wisp_test_apply_api',CORE/'dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
        api.get_service=lambda:self.service
        app=FastAPI(); app.include_router(api.router)
        client=TestClient(app)
        ident=self.task['objective_id']
        payload={'session_id':'chat-a','task_id':ident,'version':1}
        self.service.approve('chat-a',ident,1)
        self.service.tool(ident,1,{'action':'edit','path':'app.py','content':'x = 2\n'})
        self.service.record_check(ident,1,'test',{'exit_code':0})
        self.service.settle(ident,1,native_session='fixture',text='fixture',success=True)
        self.service.accept('chat-a',ident,1)
        preview=client.post('/action',json={**payload,'action':'preview_apply'})
        self.assertEqual(preview.status_code,200,preview.text)
        self.assertTrue(preview.json()['ready'])
        self.assertEqual((self.repo/'app.py').read_text(),'x = 1\n')
        denied=client.post('/action',json={**payload,'action':'apply','preview_token':preview.json()['token'],'actor':'delegated-operator'})
        self.assertEqual(denied.status_code,422)
        applied=client.post('/action',json={**payload,'action':'apply','preview_token':preview.json()['token']})
        self.assertEqual(applied.status_code,200,applied.text)
        self.assertEqual(applied.json()['integration']['status'],'APPLIED')
        self.assertEqual((self.repo/'app.py').read_text(),'x = 2\n')
        self.service=self.Service(self.service.root)
        reopened=client.get(f'/tasks/{ident}',params={'session_id':'chat-a'})
        self.assertEqual(reopened.json()['integration']['id'],applied.json()['integration']['id'])
        rollback=client.post('/action',json={**payload,'action':'rollback','apply_id':applied.json()['integration']['id']})
        self.assertEqual(rollback.json()['integration']['status'],'ROLLED_BACK')
        self.assertEqual((self.repo/'app.py').read_text(),'x = 1\n')
        shared=client.post('/action',json={**payload,'action':'share_project','allow':True})
        self.assertEqual(shared.status_code,200,shared.text)
        self.assertTrue(shared.json()['sharing']['enabled'])

    def test_rest_offline_verification_does_not_accept_client_test_results(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from wisp_test_core.verification import run_verification
        spec=importlib.util.spec_from_file_location('wisp_test_verify_api',CORE/'dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(spec); spec.loader.exec_module(api)
        api.get_service=lambda:self.service
        app=FastAPI(); app.include_router(api.router)
        client=TestClient(app)
        ident=self.task['objective_id']
        payload={'session_id':'chat-a','task_id':ident,'version':1}
        self.service.approve('chat-a',ident,1)
        self.service.settle(ident,1,native_session='fixture',text='stopped',success=False,code='REQUEST_LIMIT')
        self.service.verify_launch=lambda task:None
        denied=client.post('/action',json={**payload,'action':'verify','exit_code':0})
        self.assertEqual(denied.status_code,422)
        preview=client.post('/action',json={**payload,'action':'preview_verify'})
        self.assertEqual(preview.status_code,200,preview.text)
        confirmed=client.post('/action',json={**payload,'action':'verify','preview_token':preview.json()['token']})
        self.assertEqual(confirmed.json()['status'],'VERIFYING')
        run_verification(self.service,ident,1,execute=lambda *a,**kw:{'exit_code':0})
        accepted=client.post('/action',json={**payload,'action':'accept'})
        self.assertEqual(accepted.json()['completion']['execution_outcome'],'operator-verified-candidate')


if __name__=='__main__': unittest.main()
