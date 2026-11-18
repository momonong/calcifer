import builtins
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from test_core import CORE, load_core


def load_installer():
    spec=importlib.util.spec_from_file_location('platform_test_installer',CORE.parents[1]/'install-core.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


def pinned_runtime(root):
    root=Path(root)
    result={'bun_version':'1.4.4','opencode_version':'2.1.4'}
    for key,relative,version in [('bun','node_modules/bun/bin/bun.exe','1.4.4'),('sdk','node_modules/@opencode/sdk/dist/index.js','2.1.4')]:
        path=root/relative;path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text('#!/bin/sh\necho 1.4.4\n' if key=='bun' else 'export {};\n')
        if key=='bun':path.chmod(0o700)
        (path.parent.parent/'package.json').write_text(json.dumps({'version':version}))
        result[key]=str(path)
    worker=root/'worker.mjs';worker.touch();result['worker']=str(worker)
    return result


class PlatformPreflightTests(unittest.TestCase):
    def setUp(self):
        self.Service=load_core();self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.home=self.root/'home';self.home.mkdir()
        (self.home/'preserved.txt').write_text('original login/config stand-in')

    def support(self):
        self.assertTrue((CORE/'platform_support.py').is_file(),'shared read-only platform contract required')
        return __import__('wisp_test_core.platform_support',fromlist=['assess'])

    def tree(self):
        return {str(p.relative_to(self.home)):(p.read_bytes() if p.is_file() else None) for p in self.home.rglob('*')}

    def test_windows_installer_import_does_not_require_fcntl(self):
        original=builtins.__import__
        def importer(name,*args,**kwargs):
            if name=='fcntl':raise ImportError('fcntl unavailable on Windows')
            return original(name,*args,**kwargs)
        with patch('builtins.__import__',side_effect=importer):
            try:installer=load_installer()
            except ImportError as error:self.fail(f'Windows cannot reach preflight: {error}')
        self.assertTrue(callable(installer.main))

    def test_unsupported_platform_rejected_before_prepare_or_install_changes(self):
        installer=load_installer();before=self.tree()
        with patch.object(sys,'platform','win32'),patch.object(installer.subprocess,'run') as run,patch.object(installer.subprocess,'check_output') as version:
            for operation in (lambda:installer.prepare_runtime(self.home),lambda:installer.install(self.home,self.root/'missing')):
                with self.assertRaisesRegex(ValueError,'EXECUTOR_PLATFORM_NOT_VERIFIED'):operation()
                self.assertEqual(before,self.tree())
        run.assert_not_called();version.assert_not_called()

    def test_missing_runtime_does_not_create_install_directories_or_lock(self):
        installer=load_installer();before=self.tree()
        with self.assertRaises((ValueError,OSError)):installer.install(self.home,self.root/'missing')
        self.assertEqual(before,self.tree())

    def test_missing_tools_node_or_bad_pinned_runtime_leave_installation_untouched(self):
        installer=load_installer();pinned_runtime(self.root/'runtime');before=self.tree()
        with patch.object(installer.support,'executable',return_value=False),patch.object(installer.subprocess,'run') as run:
            for operation in (lambda:installer.prepare_runtime(self.home),lambda:installer.install(self.home,self.root/'runtime')):
                with self.assertRaisesRegex(ValueError,'CHECK_ISOLATION_UNAVAILABLE'):operation()
                self.assertEqual(before,self.tree())
            run.assert_not_called()
        with patch.object(installer.shutil,'which',return_value=None):
            with self.assertRaisesRegex(ValueError,'NODE_NPM_REQUIRED'):installer.prepare_runtime(self.home)
            self.assertEqual(before,self.tree())
        (self.root/'runtime/node_modules/bun/package.json').write_text('{"version":"next"}')
        with patch.object(installer.subprocess,'check_output') as child:
            with self.assertRaisesRegex(ValueError,'PINNED_RUNTIME_REQUIRED'):installer.install(self.home,self.root/'runtime')
            self.assertEqual(before,self.tree());child.assert_not_called()

    def test_real_launcher_rechecks_runtime_and_isolation_before_spawning_owner(self):
        from wisp_test_core.executor import launch_worker,launch_verifier
        support=self.support();runtime=pinned_runtime(self.root/'runtime')
        self.assertTrue(support.assess(runtime)['ready'])
        with patch('wisp_test_core.executor._launch_owner') as owner:
            (Path(runtime['sdk']).parent.parent/'package.json').write_text('{"version":"next"}')
            with self.assertRaisesRegex(ValueError,'PINNED_RUNTIME_REQUIRED'):
                launch_worker(None,{'provider':'hermes-openai-codex'},runtime,hermes_home=self.home)
            with patch.object(support,'executable',return_value=False):
                with self.assertRaisesRegex(ValueError,'CHECK_ISOLATION_UNAVAILABLE'):
                    launch_verifier(None,{},hermes_home=self.home)
            owner.assert_not_called()

    def test_actual_runtime_keeps_readonly_history_but_blocks_missing_or_invalid_sdk_before_approval(self):
        from wisp_test_core import runtime
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        fake=types.ModuleType('hermes_constants');fake.get_hermes_home=lambda:self.home
        runtime_file=self.root/'runtime.json'
        repo=self.root/'repo';repo.mkdir();(repo/'app.py').write_text('x=1\n')
        with patch.dict(sys.modules,{'hermes_constants':fake}),patch.object(runtime,'RUNTIME_FILE',runtime_file):
            service=runtime.get_service()
            task=service.propose('chat',repo,{'objective':'fixture','read_paths':['app.py'],'allowed_paths':['app.py'],
                'allowed_commands':[{'id':'test','argv':['python3','-B','app.py']}],'provider':'hermes-openai-codex','model':'test'})
            ident=task['objective_id'];before=service.store.load(ident)
            spec=importlib.util.spec_from_file_location('preflight_api',CORE/'dashboard/plugin_api.py')
            api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api)
            api.get_service=runtime.get_service
            app=FastAPI();app.include_router(api.router);client=TestClient(app)
            for value,code in [(None,'EXECUTOR_RUNTIME_MISSING'),('{bad json','PINNED_RUNTIME_REQUIRED'),
                    (json.dumps({'bun_version':'wrong'}),'PINNED_RUNTIME_REQUIRED')]:
                if value is not None:runtime_file.write_text(value)
                view=client.get('/tasks',params={'session_id':'chat'})
                self.assertEqual(view.status_code,200,view.text)
                cap=view.json()['tasks'][0]['capabilities']
                self.assertFalse(cap['development']['ready']);self.assertTrue(cap['verification']['ready'])
                self.assertEqual(cap['development']['issues'][0]['code'],code)
                with patch('wisp_test_core.executor._launch_owner') as owner:
                    reply=client.post('/action',json={'session_id':'chat','task_id':ident,'version':1,'action':'approve'})
                self.assertEqual(reply.status_code,409,reply.text);self.assertIn(code,reply.text);owner.assert_not_called()
                self.assertEqual(before,service.store.load(ident));self.assertFalse(service.candidate(ident).exists())
            runtime_file.write_text(json.dumps(pinned_runtime(self.root/'valid-runtime')))
            self.assertTrue(runtime.get_service().snapshot('chat',ident)['capabilities']['development']['ready'])

    def test_capabilities_distinguish_platform_arch_isolation_and_model_runtime(self):
        support=self.support()
        for platform,machine,code in [('win32','AMD64','EXECUTOR_PLATFORM_NOT_VERIFIED'),('linux','aarch64','EXECUTOR_ARCH_NOT_VERIFIED')]:
            with patch.object(support.sys,'platform',platform),patch.object(support.platform,'machine',return_value=machine):
                result=support.assess()
            self.assertFalse(result['ready']);self.assertEqual(result['issues'][0]['code'],code)
        with patch.object(support,'executable',return_value=False):
            result=support.assess(require_runtime=False)
        self.assertEqual(result['issues'][0]['code'],'CHECK_ISOLATION_UNAVAILABLE')
        with patch.object(support,'executable',return_value=True):
            verify=support.assess(require_runtime=False);develop=support.assess(runtime=None)
        self.assertTrue(verify['ready']);self.assertFalse(develop['ready'])
        self.assertEqual(develop['issues'][0]['code'],'EXECUTOR_RUNTIME_MISSING')
        self.assertFalse(verify['kernel_isolation_verified'])

    def test_failed_preflight_preserves_proposal_revision_and_verification_receipts(self):
        support=self.support()
        repo=self.root/'repo';repo.mkdir();(repo/'app.py').write_text('x=1\n');launched=[]
        service=self.Service(self.root/'state',launch=lambda t:launched.append(t))
        task=service.propose('chat',repo,{'objective':'fixture','read_paths':['app.py'],'allowed_paths':['app.py'],
            'allowed_commands':[{'id':'test','argv':['python3','-B','app.py']}],'provider':'hermes-openai-codex','model':'test'})
        ident=task['objective_id'];before=service.store.load(ident)
        before_events=service.store.events(ident,'chat')
        with patch.object(support.sys,'platform','win32'):
            with self.assertRaisesRegex(ValueError,'EXECUTOR_PLATFORM_NOT_VERIFIED'):service.approve('chat',ident,1)
        self.assertEqual(before,service.store.load(ident));self.assertFalse(service.candidate(ident).exists());self.assertEqual(launched,[])
        self.assertEqual(before_events,service.store.events(ident,'chat'))
        service.approve('chat',ident,1);service.settle(ident,1,native_session='fixture',text='stopped',success=False)
        before=service.store.load(ident);service.verify_launch=lambda t:launched.append(t)
        token=service.preview_verify('chat',ident,1)['token'];count=len(launched)
        before_events=service.store.events(ident,'chat')
        with patch.object(support.sys,'platform','win32'):
            for operation in (lambda:service.revise('chat',ident,1,'fix'),lambda:service.verify('chat',ident,1,token)):
                with self.assertRaisesRegex(ValueError,'EXECUTOR_PLATFORM_NOT_VERIFIED'):operation()
                self.assertEqual(before,service.store.load(ident))
                self.assertEqual(before_events,service.store.events(ident,'chat'))
        self.assertEqual(len(launched),count)
