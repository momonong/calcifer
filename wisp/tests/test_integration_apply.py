import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from test_core import load_core


class ApplyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        (self.repo / 'app.py').write_bytes(b'answer = 1\r\n')
        (self.repo / 'app.py').chmod(0o755)
        (self.repo / 'check.py').write_text('assert True\n')
        self.Service = load_core()
        self.service = self.Service(self.root / 'state', launch=lambda task: None)

    def accepted(self, *, new_file=True):
        paths = ['app.py'] + (['new/note.md'] if new_file else [])
        task = self.service.propose('chat-a', self.repo, {
            'objective': 'Improve the existing example',
            'read_paths': ['app.py', 'check.py'], 'allowed_paths': paths,
            'allowed_commands': [{'id': 'test', 'argv': ['python3', '-B', 'check.py']}],
            'provider': 'hermes-openai-codex', 'model': 'test-model',
        })
        ident = task['objective_id']
        self.service.approve('chat-a', ident, 1)
        self.service.tool(ident, 1, {'action': 'edit', 'path': 'app.py', 'content': 'answer = 2\r\n'})
        if new_file:
            self.service.tool(ident, 1, {'action': 'edit', 'path': 'new/note.md', 'content': 'verified\n'})
        self.service.record_check(ident, 1, 'test', {'exit_code': 0})
        self.service.settle(ident, 1, native_session='fixture', text='fixture', success=True)
        self.service.accept('chat-a', ident, 1)
        self.assertTrue(callable(getattr(self.service, 'preview_apply', None)), 'accepted candidates need a source-application preview')
        return ident

    def apply(self, ident):
        preview = self.service.preview_apply('chat-a', ident, 1)
        self.assertTrue(preview['ready'], preview)
        return self.service.apply('chat-a', ident, 1, preview['token'])

    def test_apply_and_reopen_and_rollback_preserve_bytes_permissions_and_unrelated_files(self):
        ident = self.accepted()
        (self.repo / 'personal.txt').write_text('keep my work')
        result = self.apply(ident)
        receipt = result['integration']
        self.assertEqual(receipt['status'], 'APPLIED')
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 2\r\n')
        self.assertEqual((self.repo / 'app.py').stat().st_mode & 0o777, 0o755)
        self.assertEqual((self.repo / 'new/note.md').read_text(), 'verified\n')
        self.assertEqual((self.repo / 'personal.txt').read_text(), 'keep my work')
        self.assertNotIn('baseline', result)
        reopened = self.Service(self.root / 'state')
        self.assertEqual(reopened.snapshot('chat-a', ident)['integration'], receipt)
        undone = reopened.rollback('chat-a', ident, 1, receipt['id'])
        self.assertEqual(undone['integration']['status'], 'ROLLED_BACK')
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 1\r\n')
        self.assertEqual((self.repo / 'app.py').stat().st_mode & 0o777, 0o755)
        self.assertFalse((self.repo / 'new/note.md').exists())
        self.assertEqual((self.repo / 'personal.txt').read_text(), 'keep my work')

    def test_changed_read_dependency_blocks_preview_without_touching_source(self):
        ident = self.accepted()
        (self.repo / 'check.py').write_text('assert False\n')
        preview = self.service.preview_apply('chat-a', ident, 1)
        self.assertFalse(preview['ready'])
        self.assertEqual(preview['conflicts'], ['check.py'])
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 1\r\n')

    def test_stale_preview_and_changed_candidate_are_rejected(self):
        ident = self.accepted()
        preview = self.service.preview_apply('chat-a', ident, 1)
        (self.repo / 'app.py').write_text('a newer human edit')
        with self.assertRaisesRegex(ValueError, 'SOURCE_CHANGED|PREVIEW_STALE'):
            self.service.apply('chat-a', ident, 1, preview['token'])
        self.assertEqual((self.repo / 'app.py').read_text(), 'a newer human edit')
        (self.repo / 'app.py').write_bytes(b'answer = 1\r\n')
        (self.service.candidate(ident) / 'app.py').write_text('unreviewed')
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_CHANGED'):
            self.service.preview_apply('chat-a', ident, 1)

    def test_preview_requires_accepted_task_and_correct_session_version(self):
        ident = self.accepted()
        for session, version, message in [('chat-b', 1, 'SESSION_MISMATCH'), ('chat-a', 2, 'VERSION_CONFLICT')]:
            with self.assertRaisesRegex(ValueError, message):
                self.service.preview_apply(session, ident, version)
        self.service.store.update(ident, lambda t: t.update(status='TERMINATION_UNKNOWN'))
        with self.assertRaisesRegex(ValueError, 'ACCEPTED_REQUIRED'):
            self.service.preview_apply('chat-a', ident, 1)

    def test_apply_preserves_permission_change_after_preview(self):
        ident = self.accepted()
        preview = self.service.preview_apply('chat-a', ident, 1)
        (self.repo / 'app.py').chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'PREVIEW_STALE'):
            self.service.apply('chat-a', ident, 1, preview['token'])
        self.assertEqual((self.repo / 'app.py').stat().st_mode & 0o777, 0o600)

    def test_second_write_failure_rolls_back_first_and_keeps_receipt(self):
        ident = self.accepted()
        from wisp_test_core import integration
        original = integration.replace_file
        def fail_second(root, name, text, mode):
            if name == 'new/note.md':
                raise OSError('synthetic disk failure')
            return original(root, name, text, mode)
        with patch.object(integration, 'replace_file', side_effect=fail_second):
            result = self.apply(ident)
        self.assertEqual(result['integration']['status'], 'ROLLED_BACK')
        self.assertEqual(result['integration']['error'], 'APPLY_WRITE_FAILED')
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 1\r\n')
        self.assertFalse((self.repo / 'new/note.md').exists())

    def test_crashed_apply_is_recoverable_after_reopen_without_model_request(self):
        ident = self.accepted()
        from wisp_test_core import integration
        original = integration.replace_file
        class Crash(BaseException):
            pass
        def crash_second(root, name, text, mode):
            if name == 'new/note.md':
                raise Crash()
            return original(root, name, text, mode)
        with patch.object(integration, 'replace_file', side_effect=crash_second), self.assertRaises(Crash):
            self.apply(ident)
        reopened = self.Service(self.root / 'state')
        receipt = reopened.snapshot('chat-a', ident)['integration']
        self.assertEqual(receipt['status'], 'APPLYING')
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 2\r\n')
        result = reopened.rollback('chat-a', ident, 1, receipt['id'])
        self.assertEqual(result['integration']['status'], 'ROLLED_BACK')
        self.assertEqual(result['requests_used'], 0)
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 1\r\n')

    def test_rollback_refuses_new_human_edits_and_retains_backups(self):
        ident = self.accepted()
        result = self.apply(ident)
        (self.repo / 'app.py').write_text('my later edit')
        result = self.service.rollback('chat-a', ident, 1, result['integration']['id'])
        self.assertEqual(result['integration']['status'], 'RECOVERY_REQUIRED')
        self.assertEqual(result['integration']['conflicts'], ['app.py'])
        self.assertEqual((self.repo / 'app.py').read_text(), 'my later edit')
        self.assertTrue((self.repo / 'new/note.md').exists())
        self.assertTrue(Path(result['integration']['backup']).is_dir())

    def test_symlink_or_hardlink_source_is_not_overwritten(self):
        ident = self.accepted()
        external = self.root / 'external.py'
        external.write_text('private')
        target = self.repo / 'app.py'
        for link in ('symlink', 'hardlink'):
            target.unlink()
            if link == 'symlink':
                target.symlink_to(external)
            else:
                os.link(external, target)
            with self.assertRaises(ValueError):
                self.service.preview_apply('chat-a', ident, 1)
            self.assertEqual(external.read_text(), 'private')

    def test_duplicate_apply_is_idempotent_and_does_not_overwrite_later_edits(self):
        ident = self.accepted()
        preview = self.service.preview_apply('chat-a', ident, 1)
        first = self.service.apply('chat-a', ident, 1, preview['token'])
        (self.repo / 'app.py').write_text('later edit')
        again = self.service.apply('chat-a', ident, 1, preview['token'])
        self.assertEqual(first['integration'], again['integration'])
        self.assertEqual((self.repo / 'app.py').read_text(), 'later edit')

    def test_rolled_back_operation_invalidates_its_old_apply_approval(self):
        ident = self.accepted()
        preview = self.service.preview_apply('chat-a', ident, 1)
        first = self.service.apply('chat-a', ident, 1, preview['token'])
        self.service.rollback('chat-a', ident, 1, first['integration']['id'])
        with self.assertRaisesRegex(ValueError, 'PREVIEW_STALE'):
            self.service.apply('chat-a', ident, 1, preview['token'])
        self.assertEqual((self.repo / 'app.py').read_bytes(), b'answer = 1\r\n')
        fresh = self.service.preview_apply('chat-a', ident, 1)
        self.assertNotEqual(preview['token'], fresh['token'])
        self.assertEqual(self.service.apply('chat-a', ident, 1, fresh['token'])['integration']['status'], 'APPLIED')

    def test_rollback_final_readback_rejects_file_recreated_by_editor(self):
        ident = self.accepted()
        applied = self.apply(ident)
        from wisp_test_core import integration
        original = integration.replace_file
        def editor_recreates_new_file(root, name, text, mode):
            result = original(root, name, text, mode)
            if name == 'app.py' and text == 'answer = 1\r\n':
                (self.repo / 'new/note.md').write_text('verified\n')
                (self.repo / 'new/note.md').chmod(0o644)
            return result
        with patch.object(integration, 'replace_file', side_effect=editor_recreates_new_file):
            result = self.service.rollback('chat-a', ident, 1, applied['integration']['id'])
        self.assertEqual(result['integration']['status'], 'RECOVERY_REQUIRED')
        self.assertIn('new/note.md', result['integration']['conflicts'])
        self.assertEqual((self.repo / 'new/note.md').read_text(), 'verified\n')

    def test_new_backup_and_source_directory_entries_are_synced(self):
        ident = self.accepted()
        from wisp_test_core import integration
        events = []
        mkdir, sync = os.mkdir, integration.sync_directory
        def record_mkdir(path, *args, **kwargs):
            result = mkdir(path, *args, **kwargs)
            events.append(('mkdir', str(Path(path))))
            return result
        def record_sync(path):
            events.append(('sync', str(Path(path))))
            return sync(path)
        with patch.object(os, 'mkdir', side_effect=record_mkdir), patch.object(integration, 'sync_directory', side_effect=record_sync):
            result = self.apply(ident)
        self.assertEqual(result['integration']['status'], 'APPLIED')
        backup = Path(result['integration']['backup'])
        for directory in (backup.parent, backup, self.repo / 'new'):
            position = events.index(('mkdir', str(directory)))
            self.assertIn(('sync', str(directory.parent)), events[position+1:], str(directory))
