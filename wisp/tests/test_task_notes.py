"""Task-scoped records are context, never execution authorization."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from test_core import CORE, load_core


class TaskNotesTests(unittest.TestCase):
    def setUp(self):
        self.Service=load_core();self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.repo=self.root/'repo';self.repo.mkdir();(self.repo/'app.py').write_text('x=1\n')
        self.service=self.Service(self.root/'state',launch=lambda task:None)
        self.task=self.proposal('chat-a');self.ident=self.task['objective_id']

    def proposal(self,session,repo=None):
        return self.service.propose(session,repo or self.repo,{'objective':'fixture','read_paths':['app.py'],'allowed_paths':['app.py'],
            'allowed_commands':[{'id':'test','argv':['python3','-B','app.py']}],'provider':'hermes-openai-codex','model':'test'})

    def record(self,note_id='a'*32,kind='todo',text='Confirm the real reading flow'):
        return self.service.record_note('chat-a',self.ident,1,note_id,kind,text)

    def test_persistent_note_has_exact_source_but_does_not_change_task_or_authorize_work(self):
        before=self.service.store.load(self.ident)
        saved=self.record();note=saved['notes'][0]
        self.assertEqual(note['kind'],'todo');self.assertEqual(note['status'],'open');self.assertEqual(note['revision'],1)
        self.assertEqual(note['source'],{'objective_id':self.ident,'session_id':'chat-a','approval_version':1,'channel':'gui'})
        self.assertFalse(note['execution_authorized'])
        self.assertEqual(before,self.service.store.load(self.ident));self.assertFalse(self.service.candidate(self.ident).exists())
        self.assertEqual(self.Service(self.service.root).snapshot('chat-a',self.ident)['notes'],saved['notes'])

    def test_idempotent_record_and_conflicting_operation_id_never_duplicate(self):
        self.record();events=self.service.store.events(self.ident,'chat-a')
        self.record()
        self.assertEqual(len(self.service.snapshot('chat-a',self.ident)['notes']),1)
        self.assertEqual(events,self.service.store.events(self.ident,'chat-a'))
        with self.assertRaisesRegex(ValueError,'NOTE_ID_CONFLICT'):self.record(text='different')
        for kind,text in [('instruction','do work'),('todo',' '),('decision','x'*1001)]:
            with self.assertRaises(ValueError):self.record('b'*32,kind,text)
        for i in range(31):self.record(f'{i:032x}')
        with self.assertRaisesRegex(ValueError,'NOTE_LIMIT'):self.record('c'*32)
        self.assertEqual(len(self.service.snapshot('chat-a',self.ident)['notes']),32)

    def test_status_updates_are_versioned_and_unknown_task_is_not_resolved(self):
        self.service.store.update(self.ident,lambda t:t.update(status='TERMINATION_UNKNOWN',process_status='TERMINATION_UNKNOWN'))
        before=self.service.store.load(self.ident);self.record()
        result=self.service.update_note('chat-a',self.ident,1,'a'*32,1,'done')
        self.assertEqual(result['notes'][0]['status'],'done');self.assertEqual(result['notes'][0]['revision'],2)
        with self.assertRaisesRegex(ValueError,'NOTE_VERSION_CONFLICT'):
            self.service.update_note('chat-a',self.ident,1,'a'*32,1,'open')
        self.service.update_note('chat-a',self.ident,1,'a'*32,2,'open')
        self.record('b'*32,'decision','Keep the existing profile')
        self.service.update_note('chat-a',self.ident,1,'b'*32,1,'withdrawn')
        with self.assertRaisesRegex(ValueError,'INVALID_NOTE_STATUS'):
            self.service.update_note('chat-a',self.ident,1,'b'*32,2,'done')
        self.assertEqual(before,self.service.store.load(self.ident))
        self.assertEqual([n['text'] for n in self.service.snapshot('chat-a',self.ident)['notes']],
            ['Confirm the real reading flow','Keep the existing profile'])

    def test_session_task_version_and_actor_cannot_be_forged(self):
        self.record()
        for session,version,code in [('chat-b',1,'SESSION_MISMATCH'),('chat-a',2,'VERSION_CONFLICT')]:
            with self.assertRaisesRegex(ValueError,code):self.service.record_note(session,self.ident,version,'b'*32,'todo','fixture')
            with self.assertRaisesRegex(ValueError,code):self.service.update_note(session,self.ident,version,'a'*32,1,'done')
        with self.assertRaisesRegex(ValueError,'DELEGATION_SOURCE_REQUIRED'):
            self.service.record_note('chat-a',self.ident,1,'b'*32,'decision','fixture',actor='delegated-operator')
        self.assertEqual(len(self.service.snapshot('chat-a',self.ident)['notes']),1)

    def test_two_windows_record_once_and_only_one_status_revision_wins(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:self.record(),range(2)))
        self.assertTrue(all(len(result['notes'])==1 for result in results))
        def complete(_):
            try:self.service.update_note('chat-a',self.ident,1,'a'*32,1,'done');return 'saved'
            except ValueError as error:return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(complete,range(2)))
        self.assertCountEqual(results,['saved','NOTE_VERSION_CONFLICT'])
        self.assertEqual(self.service.snapshot('chat-a',self.ident)['notes'][0]['revision'],2)

    def test_shared_project_and_recall_include_only_scoped_active_notes_with_limits(self):
        import wisp_test_core
        for i in range(7):self.record(f'{i:032x}','todo',('記錄'+str(i))*200)
        self.service.update_note('chat-a',self.ident,1,f'{0:032x}',1,'done')
        hidden=self.proposal('other-chat')
        self.service.record_note('other-chat',hidden['objective_id'],1,'f'*32,'decision','PRIVATE_MARKER')
        self.assertNotIn('PRIVATE_MARKER',json.dumps(self.service.project_context('chat-a',self.repo)))
        self.service.set_project_sharing('chat-a',self.ident,1,True)
        result=self.service.project_context('new-chat',self.repo)
        self.assertIn('PRIVATE_MARKER',json.dumps(result))
        own=next(row for row in result['tasks'] if row['objective_id']==self.ident)
        self.assertEqual(len(own['notes']),4);self.assertTrue(own['notes_truncated'])
        self.assertEqual(own['note_counts']['open_todos'],6)
        self.assertTrue(all(len(n['text'])<=280 for n in own['notes']))
        with patch.object(wisp_test_core,'get_service',return_value=self.service),patch.object(wisp_test_core,'current_session',return_value='new-chat'),patch.object(wisp_test_core,'current_project',return_value=self.repo):
            recall=wisp_test_core.recall()['context'];self.assertIn('PRIVATE_MARKER',recall);self.assertLess(len(recall),10200)
        self.service.set_project_sharing('chat-a',self.ident,1,False)
        self.assertEqual(self.service.project_context('new-chat',self.repo)['tasks'],[])

    def test_long_notes_do_not_evict_all_shared_progress_from_recall(self):
        import wisp_test_core
        earlier=self.proposal('earlier-chat')
        self.service.record_note('earlier-chat',earlier['objective_id'],1,'e'*32,'decision','SHARED_NOTE_MARKER')
        self.service.set_project_sharing('chat-a',self.ident,1,True)
        for i in range(4):
            task=self.task if i==0 else self.proposal('chat-a')
            self.service.store.update(task['objective_id'],lambda t:t.update(objective='長'*8000))
            for j in range(4):self.service.record_note('chat-a',task['objective_id'],1,f'{j:032x}','todo','筆記'*500)
        other=self.root/'other';other.mkdir();(other/'app.py').write_text('x=1')
        hidden=self.proposal('other-chat',other)
        self.service.record_note('other-chat',hidden['objective_id'],1,'f'*32,'decision','HIDDEN_PROJECT_NOTE')
        with patch.object(wisp_test_core,'get_service',return_value=self.service),patch.object(wisp_test_core,'current_session',return_value='chat-a'),patch.object(wisp_test_core,'current_project',return_value=self.repo):
            text=wisp_test_core.recall()['context']
        self.assertLess(len(text),10200);self.assertIn('SHARED_NOTE_MARKER',text);self.assertNotIn('HIDDEN_PROJECT_NOTE',text)
        data=json.loads(text.split('\n',1)[1])
        for row in data['current_session']:
            self.assertLessEqual(len(row['notes']),2);self.assertTrue(row['notes_truncated'])
            self.assertTrue(all(len(note['text'])<=140 and note['text_truncated'] for note in row['notes']))

    def test_single_long_decision_explicitly_marks_text_omission_and_keeps_original(self):
        original='背景'*150+'尚未批准部署，須人工確認'
        self.record(kind='decision',text=original)
        row=self.service.project_context('chat-a',self.repo)['tasks'][0]
        self.assertTrue(row['notes_truncated']);self.assertTrue(row['notes'][0]['text_truncated'])
        self.assertLessEqual(len(row['notes'][0]['text']),280);self.assertTrue(row['notes'][0]['text'].endswith('…'))
        self.assertEqual(self.service.snapshot('chat-a',self.ident)['notes'][0]['text'],original)

    def test_gui_api_records_and_updates_notes_without_model_write_tool(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        import wisp_test_core
        spec=importlib.util.spec_from_file_location('task_notes_api',CORE/'dashboard/plugin_api.py')
        api=importlib.util.module_from_spec(spec);spec.loader.exec_module(api);api.get_service=lambda:self.service
        app=FastAPI();app.include_router(api.router);client=TestClient(app)
        payload={'session_id':'chat-a','task_id':self.ident,'version':1,'action':'record_note','note_id':'a'*32,
            'note_kind':'todo','note_text':'Needs user acceptance'}
        reply=client.post('/action',json=payload);self.assertEqual(reply.status_code,200,reply.text)
        reply=client.post('/action',json={'session_id':'chat-a','task_id':self.ident,'version':1,'action':'update_note',
            'note_id':'a'*32,'note_revision':1,'note_status':'done'})
        self.assertEqual(reply.status_code,200,reply.text);self.assertEqual(reply.json()['notes'][0]['status'],'done')
        self.assertEqual(client.post('/action',json={**payload,'actor':'delegated-operator'}).status_code,422)
        self.assertEqual(client.post('/action',json={**payload,'session_id':'wrong'}).status_code,409)
        tools=[]
        class Context:
            def register_tool(self,**kw):tools.append(kw['name'])
            def register_hook(self,*a):pass
            def register_system_prompt_section(self,*a):pass
        wisp_test_core.register(Context());self.assertEqual(tools,['wisp_propose','wisp_status'])
