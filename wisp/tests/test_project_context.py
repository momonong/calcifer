import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from test_core import load_core


class ProjectContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.other = self.root / 'other'
        for repo in (self.repo, self.other):
            repo.mkdir()
            (repo / 'app.py').write_text('x = 1\n')
        self.Service = load_core()
        self.service = self.Service(self.root / 'state', launch=lambda t: None)

    def proposal(self, session, repo=None):
        return self.service.propose(session, repo or self.repo, {'objective': 'A real task',
            'read_paths': ['app.py'], 'allowed_paths': ['app.py'],
            'allowed_commands': [{'id': 'test', 'argv': ['python3', '-B', 'app.py']}],
            'model': 'test-model', 'provider': 'hermes-openai-codex'})

    def context(self, session):
        self.assertTrue(callable(getattr(self.service, 'project_context', None)), 'projects need source-attributed continuation')
        return self.service.project_context(session, self.repo)

    def test_default_context_is_current_session_only(self):
        own = self.proposal('chat-a')
        self.proposal('chat-b')
        self.proposal('chat-a', self.other)
        result = self.context('chat-a')
        self.assertFalse(result['sharing']['enabled'])
        self.assertEqual([t['objective_id'] for t in result['tasks']], [own['objective_id']])
        self.assertEqual(self.context('brand-new-session')['tasks'], [])

    def test_explicit_sharing_survives_reopen_and_never_includes_other_project(self):
        task = self.proposal('chat-a')
        b = self.proposal('chat-b')
        self.proposal('chat-b', self.other)
        self.context('chat-a')
        result = self.service.set_project_sharing('chat-a', task['objective_id'], 1, True)
        self.assertTrue(result['sharing']['enabled'])
        self.assertEqual(result['sharing']['source']['session_id'], 'chat-a')
        reopened = self.Service(self.root / 'state')
        result = reopened.project_context('brand-new-session', self.repo)
        self.assertEqual({t['objective_id'] for t in result['tasks']}, {task['objective_id'], b['objective_id']})
        self.assertTrue(all(t['source']['session_id'] in ('chat-a', 'chat-b') for t in result['tasks']))

    def test_revoke_takes_effect_without_erasing_receipts(self):
        task = self.proposal('chat-a')
        self.proposal('chat-b')
        self.context('chat-a')
        self.service.set_project_sharing('chat-a', task['objective_id'], 1, True)
        self.service.set_project_sharing('chat-a', task['objective_id'], 1, False)
        self.assertEqual(self.context('brand-new-session')['tasks'], [])
        self.assertEqual(len(self.service.store.list('chat-b')), 1)

    def test_sharing_cannot_be_forged_with_wrong_session_or_version(self):
        task = self.proposal('chat-a')
        self.context('chat-a')
        for session, version, message in [('chat-b', 1, 'SESSION_MISMATCH'), ('chat-a', 2, 'VERSION_CONFLICT')]:
            with self.assertRaisesRegex(ValueError, message):
                self.service.set_project_sharing(session, task['objective_id'], version, True)
        with self.assertRaisesRegex(ValueError, 'INVALID_DECISION'):
            self.service.set_project_sharing('chat-a', task['objective_id'], 1, 'yes')

    def test_progress_summary_is_bounded_and_not_raw_logs_or_new_authorization(self):
        task = self.proposal('chat-a')
        self.service.store.update(task['objective_id'], lambda t: t.update(status='TERMINATION_UNKNOWN',
            diff='PRIVATE_DIFF_SENTINEL', summary='UNTRUSTED_TEXT', checks=[{'stdout': 'PRIVATE_LOG_SENTINEL'}]))
        result = self.context('chat-a')
        text = json.dumps(result)
        self.assertNotIn('PRIVATE_', text)
        self.assertNotIn('UNTRUSTED_TEXT', text)
        self.assertFalse(result['execution_authorized'])
        self.assertIn('不可重送', result['tasks'][0]['next_step'])
        self.assertEqual(result['tasks'][0]['source']['session_id'], 'chat-a')

    def test_hook_recalls_shared_project_in_new_session_without_dispatch(self):
        task = self.proposal('chat-a')
        self.context('chat-a')
        self.service.set_project_sharing('chat-a', task['objective_id'], 1, True)
        import wisp_test_core
        self.assertTrue(hasattr(wisp_test_core, 'current_project'), 'hook must use trusted runtime cwd')
        with patch.object(wisp_test_core, 'get_service', return_value=self.service), \
             patch.object(wisp_test_core, 'current_session', return_value='new-chat'), \
             patch.object(wisp_test_core, 'current_project', return_value=self.repo):
            recall = wisp_test_core.recall()
            self.assertIn(task['objective_id'], recall['context'])
            self.assertIn('不是新的執行授權', recall['context'])
            result = json.loads(wisp_test_core.status({'project': True}))
            self.assertEqual(result['project']['tasks'][0]['objective_id'], task['objective_id'])
        self.assertEqual(self.service.store.load(task['objective_id'])['status'], 'PROPOSED')

    def recall(self, session='chat-a', project=True):
        import wisp_test_core
        with patch.object(wisp_test_core, 'get_service', return_value=self.service), \
             patch.object(wisp_test_core, 'current_session', return_value=session), \
             patch.object(wisp_test_core, 'current_project', side_effect=(lambda:self.repo) if project else ValueError('NO_PROJECT')):
            result=wisp_test_core.recall()
        self.assertIsNotNone(result)
        return result['context'], json.loads(result['context'].split('\n',1)[1])

    def test_long_current_objectives_do_not_evict_all_shared_project_progress(self):
        shared=self.proposal('earlier-chat')
        self.service.set_project_sharing('earlier-chat',shared['objective_id'],1,True)
        for i in range(4):
            task=self.proposal('chat-a')
            self.service.store.update(task['objective_id'],lambda t:t.update(objective='長'*8000))
        text,data=self.recall()
        self.assertLessEqual(len(text),10200)
        self.assertIn(shared['objective_id'],[t['objective_id'] for t in data['project']['tasks']])
        self.assertFalse(data['project']['execution_authorized'])

    def test_current_summary_retains_applied_state_without_a_project(self):
        task=self.proposal('chat-a')
        self.service.store.update(task['objective_id'],lambda t:t.update(status='ACCEPTED',
            integration={'status':'APPLIED'},candidate_fingerprint='new',checks=[
                {'id':'test','version':1,'exit_code':0,'fingerprint':'old'}]))
        _,data=self.recall(project=False)
        row=data['current_session'][0]
        self.assertEqual(row['integration_status'],'APPLIED')
        self.assertIn('已套回',row['next_step'])
        self.assertEqual(row['tests'],{'passed':0,'required':1})

    def test_recall_budget_bounds_sources_and_files_without_erasing_durable_receipts(self):
        tasks=[]
        for i in range(4):
            task=self.proposal('chat-a');tasks.append(task)
            source={'kind':'delegated-operator','session_id':'chat-a','authorizing_thread_id':'t'*2000,
                'authorization_reference':'FULL_AUTH_SENTINEL'+'字'*1980}
            self.service.store.update(task['objective_id'],lambda t:t.update(source=source,objective='長'*8000,
                changes=['folder/'+str(i)+'字'*400 for i in range(64)]))
        self.service.set_project_sharing('chat-a',tasks[0]['objective_id'],1,True,actor='delegated-operator')
        text,data=self.recall()
        self.assertLessEqual(len(text),10200)
        self.assertNotIn('FULL_AUTH_SENTINEL',text)
        self.assertTrue(data['current_session'])
        self.assertEqual(data['current_session'][0]['source']['session_id'],'chat-a')
        self.assertEqual(self.service.store.load(task['objective_id'])['source'],source)

    def test_shared_progress_reconciles_gone_workers_without_dispatch_or_hidden_task_writes(self):
        shared=self.proposal('earlier-chat')
        hidden=self.proposal('earlier-chat',self.other)
        self.service.set_project_sharing('earlier-chat',shared['objective_id'],1,True)
        for task in [shared,hidden]:
            self.service.store.update(task['objective_id'],lambda t:t.update(status='RUNNING',
                process_status='RUNNING',started_at=time.time()-60,worker=None))
        launched=[];self.service.launch=lambda t:launched.append(t)
        result=self.context('new-chat')
        self.assertEqual(result['tasks'][0]['status'],'TERMINATION_UNKNOWN')
        self.assertIn('不可重送',result['tasks'][0]['next_step'])
        self.assertEqual(self.service.store.load(hidden['objective_id'])['status'],'RUNNING')
        self.assertEqual(launched,[])
        before=self.service.store.load(shared['objective_id'])
        self.context('new-chat')
        self.assertEqual(self.service.store.load(shared['objective_id']),before)

    def test_stale_owner_observation_cannot_terminate_new_verification_or_settled_task(self):
        from wisp_test_core.executor import reconcile
        for settled in [False,True]:
            task=self.proposal('chat-a');ident=task['objective_id']
            stale=self.service.store.update(ident,lambda t:t.update(status='RUNNING',process_status='RUNNING',started_at=time.time()-60))
            self.service.store.update(ident,lambda t:t.update(status='ACCEPTED' if settled else 'VERIFYING',
                verification={'status':'RUNNING','started_at':time.time()}))
            expected=self.service.store.load(ident)
            result=reconcile(self.service,stale)
            self.assertEqual(result['status'],expected['status'])
            self.assertEqual(self.service.store.load(ident),expected)

    def test_progress_check_count_requires_current_version_and_candidate(self):
        task=self.proposal('chat-a')
        self.service.store.update(task['objective_id'],lambda t:t.update(candidate_fingerprint='new',checks=[
            {'id':'test','version':0,'exit_code':0,'fingerprint':'new'},
            {'id':'test','version':1,'exit_code':0,'fingerprint':'old'},
            {'id':'unrelated','version':1,'exit_code':0,'fingerprint':'new'}]))
        self.assertEqual(self.context('chat-a')['tasks'][0]['tests'],{'passed':0,'required':1})
