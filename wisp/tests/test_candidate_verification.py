"""A settled budget stop can be repaired and verified without another model."""
import copy
import os
from pathlib import Path
import tempfile
import time
import unittest

from test_core import load_core


class CandidateVerificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.repo = root / 'repo'
        self.repo.mkdir()
        (self.repo / 'app.py').write_text('value = 1\n')
        (self.repo / 'test.py').write_text('from app import value\nassert value == 2\n')
        self.Service = load_core()
        self.launched = []
        self.service = self.Service(root / 'state', launch=lambda t: None)
        self.service.verify_launch = lambda task: self.launched.append(task['objective_id'])
        self.task = self.service.propose('chat', str(self.repo), {
            'objective': 'Fix value', 'read_paths': ['app.py', 'test.py'], 'allowed_paths': ['app.py'],
            'allowed_commands': [{'id': 'test', 'argv': ['python3', '-B', 'test.py']}],
            'provider': 'hermes-openai-codex', 'model': 'fixture',
            'limits': {'max_requests': 1, 'max_seconds': 60}})
        self.ident = self.task['objective_id']
        self.service.approve('chat', self.ident, 1)
        self.service.reserve_request(self.ident, 1, 'one')
        self.service.commit_request(self.ident, 1, 'one')
        self.service.finish_request(self.ident, 1, 'one', 'completed')
        self.service.settle(self.ident, 1, native_session='native', text='budget stop', success=False, code='REQUEST_LIMIT')
        self.candidate = self.service.candidate(self.ident)
        (self.candidate / 'app.py').write_text('value = 2\n')

    def preview(self):
        return self.service.preview_verify('chat', self.ident, 1)

    def start(self):
        preview = self.preview()
        return self.service.verify('chat', self.ident, 1, preview['token'])

    def run_verifier(self, result=None, execute=None):
        from wisp_test_core.verification import run_verification
        return run_verification(self.service, self.ident, 1,
            execute=execute or (lambda *a, **k: result or {'exit_code': 0, 'stdout': 'passed', 'stderr': ''}))

    def test_preview_does_not_execute_and_bound_confirmation_starts_only_checks(self):
        before = copy.deepcopy(self.service.store.load(self.ident))
        preview = self.preview()
        self.assertEqual(self.launched, [])
        self.assertEqual(self.service.store.load(self.ident), before)
        self.assertEqual(preview['files'], ['app.py'])
        self.assertEqual(preview['commands'], before['allowed_commands'])
        self.assertEqual(preview['max_seconds'], 120)
        self.assertEqual(preview['model_requests'], 0)
        self.start()
        self.assertEqual(self.launched, [self.ident])
        self.assertEqual(self.service.store.load(self.ident)['status'], 'VERIFYING')
        with self.assertRaisesRegex(ValueError, 'NOT_RUNNING'):
            self.service.reserve_request(self.ident, 1, 'forbidden')
        self.run_verifier()
        finished = self.service.store.load(self.ident)
        self.assertEqual(finished['status'], 'REVIEW')
        self.assertEqual(finished['verification']['status'], 'PASSED')
        self.assertEqual(finished['requests'], before['requests'])
        self.assertEqual(finished['requests_used'], 1)
        self.assertEqual(finished['native_session'], 'native')
        self.assertEqual(finished['error'], 'REQUEST_LIMIT')
        accepted = self.service.accept('chat', self.ident, 1)
        self.assertEqual(accepted['status'], 'ACCEPTED')
        self.assertIn('+value = 2', accepted['diff'])
        self.assertEqual((self.repo / 'app.py').read_text(), 'value = 1\n')

    def test_failed_checks_do_not_enable_acceptance(self):
        self.start(); self.run_verifier({'exit_code': 1, 'stderr': 'failure'})
        value = self.service.store.load(self.ident)
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(value['verification']['status'], 'FAILED')
        with self.assertRaisesRegex(ValueError, 'STATE_CONFLICT'):
            self.service.accept('chat', self.ident, 1)

    def test_wrong_session_version_stale_candidate_and_replayed_confirmation_refused(self):
        preview = self.preview()
        for session, version, code in [('other', 1, 'SESSION_MISMATCH'), ('chat', 2, 'VERSION_CONFLICT')]:
            with self.assertRaisesRegex(ValueError, code):
                self.service.verify(session, self.ident, version, preview['token'])
        (self.candidate / 'app.py').write_text('value = 3\n')
        with self.assertRaisesRegex(ValueError, 'PREVIEW_CHANGED'):
            self.service.verify('chat', self.ident, 1, preview['token'])
        (self.candidate / 'app.py').write_text('value = 2\n')
        self.start(); self.run_verifier()
        with self.assertRaisesRegex(ValueError, 'PREVIEW_CHANGED'):
            self.service.verify('chat', self.ident, 1, preview['token'])

    def test_unknown_reserved_or_active_requests_never_enter_offline_recovery(self):
        original = self.service.store.load(self.ident)
        for state in ('TERMINATION_UNKNOWN', 'RUNNING', 'CANCEL_REQUESTED'):
            self.service.store.update(self.ident, lambda t: t.update(status=state))
            with self.assertRaises(ValueError): self.preview()
        self.service.store.update(self.ident, lambda t: t.update(original))
        for request_state in ('unknown', 'inflight', 'reserved'):
            self.service.store.update(self.ident, lambda t: t['requests'][0].update(status=request_state))
            with self.assertRaisesRegex(ValueError, 'REQUEST_UNSETTLED'): self.preview()

    def test_manual_repair_cannot_change_read_only_scope_or_add_hidden_inputs(self):
        for path, content in [('test.py', 'assert True\n'), ('extra.py', 'value = 3\n')]:
            old = (self.candidate / path).read_text() if (self.candidate / path).exists() else None
            (self.candidate / path).write_text(content)
            with self.assertRaisesRegex(ValueError, 'CANDIDATE_SCOPE_CHANGED'): self.preview()
            if old is None: (self.candidate / path).unlink()
            else: (self.candidate / path).write_text(old)

    def test_candidate_modes_and_empty_directories_are_checked(self):
        file = self.candidate / 'app.py'
        source_mode = (self.repo / 'app.py').stat().st_mode & 0o777
        self.assertEqual(file.stat().st_mode & 0o777, source_mode)
        file.chmod(source_mode ^ 0o100)
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_MODE_CHANGED'):
            self.preview()
        file.chmod(source_mode)
        (self.candidate / 'extra').mkdir()
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_SCOPE_CHANGED'):
            self.preview()

    def test_legacy_accepted_candidate_can_be_verified_again_without_losing_its_receipt(self):
        from wisp_test_core import workspace as ws

        old_completion = {'decision': 'previous-acceptance'}
        contents = ws.snapshot(self.candidate, ['app.py', 'test.py'])
        def old_receipt(task):
            del task['baseline_modes']
            task.update(status='ACCEPTED', completion=old_completion, candidate_fingerprint=ws.fingerprint(contents))
        self.service.store.update(self.ident, old_receipt)
        (self.candidate / 'app.py').chmod((self.repo / 'app.py').stat().st_mode ^ 0o100)
        self.assertTrue(self.service.snapshot('chat', self.ident)['verification_upgrade_required'])
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_MODE_CHANGED'):
            self.preview()
        (self.candidate / 'app.py').chmod((self.repo / 'app.py').stat().st_mode)
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_CHANGED'):
            self.service.preview_apply('chat', self.ident, 1)
        self.start()
        self.run_verifier()
        checked = self.service.store.load(self.ident)
        self.assertEqual(checked['completion_history'], [old_completion])
        self.assertEqual(checked['verification']['status'], 'PASSED')
        self.assertEqual(self.service.accept('chat', self.ident, 1)['status'], 'ACCEPTED')

    def test_bad_candidate_mode_is_rejected_before_revision_starts(self):
        self.service.store.update(self.ident, lambda t: t['limits'].update(max_requests=2))
        (self.candidate / 'app.py').chmod((self.repo / 'app.py').stat().st_mode ^ 0o100)
        before = self.service.store.load(self.ident)
        with self.assertRaisesRegex(ValueError, 'CANDIDATE_MODE_CHANGED'):
            self.service.revise('chat', self.ident, 1, 'Revision must not start')
        self.assertEqual(self.service.store.load(self.ident), before)

    def test_recording_a_check_rejects_candidate_changes_since_execution(self):
        self.service.store.update(self.ident, lambda t: t['limits'].update(max_requests=2))
        self.service.revise('chat', self.ident, 1, 'Revise')
        _, _, fingerprint = self.service.candidate_state(self.service.store.load(self.ident))
        (self.candidate / 'app.py').write_text('value = 3\n')
        with self.assertRaisesRegex(ValueError, 'CHECK_CHANGED_CANDIDATE'):
            self.service.record_check(self.ident, 2, 'test', {'exit_code': 0}, tested_fingerprint=fingerprint)
        self.assertEqual(self.service.store.load(self.ident)['checks'], [])

    def test_edit_during_verification_cannot_attest_a_different_candidate(self):
        self.start()
        def changed(*args, **kwargs):
            (self.candidate / 'app.py').write_text('value = 3\n')
            return {'exit_code': 0}
        self.run_verifier(execute=changed)
        value = self.service.store.load(self.ident)
        self.assertEqual(value['status'], 'FAILED')
        self.assertEqual(value['verification']['error'], 'CANDIDATE_CHANGED')
        self.assertFalse(value['checks'])

    def test_cancellation_preserves_budget_and_reopened_status(self):
        self.start()
        self.service.cancel('chat', self.ident, 1)
        calls = []
        self.run_verifier(execute=lambda *a, **kw: calls.append(a))
        reopened = self.Service(self.service.root).snapshot('chat', self.ident)
        self.assertEqual(calls, [])
        self.assertEqual(reopened['status'], 'PROCESS_TERMINATED')
        self.assertEqual(reopened['verification']['status'], 'CANCELLED')
        self.assertEqual(reopened['requests_used'], 1)

    def test_revision_keeps_old_verification_as_history_not_current_evidence(self):
        self.service.store.update(self.ident, lambda t: t['limits'].update(max_requests=2))
        self.start(); self.run_verifier()
        previous = copy.deepcopy(self.service.store.load(self.ident)['verification'])
        self.service.revise('chat', self.ident, 1, 'Change value to three')
        current = self.service.store.load(self.ident)
        self.assertIsNone(current.get('verification'))
        self.assertEqual(current['verification_history'][-1], previous)
        self.assertEqual(previous['approval_version'], 1)
        self.service.tool(self.ident, 2, {'action': 'edit', 'path': 'app.py', 'content': 'value = 3\n'})
        self.service.record_check(self.ident, 2, 'test', {'exit_code': 0})
        self.service.settle(self.ident, 2, native_session='native', text='v2 completed', success=True)
        accepted = self.service.accept('chat', self.ident, 2)
        self.assertEqual(accepted['completion']['execution_outcome'], 'executor-completed')
        self.assertIsNone(accepted['completion']['verification'])

    def test_cancel_before_verifier_registration_uses_fresh_start_time(self):
        from wisp_test_core.executor import reconcile
        self.service.store.update(self.ident, lambda t: t.update(started_at=time.time()-60))
        self.start()
        self.service.cancel('chat', self.ident, 1)
        task = reconcile(self.service, self.service.store.load(self.ident))
        self.assertEqual(task['status'], 'CANCEL_REQUESTED')
        self.run_verifier()
        self.assertEqual(self.service.store.load(self.ident)['verification']['status'], 'CANCELLED')

    def test_lost_verifier_does_not_keep_a_running_or_passing_badge(self):
        from wisp_test_core.executor import reconcile
        self.start()
        self.service.store.update(self.ident, lambda t: t['verification'].update(started_at=time.time()-60))
        task = reconcile(self.service, self.service.store.load(self.ident))
        self.assertEqual(task['status'], 'TERMINATION_UNKNOWN')
        self.assertEqual(task['verification']['status'], 'TERMINATION_UNKNOWN')

    @unittest.skipUnless(os.environ.get('WISP_OFFLINE_INTEGRATION') == '1', 'requires Linux check sandbox')
    def test_real_separate_verifier_executes_check_and_never_dispatches_model(self):
        from wisp_test_core.executor import launch_verifier
        self.service.verify_launch = lambda task: launch_verifier(self.service, task, hermes_home=self.repo)
        before = copy.deepcopy(self.service.store.load(self.ident)['requests'])
        self.start()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            task = self.service.store.load(self.ident)
            if task['status'] != 'VERIFYING': break
            time.sleep(.05)
        self.assertEqual(task['status'], 'REVIEW', task.get('verification'))
        self.assertEqual(task['verification']['status'], 'PASSED')
        self.assertEqual(task['requests'], before)
        self.assertEqual(task['checks'][0]['exit_code'], 0)


if __name__ == '__main__': unittest.main()
