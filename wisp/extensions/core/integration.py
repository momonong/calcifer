"""Explicit, journaled source application; never called by the model tools.

The repo lock serializes Wisp applications, not unrelated editors. A multi-file
write is not a filesystem transaction: backups precede writes and interruption
is visible until the user requests recovery. New human edits are never forced.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import uuid

from . import workspace as ws


def require(value, code):
    if not value:
        raise ValueError(code)


def private_directory(path, *, mode=0o700):
    path = Path(path).absolute()
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'SYMLINK_REJECTED')
    missing = []
    current = path
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=mode, exist_ok=True)
        require(not directory.is_symlink() and directory.is_dir(), 'SYMLINK_REJECTED')
        # Sync the parent entry as well as later file contents. Otherwise a
        # durable receipt could outlive its newly created backup directory.
        sync_directory(directory.parent)
    require(path.is_dir(), 'DIRECTORY_REQUIRED')
    return path


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextmanager
def repo_lock(root, repo):
    locks = private_directory(Path(root) / 'integration-locks')
    name = hashlib.sha256(str(repo).encode()).hexdigest()
    fd = os.open(locks / name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('APPLY_IN_PROGRESS') from None
        yield
    finally:
        os.close(fd)


def validate_candidate(service, task, version):
    require(task['approval_version'] == version, 'VERSION_CONFLICT')
    require(task['status'] == 'ACCEPTED', 'ACCEPTED_REQUIRED')
    require(not any(r['status'] in ('reserved', 'inflight', 'unknown') for r in task['requests']), 'REQUEST_UNSETTLED')
    after, changes, fingerprint = service.candidate_state(task)
    require(fingerprint == task.get('candidate_fingerprint'), 'CANDIDATE_CHANGED')
    require(task['allowed_commands'] and all(any(c['id'] == cmd['id'] and c['version'] == version
        and c['exit_code'] == 0 and c['fingerprint'] == fingerprint for c in task['checks'])
        for cmd in task['allowed_commands']), 'CHECKS_REQUIRED')
    require(changes, 'NO_ALLOWED_CHANGES')
    return after, changes


def preview(service, session, ident, version):
    task = service.store.load(ident, session)
    after, changes = validate_candidate(service, task, version)
    current = ws.snapshot(task['repo'], list(task['baseline']))
    current_modes = ws.file_modes(task['repo'], current)
    expected_modes = service.source_modes(task)
    conflicts = [name for name in current if current[name] != task['baseline'][name]
                 or current_modes[name] != expected_modes[name]]
    integration = task.get('integration') or {}
    prior = integration.get('status')
    token = ws.fingerprint({'source': current, 'modes': current_modes,
        'candidate': after, 'version': version, 'task': ident,
        'integration_generation': integration.get('id'), 'integration_status': prior})
    return {'objective_id': ident, 'approval_version': version, 'repo': task['repo'],
        'files': changes, 'conflicts': conflicts, 'ready': not conflicts and prior in (None, 'ROLLED_BACK'),
        'token': token, 'integration_status': prior, 'source_unchanged': not conflicts}


def replace_file(root, name, text, mode):
    """One durable replacement, preserving the source file's ordinary mode."""
    target = ws.file_path(root, name, absent=True)
    private_directory(target.parent, mode=0o755)
    target = ws.file_path(root, name, absent=True)
    fd, temporary = tempfile.mkstemp(prefix='.wisp-apply-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as stream:
            stream.write(text)
            stream.flush()
            os.fchmod(stream.fileno(), mode & 0o777)
            os.fsync(stream.fileno())
        ws.file_path(root, name, absent=True)
        os.replace(temporary, target)
        sync_directory(target.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_manifest(directory, data):
    raw = json.dumps(data, ensure_ascii=False, sort_keys=True).encode()
    with os.fdopen(os.open(directory / 'manifest.json', os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(directory)
    return hashlib.sha256(raw).hexdigest()


def read_manifest(service, task):
    receipt = task['integration']
    directory = service.root / 'integrations' / receipt['id']
    require(str(directory) == receipt['backup'], 'BACKUP_PATH_CONFLICT')
    require(not any(p.is_symlink() for p in (directory, *directory.parents)), 'SYMLINK_REJECTED')
    path = directory / 'manifest.json'
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        raw = stream.read(ws.MAX_TOTAL * 12 + 65536)
    require(hashlib.sha256(raw).hexdigest() == receipt['manifest_sha256'], 'BACKUP_CHANGED')
    value = json.loads(raw)
    require(value['task_id'] == task['objective_id'] and value['repo'] == task['repo'], 'BACKUP_TASK_CONFLICT')
    return value


def current_file(repo, name):
    value = ws.snapshot(repo, [name])[name]
    mode = stat.S_IMODE(ws.file_path(repo, name).stat().st_mode) if value is not None else None
    return value, mode


def recovery_conflicts(manifest, *, restored=False):
    conflicts = []
    for name, item in manifest['files'].items():
        try:
            current = current_file(manifest['repo'], name)
            permitted = [(item['before'], item['before_mode'])]
            if not restored:
                permitted.append((item['after'], item['after_mode']))
            if current not in permitted:
                conflicts.append(name)
        except (OSError, ValueError):
            conflicts.append(name)
    return conflicts


def restore_files(manifest):
    conflicts = recovery_conflicts(manifest)
    if conflicts:
        return conflicts
    for name, item in reversed(list(manifest['files'].items())):
        try:
            current = current_file(manifest['repo'], name)
            if current == (item['before'], item['before_mode']):
                continue
            if current != (item['after'], item['after_mode']):
                conflicts.append(name)
                break
            if item['before'] is None:
                path = ws.file_path(manifest['repo'], name)
                path.unlink()
                sync_directory(path.parent)
            else:
                replace_file(manifest['repo'], name, item['before'], item['before_mode'])
        except (OSError, ValueError):
            conflicts.append(name)
            break
    return sorted(set(conflicts + recovery_conflicts(manifest, restored=True)))


def finish(service, task, state, *, conflicts=None, error=None, actor=None):
    def update(t):
        receipt = t['integration']
        receipt.update(status=state, finished_at=time.time(), conflicts=conflicts or [])
        if error:
            receipt['error'] = error
        if actor:
            receipt['recovery_actor'] = actor
    service.store.update(task['objective_id'], update, version=task['approval_version'], event='integration-' + state.lower())


def apply(service, session, ident, version, token, actor):
    initial = service.store.load(ident, session)
    require(initial['approval_version'] == version, 'VERSION_CONFLICT')
    service._actor(initial, actor)
    with repo_lock(service.root, initial['repo']):
        task = service.store.load(ident, session)
        prior = task.get('integration') or {}
        if prior.get('status') == 'APPLIED':
            require(token == prior['preview_token'], 'PREVIEW_STALE')
            return service.snapshot(session, ident)
        plan = preview(service, session, ident, version)
        require(isinstance(token, str) and token == plan['token'], 'PREVIEW_STALE')
        require(not plan['conflicts'], 'SOURCE_CHANGED')
        require(plan['ready'], 'INTEGRATION_STATE_CONFLICT')
        after, changes = validate_candidate(service, task, version)
        before_modes = service.source_modes(task)
        directory = private_directory(service.root / 'integrations' / uuid.uuid4().hex)
        manifest = {'task_id': ident, 'repo': task['repo'], 'files': {
            name: {'before': task['baseline'][name], 'before_mode': before_modes[name],
                'after': after[name], 'after_mode': ws.output_mode(before_modes[name])}
            for name in changes}}
        digest = write_manifest(directory, manifest)
        def start(t):
            require(t['status'] == 'ACCEPTED' and (t.get('integration') or {}).get('status') in (None, 'ROLLED_BACK'), 'INTEGRATION_STATE_CONFLICT')
            t['integration'] = {'id': directory.name, 'status': 'APPLYING', 'actor': actor,
                'files': changes, 'backup': str(directory), 'manifest_sha256': digest,
                'preview_token': token, 'started_at': time.time(), 'conflicts': [],
                'source': {**t['source'], 'objective_id': ident, 'approval_version': version}}
        service.store.update(ident, start, session=session, version=version, event='integration-started')
        task = service.store.load(ident, session)
        try:
            for name, item in manifest['files'].items():
                require(current_file(task['repo'], name) == (item['before'], item['before_mode']), 'SOURCE_CHANGED')
                replace_file(task['repo'], name, item['after'], item['after_mode'])
            require(ws.snapshot(task['repo'], list(task['baseline'])) == after, 'SOURCE_VERIFY_FAILED')
            require(all(current_file(task['repo'], name) == (item['after'], item['after_mode'])
                        for name, item in manifest['files'].items()), 'SOURCE_VERIFY_FAILED')
        except (OSError, ValueError):
            conflicts = restore_files(manifest)
            finish(service, task, 'RECOVERY_REQUIRED' if conflicts else 'ROLLED_BACK',
                conflicts=conflicts, error='APPLY_WRITE_FAILED')
        else:
            finish(service, task, 'APPLIED')
        return service.snapshot(session, ident)


def rollback(service, session, ident, version, apply_id, actor):
    task = service.store.load(ident, session)
    require(task['approval_version'] == version, 'VERSION_CONFLICT')
    service._actor(task, actor)
    with repo_lock(service.root, task['repo']):
        task = service.store.load(ident, session)
        receipt = task.get('integration') or {}
        require(receipt.get('id') == apply_id, 'APPLY_ID_CONFLICT')
        if receipt.get('status') == 'ROLLED_BACK':
            return service.snapshot(session, ident)
        require(receipt.get('status') in ('APPLIED', 'APPLYING', 'ROLLING_BACK', 'RECOVERY_REQUIRED'), 'INTEGRATION_STATE_CONFLICT')
        manifest = read_manifest(service, task)
        service.store.update(ident, lambda t: t['integration'].update(status='ROLLING_BACK'),
            session=session, version=version, event='integration-rollback-started')
        conflicts = restore_files(manifest)
        finish(service, task, 'RECOVERY_REQUIRED' if conflicts else 'ROLLED_BACK', conflicts=conflicts, actor=actor)
        return service.snapshot(session, ident)
