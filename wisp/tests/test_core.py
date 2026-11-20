import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
import subprocess


CORE = Path(__file__).resolve().parents[1] / 'extensions/core'


def load_core():
    spec = importlib.util.spec_from_file_location('wisp_test_core', CORE / '__init__.py', submodule_search_locations=[str(CORE)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    from wisp_test_core.service import Service
    return Service


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        (self.repo / 'app.py').write_text('answer = 1\n')
        (self.repo / 'test.py').write_text('assert True\n')
        self.started = []
        self.Service = load_core()
        self.service = self.Service(self.root / 'state', launch=lambda task: self.started.append(task['objective_id']))

    def tearDown(self):
        self.tmp.cleanup()

    def proposal(self, *, provider='hermes-openai-codex', **kwargs):
        return self.service.propose('chat-a', str(self.repo), {
            'objective': 'Make the answer two', 'read_paths': ['app.py', 'test.py'],
            'allowed_paths': ['app.py'],
            'allowed_commands': [{'id': 'test', 'argv': ['python3', '-B', 'test.py']}],
            'model': 'test-model', 'provider': provider,
        }, **kwargs)

    def test_delegated_work_keeps_authorization_and_does_not_claim_gui_acceptance(self):
        source = {'kind': 'delegated-operator', 'session_id': 'chat-a',
            'authorizing_thread_id': 'user-thread', 'authorization_reference': 'User authorized bounded overnight development.'}
        task = self.proposal(source=source); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1, actor='delegated-operator')
        request = self.service.request_check(ident, 1, 'test')
        self.service.decide_check('chat-a', ident, 1, request['id'], True, actor='delegated-operator')
        self.service.record_check(ident, 1, 'test', {'exit_code': 0})
        self.service.settle(ident, 1, native_session='synthetic-session', text='fixture', success=True)
        accepted = self.service.accept('chat-a', ident, 1, actor='delegated-operator')
        self.assertEqual(accepted['approval_actor'], 'delegated-operator')
        self.assertEqual(accepted['permissions'][0]['decision_actor'], 'delegated-operator')
        self.assertEqual(accepted['completion']['decision'], 'delegated-operator-accepted-candidate')
        self.assertEqual(self.Service(self.root / 'state').snapshot('chat-a', ident)['source'], source)

    def test_ordinary_model_proposal_cannot_supply_delegated_approval(self):
        task = self.proposal()
        with self.assertRaisesRegex(ValueError, 'DELEGATION_SOURCE_REQUIRED'):
            self.service.approve('chat-a', task['objective_id'], 1, actor='delegated-operator')
        self.assertEqual(self.service.snapshot('chat-a', task['objective_id'])['status'], 'PROPOSED')
        with self.assertRaisesRegex(ValueError, 'INVALID_SOURCE'):
            self.proposal(source={'kind':'delegated-operator','session_id':'other-chat'})

    def test_proposal_does_not_dispatch_or_copy_workspace(self):
        task = self.proposal()
        self.assertEqual(task['status'], 'PROPOSED')
        self.assertEqual(self.started, [])
        self.assertFalse(self.service.candidate(task['objective_id']).exists())
        self.assertEqual((self.repo / 'app.py').read_text(), 'answer = 1\n')

    def test_approval_is_versioned_one_shot_and_session_scoped(self):
        task = self.proposal(); ident = task['objective_id']
        with self.assertRaisesRegex(ValueError, 'SESSION_MISMATCH'):
            self.service.approve('chat-b', ident, 1)
        self.service.approve('chat-a', ident, 1)
        with self.assertRaisesRegex(ValueError, 'STATE_CONFLICT'):
            self.service.approve('chat-a', ident, 1)
        self.assertEqual(self.started, [ident])
        self.assertEqual(self.service.candidate(ident).joinpath('app.py').read_text(), 'answer = 1\n')

    def test_scope_and_secret_or_link_paths_are_refused(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        for path in ('../app.py', '.env', 'test.py', '/etc/passwd'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                self.service.tool(ident, 1, {'action': 'edit', 'path': path, 'content': 'bad'})
        self.service.candidate(ident).joinpath('app.py').unlink()
        self.service.candidate(ident).joinpath('app.py').symlink_to(self.repo / 'app.py')
        with self.assertRaisesRegex(ValueError, 'SYMLINK'):
            self.service.tool(ident, 1, {'action': 'edit', 'path': 'app.py', 'content': 'bad'})
        self.assertEqual((self.repo / 'app.py').read_text(), 'answer = 1\n')

    def test_token_computation_source_is_not_confused_with_credential_storage(self):
        from wisp_test_core.workspace import relative
        self.assertEqual(relative('src/token_preflight.py'), 'src/token_preflight.py')
        for name in ('token.json', 'token_cache.txt', 'token_state.sqlite', 'auth.json', 'tokens.json', 'token_cache.py/data.py'):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'SECRET_PATH_REJECTED'):
                relative(name)

    def test_exact_replace_is_scoped_unique_and_invalidates_test_evidence(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.record_check(ident, 1, 'test', {'exit_code':0})
        self.service.tool(ident, 1, {'action':'replace','path':'app.py','old_text':'answer = 1','new_text':'answer = 2'})
        self.assertEqual((self.service.candidate(ident)/'app.py').read_text(), 'answer = 2\n')
        self.assertEqual(self.service.snapshot('chat-a',ident)['checks'], [])
        for old in ('', 'missing'):
            with self.assertRaisesRegex(ValueError, 'REPLACEMENT_NOT_UNIQUE'):
                self.service.tool(ident,1,{'action':'replace','path':'app.py','old_text':old,'new_text':'bad'})
        with self.assertRaisesRegex(ValueError, 'WRITE_NOT_ALLOWED'):
            self.service.tool(ident,1,{'action':'replace','path':'test.py','old_text':'True','new_text':'False'})
        self.service.tool(ident,1,{'action':'edit','path':'app.py','content':'x x'})
        with self.assertRaisesRegex(ValueError, 'REPLACEMENT_NOT_UNIQUE'):
            self.service.tool(ident,1,{'action':'replace','path':'app.py','old_text':'x','new_text':'y'})
        self.assertEqual((self.service.candidate(ident)/'app.py').read_text(), 'x x')

    def test_completion_requires_current_check_evidence_and_acceptance_preserves_source(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.tool(ident, 1, {'action': 'edit', 'path': 'app.py', 'content': 'answer = 2\n'})
        self.service.settle(ident, 1, native_session='ses-one', text='done', success=True)
        with self.assertRaisesRegex(ValueError, 'CHECKS_REQUIRED'):
            self.service.accept('chat-a', ident, 1)
        # Evidence is recorded by the executor, never by a model tool or GUI payload.
        self.service.record_check(ident, 1, 'test', {'exit_code': 0, 'stdout': 'passed', 'stderr': ''})
        accepted = self.service.accept('chat-a', ident, 1)
        self.assertEqual(accepted['status'], 'ACCEPTED')
        self.assertIn('+answer = 2', accepted['diff'])
        self.assertEqual(accepted['completion']['source']['session_id'], 'chat-a')
        self.assertEqual((self.repo / 'app.py').read_text(), 'answer = 1\n')
        reopened = self.Service(self.root / 'state').snapshot('chat-a', ident)
        self.assertEqual(reopened['completion'], accepted['completion'])

    def test_multi_replace_prevalidates_all_changes_before_one_scoped_write(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.record_check(ident, 1, 'test', {'exit_code': 0})
        edits = [{'old_text':'answer = 1','new_text':'answer = 2'}, {'old_text':'answer = 2','new_text':'answer = 3'}]
        self.service.tool(ident, 1, {'action':'replace_many','path':'app.py','edits':edits})
        self.assertEqual((self.service.candidate(ident)/'app.py').read_text(), 'answer = 3\n')
        self.assertEqual((self.repo/'app.py').read_text(), 'answer = 1\n')
        self.assertFalse(self.service.store.load(ident)['checks'])
        for bad in ([], edits*9, [{'old_text':'answer = 3','new_text':'answer = 4'}, {'old_text':'missing','new_text':'bad'}]):
            with self.assertRaises(ValueError):
                self.service.tool(ident, 1, {'action':'replace_many','path':'app.py','edits':bad})
            self.assertEqual((self.service.candidate(ident)/'app.py').read_text(), 'answer = 3\n')
        with self.assertRaisesRegex(ValueError,'WRITE_NOT_ALLOWED'):
            self.service.tool(ident,1,{'action':'replace_many','path':'test.py','edits':[{'old_text':'True','new_text':'False'}]})

    def test_search_path_is_enforced_and_query_is_literal(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a',ident,1)
        self.assertEqual(self.service.tool(ident,1,{'action':'search','path':'app.py','query':'assert'})['matches'],[])
        self.assertEqual(self.service.tool(ident,1,{'action':'search','path':'test.py','query':'assert'})['matches'][0]['path'],'test.py')
        self.assertEqual(self.service.tool(ident,1,{'action':'search','query':'answer|assert'})['matches'],[])
        with self.assertRaisesRegex(ValueError,'READ_NOT_ALLOWED'):
            self.service.tool(ident,1,{'action':'search','path':'outside.py','query':'assert'})

    def test_remaining_budget_is_read_only_and_never_renews_an_allowance(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a',ident,1)
        before = self.service.store.load(ident)
        remaining = self.service.budget(ident,1)
        self.assertEqual(remaining['requests_remaining'],8)
        self.assertGreaterEqual(remaining['seconds_remaining'],0)
        self.assertEqual(self.service.store.load(ident),before)
        self.service.reserve_request(ident,1,'reserved')
        self.assertEqual(self.service.budget(ident,1)['requests_remaining'],7)
        with self.assertRaisesRegex(ValueError,'VERSION_CONFLICT'): self.service.budget(ident,2)

    def test_revision_invalidates_acceptance_and_preserves_budget_and_native_session(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.reserve_request(ident, 1, 'request-one')
        self.service.commit_request(ident, 1, 'request-one')
        self.service.finish_request(ident, 1, 'request-one', 'completed')
        self.service.record_check(ident, 1, 'test', {'exit_code': 0})
        self.service.settle(ident, 1, native_session='ses-one', text='done', success=True)
        revised = self.service.revise('chat-a', ident, 1, 'Use three instead')
        self.assertEqual(revised['approval_version'], 2)
        self.assertEqual(revised['requests_used'], 1)
        self.assertEqual(revised['native_session'], 'ses-one')
        self.assertEqual(revised['checks'], [])
        self.assertIsNone(revised['completion'])
        with self.assertRaises(ValueError):
            self.service.accept('chat-a', ident, 1)
        self.service.settle(ident, 2, native_session='ses-one', text='', success=False)
        with self.assertRaises(ValueError):
            self.service.accept('chat-a', ident, 2)

    def test_cancel_blocks_dispatch_and_unknown_survives_reopen(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.reserve_request(ident, 1, 'inflight')
        self.service.commit_request(ident, 1, 'inflight')
        self.service.cancel('chat-a', ident, 1)
        with self.assertRaisesRegex(ValueError, 'NOT_RUNNING'):
            self.service.reserve_request(ident, 1, 'later')
        self.service.terminated(ident, 1, confirmed=True)
        value = self.Service(self.root / 'state').snapshot('chat-a', ident)
        self.assertEqual(value['status'], 'TERMINATION_UNKNOWN')
        self.assertEqual(value['process_status'], 'PROCESS_TERMINATED')
        self.assertEqual(value['requests_used'], 1)
        with self.assertRaises(ValueError):
            self.service.revise('chat-a', ident, 1, 'retry')

    def test_check_approval_is_exact_and_invalidated_when_revision_changes(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        request = self.service.request_check(ident, 1, 'test')
        self.assertEqual(self.service.snapshot('chat-a', ident)['status'], 'WAITING_APPROVAL')
        with self.assertRaisesRegex(ValueError, 'SESSION_MISMATCH'):
            self.service.decide_check('chat-b', ident, 1, request['id'], True)
        self.service.decide_check('chat-a', ident, 1, request['id'], False)
        self.assertEqual(self.service.check_decision(ident, request['id']), 'denied')
        with self.assertRaisesRegex(ValueError, 'COMMAND_NOT_ALLOWED'):
            self.service.request_check(ident, 1, 'arbitrary-shell')

    def test_failed_or_changed_check_does_not_allow_accept(self):
        task = self.proposal(); ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.record_check(ident, 1, 'test', {'exit_code': 0})
        self.service.tool(ident, 1, {'action': 'edit', 'path': 'app.py', 'content': 'answer = 3\n'})
        self.service.settle(ident, 1, native_session='ses-one', text='done', success=True)
        with self.assertRaisesRegex(ValueError, 'CHECKS_REQUIRED'):
            self.service.accept('chat-a', ident, 1)

    def test_two_gui_windows_can_only_approve_once(self):
        task=self.proposal();ident=task['objective_id']
        def approve(_):
            try:self.Service(self.root/'state',launch=self.service.launch).approve('chat-a',ident,1);return 'approved'
            except ValueError as error:return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool: results=list(pool.map(approve,range(2)))
        self.assertCountEqual(results,['approved','STATE_CONFLICT'])
        self.assertEqual(self.started,[ident])

    def test_patch_preserves_new_empty_file_and_absent_final_newline(self):
        from wisp_test_core.workspace import diff
        target=self.root/'patch-target';target.mkdir()
        (target/'app.py').write_text('answer = 1')
        patch=diff({'app.py':'answer = 1','empty.txt':None},{'app.py':'answer = 2','empty.txt':''})
        result=subprocess.run(['git','apply','-'],cwd=target,input=patch,text=True,capture_output=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual((target/'app.py').read_text(),'answer = 2')
        self.assertTrue((target/'empty.txt').is_file())


if __name__ == '__main__':
    unittest.main()
