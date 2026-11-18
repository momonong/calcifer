"""Explicit, model-free verification of a stopped candidate; never retry UNKNOWN."""
import hashlib
import json
import time
import uuid

from . import workspace as ws
from .service import needs_reverification, require

MAX_SECONDS = 120


def eligible(task, version):
    from .executor import identity
    require(task['approval_version'] == version, 'VERSION_CONFLICT')
    stopped = task['status'] in ('FAILED', 'REVIEW', 'PROCESS_TERMINATED') and not task.get('completion')
    require((stopped or needs_reverification(task)) and
            task['process_status'] == 'PROCESS_TERMINATED', 'STATE_CONFLICT')
    require(not any(r['status'] in ('unknown', 'inflight', 'reserved') for r in task['requests']), 'REQUEST_UNSETTLED')
    worker = task.get('worker')
    require(not worker or identity(worker['pid']) != worker['start'], 'WORKER_STILL_RUNNING')
    require(task['allowed_commands'], 'CHECKS_REQUIRED')


def token_for(task, fingerprint):
    verification = task.get('verification') or {}
    value = [task['objective_id'], task['session_id'], task['approval_version'], fingerprint,
        task['allowed_commands'], verification.get('id'), verification.get('status')]
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()


def preview(service, session, ident, version):
    task = service.store.load(ident, session)
    eligible(task, version)
    _, files, fingerprint = service.candidate_state(task)
    return {'objective_id': ident, 'approval_version': version, 'files': files,
        'commands': task['allowed_commands'], 'max_seconds': MAX_SECONDS, 'model_requests': 0,
        'token': token_for(task, fingerprint)}


def begin(service, session, ident, version, token, actor):
    require(service.verify_launch is not None, 'VERIFIER_NOT_CONFIGURED')
    def start(task):
        eligible(task, version)
        service._actor(task, actor)
        after, files, fingerprint = service.candidate_state(task)
        require(token == token_for(task, fingerprint), 'PREVIEW_CHANGED')
        service.preflight('verification')
        now = time.time()
        if task.get('verification'):
            task.setdefault('verification_history', []).append(task['verification'])
        if task.get('completion'):
            task.setdefault('completion_history', []).append(task['completion'])
        task.update(status='VERIFYING', checks=[], worker=None, process_status='STARTING',
            completion=None, baseline_modes=service.source_modes(task),
            candidate_fingerprint=fingerprint, diff=ws.diff(task['baseline'], after), changes=files,
            verification={'id': uuid.uuid4().hex, 'actor': actor, 'status': 'RUNNING', 'approval_version': version,
                'started_at': now, 'deadline': now + MAX_SECONDS, 'fingerprint': fingerprint,
                'prior_status': task['status'], 'prior_error': task.get('error'), 'model_requests': 0})
    task = service.store.update(ident, start, session=session, version=version, event='verification-approved')
    try:
        service.verify_launch(task)
    except Exception:
        service.terminated(ident, version, confirmed=False)
        raise ValueError('VERIFIER_START_UNCONFIRMED') from None
    return service.snapshot(session, ident)


def run_verification(service, ident, version, *, execute=None):
    from .executor import execute_check
    execute = execute or execute_check
    task = service.store.load(ident)
    verification = task['verification']
    require(task['approval_version'] == version and task['status'] in ('VERIFYING', 'CANCEL_REQUESTED'), 'STATE_CONFLICT')
    fingerprint = verification['fingerprint']
    results, error = [], None
    def cancelled():
        current = service.store.load(ident)
        return (current['status'] != 'VERIFYING' or current['approval_version'] != version or
            current.get('verification', {}).get('id') != verification['id'] or time.time() >= verification['deadline'])
    try:
        for command in task['allowed_commands']:
            require(not cancelled(), 'CANCELLED')
            _, _, before = service.candidate_state(task)
            require(before == fingerprint, 'CANDIDATE_CHANGED')
            result = execute(service.candidate(ident), command['argv'], verification['deadline'] - time.time(), cancelled=cancelled)
            _, _, after = service.candidate_state(task)
            require(after == fingerprint, 'CANDIDATE_CHANGED')
            results.append({'id': command['id'], 'version': version, 'fingerprint': fingerprint,
                'exit_code': result.get('exit_code'), 'stdout': result.get('stdout', '')[:16000],
                'stderr': result.get('stderr', '')[:16000], 'code': result.get('code', '')})
    except Exception as exc:
        error = str(exc)[:200] if isinstance(exc, ValueError) else type(exc).__name__
    def finished(current):
        require(current['verification']['id'] == verification['id'], 'STATE_CONFLICT')
        require(current['status'] in ('VERIFYING', 'CANCEL_REQUESTED'), 'STATE_CONFLICT')
        was_cancelled = current['status'] == 'CANCEL_REQUESTED'
        # Final readback under the task lock protects the evidence boundary.
        try:
            _, _, final = service.candidate_state(current)
            unchanged = final == fingerprint
        except (ValueError, OSError):
            unchanged = False
        failure = error or (None if unchanged else 'CANDIDATE_CHANGED')
        passed = not failure and len(results) == len(current['allowed_commands']) and all(c['exit_code'] == 0 for c in results)
        current.update(status='PROCESS_TERMINATED' if was_cancelled else 'REVIEW' if passed else 'FAILED',
            process_status='PROCESS_TERMINATED', checks=results if unchanged else [])
        current['verification'].update(status='CANCELLED' if was_cancelled else 'PASSED' if passed else 'FAILED',
            finished_at=time.time(), error=failure)
    service.store.update(ident, finished, version=version, event='verification-finished')
    return service.snapshot(task['session_id'], ident)
