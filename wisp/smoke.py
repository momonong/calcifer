"""Exercise the installed Wisp core with a disposable project and synthetic Responses."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


SESSION = 'wisp-offline-smoke'
ACTOR = 'delegated-operator'
COMMAND = ['python3', '-B', 'check_percent.py']
CHECK_OK = 'WISP_SMOKE_CHECK_OK'
BASELINE = 'def clamp_percent(value: int) -> int:\n    return max(0, min(99, value))\n'
CHECK = '''from percent import clamp_percent

assert clamp_percent(-10) == 0
assert clamp_percent(42) == 42
assert clamp_percent(100) == 100, '100 percent must be preserved'
assert clamp_percent(120) == 100
print('WISP_SMOKE_CHECK_OK')
'''


def response(index, args=None):
    """Synthetic Responses event stream; the SDK consumes it without a provider."""
    ident = f'resp_{index}'
    item = ({'id':f'fc_{index}', 'type':'function_call', 'call_id':f'call_{index}', 'name':'wisp_workspace',
        'arguments':json.dumps(args), 'status':'completed'} if args else
        {'id':f'msg_{index}', 'type':'message', 'role':'assistant', 'status':'completed',
        'content':[{'type':'output_text','text':'Candidate prepared; review the check evidence.', 'annotations':[]}]})
    base = {'id':ident,'object':'response','created_at':1,'model':'test-model','status':'in_progress','output':[]}
    events = [{'type':'response.created','response':base},
        {'type':'response.output_item.added','output_index':0,'item':{**item, 'arguments':''} if args else item}]
    if args:
        events += [{'type':'response.function_call_arguments.delta','item_id':item['id'],'output_index':0,'delta':item['arguments']},
            {'type':'response.function_call_arguments.done','item_id':item['id'],'output_index':0,'arguments':item['arguments']}]
    else:
        events += [{'type':'response.output_text.delta','item_id':item['id'],'output_index':0,
            'delta':item['content'][0]['text']}]
    events += [{'type':'response.output_item.done','output_index':0,'item':item},
        {'type':'response.completed','response':{**base,'status':'completed','output':[item],
            'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}}}]
    return {'status':200, 'headers':{'content-type':'text/event-stream'},
        'body':''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events)}


def load_core(plugin):
    entry = plugin / '__init__.py'
    if not entry.is_file():
        raise ValueError('找不到已安裝的 wisp-core。請先在 WSL 安裝固定版開發執行環境。')
    spec = importlib.util.spec_from_file_location(
        'wisp_smoke_core', entry, submodule_search_locations=[str(plugin)])
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)


def evidence(task):
    return {key: task[key] for key in (
        'objective_id', 'session_id', 'native_session', 'diff', 'checks', 'candidate_fingerprint', 'integration')}


def run_fixture(root):
    from wisp_smoke_core.executor import execute_check, run_task
    from wisp_smoke_core.platform_support import require_support
    from wisp_smoke_core.runtime import read_runtime
    from wisp_smoke_core.service import Service, require

    runtime = read_runtime()
    require_support(runtime)
    runtime = {**runtime, 'protocol':'responses'}
    project = root / 'source'
    project.mkdir()
    source = project / 'percent.py'
    check_file = project / 'check_percent.py'
    source.write_text(BASELINE, encoding='utf-8')
    check_file.write_text(CHECK, encoding='utf-8')
    baseline_check = execute_check(project, COMMAND, 10)
    require(baseline_check['exit_code'] == 1 and '100 percent must be preserved' in baseline_check['stderr'],
            'SMOKE_BASELINE_DID_NOT_FAIL_AS_EXPECTED')

    steps = [
        {'action':'read', 'path':'percent.py'},
        {'action':'replace', 'path':'percent.py', 'old_text':'min(99, value)', 'new_text':'min(100, value)'},
        {'action':'check', 'command_id':'check-percent'},
        None,
    ]
    simulated = 0

    def fixture_transport(data, _timeout):
        nonlocal simulated
        require(data['url'] == 'https://wisp.invalid/v1/responses' and simulated < len(steps),
                'UNEXPECTED_SMOKE_FIXTURE_REQUEST')
        simulated += 1
        return response(simulated, steps[simulated - 1])

    class FixtureService(Service):
        def request_check(self, ident, version, command_id):
            request = super().request_check(ident, version, command_id)
            require(command_id == 'check-percent' and request['argv'] == COMMAND, 'UNEXPECTED_SMOKE_COMMAND')
            self.decide_check(SESSION, ident, version, request['id'], True, actor=ACTOR)
            return request

    service = FixtureService(root / 'state')
    service.launch = lambda task: run_task(service, task['objective_id'], task['approval_version'],
                                           runtime, transport=fixture_transport)
    task = service.propose(SESSION, project, {
        'objective':'Fix the upper bound of the isolated percentage example and run its check.',
        'read_paths':['percent.py', 'check_percent.py'], 'allowed_paths':['percent.py'],
        'allowed_commands':[{'id':'check-percent', 'argv':COMMAND}],
        'provider':'hermes-openai-api', 'model':'test-model',
        'limits':{'max_requests':len(steps), 'max_seconds':45},
    }, source={'kind':ACTOR, 'session_id':SESSION, 'authorizing_thread_id':SESSION,
               'authorization_reference':'Explicit wisp smoke --offline invocation for this isolated fixture.'})
    ident = task['objective_id']
    task = service.approve(SESSION, ident, 1, actor=ACTOR)
    require(task['status'] == 'REVIEW' and task['native_session'],
            task.get('error') or f'SMOKE_REVIEW_MISSING ({task["status"]})')
    require(simulated == task['requests_used'] == len(steps)
            and all(request['status'] == 'completed' for request in task['requests']), 'SMOKE_FIXTURE_LEDGER_MISMATCH')
    require(task['changes'] == ['percent.py'] and 'min(99, value)' in task['diff']
            and 'min(100, value)' in task['diff'] and source.read_text(encoding='utf-8') == BASELINE,
            'SMOKE_DIFF_MISMATCH')
    require(len(task['checks']) == 1, 'SMOKE_CHECK_MISSING')
    check = task['checks'][0]
    require(check['exit_code'] == 0 and CHECK_OK in check['stdout']
            and check['fingerprint'] == task['candidate_fingerprint'], 'SMOKE_CANDIDATE_CHECK_FAILED')

    service.accept(SESSION, ident, 1, actor=ACTOR)
    preview = service.preview_apply(SESSION, ident, 1)
    require(preview['ready'] and preview['files'] == ['percent.py'], 'SMOKE_APPLY_PREVIEW_FAILED')
    applied = service.apply(SESSION, ident, 1, preview['token'], actor=ACTOR)
    require(applied['integration']['status'] == 'APPLIED'
            and source.read_text(encoding='utf-8') == BASELINE.replace('min(99, value)', 'min(100, value)')
            and check_file.read_text(encoding='utf-8') == CHECK, 'SMOKE_APPLY_FAILED')
    (root / 'receipt.json').write_text(json.dumps({
        'task':evidence(applied), 'applied_pid':os.getpid(), 'baseline_exit':baseline_check['exit_code'],
        'synthetic_responses':simulated, 'model_requests':0,
    }, indent=2) + '\n', encoding='utf-8')
    print(task['diff'], end='' if task['diff'].endswith('\n') else '\n')
    print(f'Candidate check exit={check["exit_code"]} {check["stdout"].strip()}')
    print(f'Apply {applied["integration"]["status"]} {applied["integration"]["id"]}')


def reopen_fixture(root):
    from wisp_smoke_core.executor import execute_check
    from wisp_smoke_core.service import Service, require

    receipt_path = root / 'receipt.json'
    receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
    ident = receipt['task']['objective_id']
    task = Service(root / 'state').snapshot(SESSION, ident)
    require(os.getpid() != receipt['applied_pid'] and evidence(task) == receipt['task'],
            'SMOKE_REOPEN_EVIDENCE_MISMATCH')
    check = execute_check(root / 'source', COMMAND, 10)
    require(check['exit_code'] == 0 and CHECK_OK in check['stdout'], 'SMOKE_APPLIED_CHECK_FAILED')
    receipt.update(reopened_pid=os.getpid(), applied_check_exit=check['exit_code'])
    receipt_path.write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(f'Reopen task={ident} state={task["integration"]["status"]} check_exit={check["exit_code"]}')
    print(f'WISP_SMOKE_OK synthetic_responses={receipt["synthetic_responses"]} model_requests=0')


def main():
    plugin = Path(sys.argv[1])
    if sys.platform != 'linux':
        raise ValueError('離線 smoke 需要 Linux 開發執行環境。')
    if len(sys.argv) == 2:
        if not (plugin / '__init__.py').is_file():
            raise ValueError('找不到已安裝的 wisp-core。請先準備固定版開發執行環境。')
        root = Path(tempfile.mkdtemp(prefix='wisp-smoke-', dir='/tmp'))
        print(f'Fixture {root}', flush=True)
        env = {'PATH':'/usr/bin:/bin', 'HOME':str(root), 'TMPDIR':str(root), 'LANG':'C.UTF-8'}
        for phase in ('run', 'reopen'):
            result = subprocess.run([sys.executable, '-I', '-B', __file__, str(plugin), phase, str(root)],
                                    cwd=root, env=env, stdin=subprocess.DEVNULL)
            if result.returncode:
                return result.returncode
        return 0

    _, _, phase, fixture = sys.argv
    load_core(plugin)
    {'run':run_fixture, 'reopen':reopen_fixture}[phase](Path(fixture))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, KeyError) as error:
        print(f'Wisp smoke: {error}', file=sys.stderr)
        raise SystemExit(1)
