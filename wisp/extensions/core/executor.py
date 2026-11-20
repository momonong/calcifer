"""Bounded child execution, precise check approvals and host-owned inference."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time

from .provider import MAX_WIRE, OpenAIAPITransport, create_transport, read_openai_api_key, supports_provider
from .service import ACTIVE, Service, require
from .platform_support import require_support


def check_argv(candidate, argv, seconds):
    require_support(require_runtime=False)
    args = ['/usr/bin/timeout', '--signal=TERM', '--kill-after=1s', f'{max(1, min(seconds, 120))}s',
        '/usr/bin/unshare', '--user', '--map-root-user', '--net', '--fork', '--kill-child=KILL', '/usr/bin/bwrap',
        '--unshare-user', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
        '--disable-userns', '--assert-userns-disabled', '--clearenv', '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--symlink', 'usr/bin', '/bin',
        '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/runtime',
        '--ro-bind', str(candidate), '/workspace', '--chdir', '/workspace',
        '--setenv', 'PATH', '/runtime:/usr/bin:/bin', '--setenv', 'PYTHONDONTWRITEBYTECODE', '1',
        '--setenv', 'npm_config_cache', '/tmp/npm-cache', '--setenv', 'npm_config_update_notifier', 'false']
    command = list(argv)
    if command[0] in ('node', 'npm'):
        node = shutil.which('node')
        require(node is not None, 'CHECK_EXECUTABLE_MISSING')
        args += ['--ro-bind', str(Path(node).resolve()), '/runtime/node']
        if command[0] == 'npm':
            npm = shutil.which('npm')
            require(npm is not None, 'CHECK_EXECUTABLE_MISSING')
            npm_root = Path(npm).resolve().parent.parent
            require((npm_root/'bin/npm-cli.js').is_file(), 'CHECK_NPM_LAYOUT_UNSUPPORTED')
            args += ['--ro-bind', str(npm_root), '/runtime/npm']
            command = ['node', '/runtime/npm/bin/npm-cli.js', *command[1:]]
    elif command[0] == 'python':
        command[0] = 'python3'
    elif command[0] != 'python3':
        raise ValueError('CHECK_EXECUTABLE_NOT_YET_SUPPORTED')
    return [*args, '--remount-ro', '/', '--', *command]


def identity(pid):
    try:
        # Linux proc field 22 (after the command, which may contain spaces).
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] in ('Z', 'X') else fields[19]
    except (OSError, IndexError):
        return None


def terminate_process(process):
    if process is None or process.poll() is not None: return
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL); process.wait(timeout=2)
    except ProcessLookupError:
        pass


def execute_check(candidate, argv, seconds, *, cancelled=lambda: False, spawn=None):
    """Shared deterministic check runner: read-only workspace, bounded time/output."""
    require(not cancelled(), 'CANCELLED')
    args = check_argv(candidate, argv, seconds)
    if spawn is None:
        spawn = lambda value: subprocess.Popen(value, env={'PATH':'/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    process = spawn(args)
    output = [bytearray(), bytearray()]
    heads = [bytearray(), bytearray()]
    sizes = [0, 0]
    marker = b'\n... Wisp output truncated; final output follows ...\n'
    capture, head_size, hard_limit = 16000, 4000, 1024 * 1024
    tail_size = capture - head_size - len(marker)
    overflow = threading.Event()
    def drain(stream, index):
        while block := stream.read(4096):
            sizes[index] += len(block)
            heads[index].extend(block[:max(0, head_size-len(heads[index]))])
            output[index].extend(block)
            if len(output[index]) > capture:
                del output[index][:-capture]
            if sizes[index] > hard_limit:
                overflow.set(); terminate_process(process); return
    readers = [threading.Thread(target=drain, args=(process.stdout, 0)), threading.Thread(target=drain, args=(process.stderr, 1))]
    try:
        for reader in readers: reader.start()
        while process.poll() is None:
            require(not cancelled(), 'CANCELLED')
            try: process.wait(timeout=.1)
            except subprocess.TimeoutExpired: pass
        for reader in readers: reader.join(timeout=2)
        require(not cancelled(), 'CANCELLED')
        rendered = [(bytes(heads[i]) + marker + bytes(output[i][-tail_size:]) if sizes[i] > capture else bytes(output[i])).decode('utf-8', 'replace') for i in range(2)]
        return {'exit_code': 125 if overflow.is_set() else process.returncode,
            'code': 'CHECK_OUTPUT_LIMIT' if overflow.is_set() else 'CHECK_OUTPUT_TRUNCATED' if any(n > capture for n in sizes) else '',
            'stdout': rendered[0], 'stderr': rendered[1]}
    finally:
        terminate_process(process)
        for reader in readers: reader.join(timeout=2)
        process.stdout.close(); process.stderr.close()


def reconcile(service, task):
    def abandoned(current):
        if current['status'] not in ACTIVE | {'VERIFYING', 'CANCEL_REQUESTED'}:
            return False
        owner = current.get('worker')
        verification = current.get('verification') or {}
        started = verification['started_at'] if verification.get('status') == 'RUNNING' else current['started_at']
        return (owner and identity(owner['pid']) != owner['start']) or (not owner and time.time() - started > 10)

    if abandoned(task):
        # No killing an old PID and no redispatch. An interrupted owner cannot
        # attest either remote inference or native session settlement.
        try:
            return service.terminated(task['objective_id'], task['approval_version'], confirmed=False, guard=abandoned)
        except ValueError as error:
            if str(error) not in ('VERSION_CONFLICT', 'TERMINATION_OBSERVATION_STALE'):
                raise
            return service.store.load(task['objective_id'])
    return task


def launch_worker(service, task, runtime, *, hermes_home):
    require(supports_provider(task.get('provider')), 'PROVIDER_NOT_AVAILABLE')
    require_support(runtime)
    if task['provider'] == OpenAIAPITransport.provider_id:
        read_openai_api_key(hermes_home)
    _launch_owner(service, task, runtime, hermes_home=hermes_home)


def launch_verifier(service, task, *, hermes_home):
    require_support(require_runtime=False)
    _launch_owner(service, task, {'mode': 'verify'}, hermes_home=hermes_home)


def _launch_owner(service, task, runtime, *, hermes_home):
    runner = Path(__file__).with_name('runner.py')
    env = {key: os.environ[key] for key in ('PATH','PYTHONPATH','SSL_CERT_FILE','SSL_CERT_DIR','LANG') if key in os.environ}
    # The GUI scopes profiles with contextvars, not process environment. Preserve
    # that trusted selection explicitly when crossing a process boundary.
    env['HERMES_HOME'] = str(hermes_home)
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    child = subprocess.Popen([sys.executable, '-B', str(runner), str(service.root), task['objective_id'], str(task['approval_version']), json.dumps(runtime)],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        start = identity(child.pid)
        require(start is not None, 'EXECUTOR_START_UNCONFIRMED')
        def started(t):
            t['worker'] = {'pid':child.pid,'start':start}
            if t['status'] in ACTIVE | {'VERIFYING'}:
                t['process_status'] = 'RUNNING'
        service.store.update(task['objective_id'], started, version=task['approval_version'], event='worker-started')
        threading.Thread(target=child.wait, daemon=True).start()
    except Exception:
        # A spawn already happened. Losing its receipt is not a safe retry.
        raise ValueError('EXECUTOR_START_UNCONFIRMED') from None


def run_task(service, ident, version, runtime, transport=None):
    task = service._active(ident, version)
    if transport is None:
        transport = create_transport(task['provider'], task['model'], reasoning_effort=task.get('reasoning_effort'))
    require_support(runtime)
    control = service.candidate(ident).parent / 'opencode'
    control.mkdir(mode=0o700, exist_ok=True)
    stopped = threading.Event()
    finished = threading.Event()
    check_child = [None]
    process_gate = threading.Lock()
    # SDK writes never receive a provider token. The child also scrubs ambient
    # credentials before importing OpenCode and prohibits direct network access.
    child = subprocess.Popen([runtime['bun'], runtime['worker']], cwd=service.candidate(ident),
        env={'PATH':os.environ.get('PATH','/usr/bin:/bin')}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        start_new_session=True)
    errors = bytearray()
    def drain_errors():
        while data := child.stderr.read(4096):
            errors.extend(data[:max(0, 16384-len(errors))])
    threading.Thread(target=drain_errors, daemon=True).start()

    kill = terminate_process

    def monitor():
        while not finished.wait(.1):
            current = service.store.load(ident)
            if current['status'] not in ACTIVE or time.time() >= current['deadline']:
                stopped.set()
                if current['status'] in ACTIVE:
                    service.cancel(current['session_id'], ident, version)
                with process_gate:
                    kill(check_child[0]); kill(child)
                    if service.store.load(ident)['status'] == 'CANCEL_REQUESTED':
                        service.terminated(ident, version, confirmed=child.poll() is not None)
                return
    monitor_thread=threading.Thread(target=monitor, daemon=True)
    monitor_thread.start()

    def send(message):
        require(not stopped.is_set(), 'CANCELLED')
        child.stdin.write((json.dumps(message)+'\n').encode()); child.stdin.flush()

    def check(command_id):
        request = service.request_check(ident, version, command_id)
        while service.check_decision(ident, request['id']) == 'pending':
            require(not stopped.wait(.1), 'CANCELLED')
        require(service.check_decision(ident, request['id']) == 'allowed', 'CHECK_DENIED')
        current = service._active(ident, version)
        _, _, before = service.candidate_state(current)
        def spawn(args):
            # Cancellation and process registration share the same task lock.
            with process_gate:
                def register(t):
                    require(t['status'] == 'RUNNING' and time.time() < t['deadline'], 'NOT_RUNNING')
                    check_child[0] = subprocess.Popen(args, env={'PATH':'/usr/bin:/bin'}, stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
                service.store.update(ident, register, version=version, event='check-started')
                return check_child[0]
        try:
            result = execute_check(service.candidate(ident), request['argv'], current['deadline'] - time.time(),
                cancelled=stopped.is_set, spawn=spawn)
        finally:
            check_child[0] = None
        _, _, after = service.candidate_state(current)
        require(after == before, 'CHECK_CHANGED_CANDIDATE')
        service.record_check(ident, version, command_id, result, tested_fingerprint=before)
        return result

    terminal = None
    host_stop = None
    try:
        send({'kind':'start','data':{'directory':str(service.candidate(ident)),'control_dir':str(control),'sdk_entry':runtime['sdk'],
            'protocol':getattr(transport,'protocol',runtime.get('protocol','chat')),
            'model':task['model'],'objective':task['objective'],'allowed_paths':task['allowed_paths'],'read_paths':task['read_paths'],
            'budget':service.budget(ident,version),
            'allowed_commands':task['allowed_commands'],'native_session':task['native_session'],'feedback':task['feedback']}})
        while line := child.stdout.readline(MAX_WIRE + 1):
            require(len(line) <= MAX_WIRE and line.endswith(b'\n'), 'WORKER_MESSAGE_LIMIT')
            message=json.loads(line)
            if message['kind'] == 'settled':
                terminal=message['data']; break
            if message['kind'] == 'progress':
                native=message['data'].get('native_session')
                if native:
                    service.store.update(ident, lambda t: t.update(native_session=native), version=version, event='native-session')
                continue
            require(message['kind'] in ('tool','model') and isinstance(message.get('id'),str), 'INVALID_WORKER_MESSAGE')
            result=None; failure=None
            try:
                service._active(ident, version)
                if message['kind']=='model':
                    service.reserve_request(ident, version, message['id'])
                    committed=service.commit_request(ident, version, message['id'])
                    try:
                        result=transport(message['data'], committed['deadline']-time.time())
                    except Exception:
                        service.finish_request(ident, version, message['id'], 'unknown')
                        raise ValueError('PROVIDER_RESULT_UNKNOWN') from None
                    service.finish_request(ident, version, message['id'], 'completed' if result['status']==200 else 'failed')
                    if result['status'] != 200:
                        code = 'PROVIDER_REFUSED_' + str(result['status'])
                        if result['status'] in (400, 401, 403, 404, 422, 429):
                            host_stop = code
                        raise ValueError(code)
                else:
                    args=message['data']
                    result=check(args.get('command_id')) if args.get('action')=='check' else service.tool(ident, version, args)
                    result={**result,'budget':service.budget(ident,version)}
            except Exception as exc:
                # Codes only: no raw provider response, token or request traceback.
                failure=str(exc) if isinstance(exc,ValueError) else 'HOST_OPERATION_FAILED'
                service.store.append(ident, 'operation-stopped', {'kind':message['kind'],'code':failure[:200]})
            if stopped.is_set(): break
            if failure and message['kind']=='model':
                # A refused reservation or an explicit provider refusal has a
                # known outcome. The child must still be reaped before settling.
                if failure == 'REQUEST_LIMIT': host_stop = failure
                kill(child); break
            send({'reply':message['id'], **({'error':failure} if failure else {'result':result})})
        child.wait(timeout=3)
        finished.set()
        current=service.store.load(ident)
        if current['status'] in ACTIVE | {'CANCEL_REQUESTED'}:
            if current['status'] == 'CANCEL_REQUESTED' or stopped.is_set():
                kill(check_child[0]); kill(child)
                service.terminated(ident, version, confirmed=child.poll() is not None)
            elif host_stop and child.poll() is not None:
                service.settle(ident, version, native_session=current['native_session'],
                    text=('模型請求上限已達，候選修改已保留。' if host_stop == 'REQUEST_LIMIT'
                          else '模型供應商已拒絕請求，候選修改已保留。'),
                    success=False, code=host_stop)
            elif terminal:
                service.settle(ident, version, native_session=terminal.get('native_session'), text=terminal.get('text',''),
                    success=terminal.get('success') is True and child.returncode==0, code=terminal.get('code'))
            else:
                service.terminated(ident, version, confirmed=False)
    except Exception as exc:
        kill(check_child[0]); kill(child); finished.set()
        service.store.append(ident, 'executor-error', {'code':str(exc)[:200] if isinstance(exc,ValueError) else type(exc).__name__})
        current=service.store.load(ident)
        if current['status'] in ACTIVE | {'CANCEL_REQUESTED'}:
            service.terminated(ident, version, confirmed=False)
    finally:
        finished.set(); kill(check_child[0]); kill(child)
        monitor_thread.join(timeout=4)
        for stream in (child.stdin,child.stdout,child.stderr):
            stream.close()
