"""The sole owner of workflow transitions and review evidence."""
import copy
import json
from pathlib import Path
import time
import uuid

from .store import Store
from . import workspace as ws
from .provider import supports_provider
from .platform_support import assess, require_ready

ACTIVE = {'RUNNING', 'WAITING_APPROVAL'}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def needs_reverification(task):
    return (task['status'] == 'ACCEPTED' and 'baseline_modes' not in task and
            (task.get('integration') or {}).get('status') in (None, 'ROLLED_BACK'))


class Service:
    def __init__(self, root, launch=None):
        self.store = Store(root)
        self.root = self.store.root
        self.launch = launch
        self.verify_launch = None
        # A trusted runtime supplies the SDK assessment. In-process test/custom
        # launchers still require the platform and isolation prerequisites.
        self.execution_support = None

    def capabilities(self):
        result = {}
        for purpose, launcher in (('development', self.launch), ('verification', self.verify_launch)):
            value = self.execution_support(purpose) if self.execution_support else assess(require_runtime=False)
            if launcher is None:
                value['ready'] = False
                value['issues'].append({'code': 'EXECUTOR_NOT_CONFIGURED' if purpose == 'development' else 'VERIFIER_NOT_CONFIGURED',
                    'message': '尚未配置開發執行器。' if purpose == 'development' else '尚未配置離線驗證執行器。'})
            result[purpose] = value
        return result

    def preflight(self, purpose):
        require_ready(self.capabilities()[purpose])
        require((self.launch if purpose == 'development' else self.verify_launch) is not None,
            'EXECUTOR_NOT_CONFIGURED' if purpose == 'development' else 'VERIFIER_NOT_CONFIGURED')

    def candidate(self, ident):
        require(isinstance(ident, str) and len(ident) == 32 and all(c in '0123456789abcdef' for c in ident), 'INVALID_TASK_ID')
        return self.root / 'tasks' / ident / 'candidate'

    def source_modes(self, task):
        if 'baseline_modes' in task:
            return task['baseline_modes']
        return ws.file_modes(task['repo'], task['baseline'])

    def candidate_state(self, task):
        baseline = task['baseline']
        after, modes = ws.candidate_snapshot(self.candidate(task['objective_id']), list(baseline))
        changed = [name for name in after if after[name] != baseline[name]]
        require(set(changed) <= set(task['allowed_paths']) and
                all(after[name] is not None for name in changed), 'CANDIDATE_SCOPE_CHANGED')
        original_modes = self.source_modes(task)
        expected_modes = {name: ws.output_mode(original_modes[name]) if value is not None else None
                          for name, value in after.items()}
        require(modes == expected_modes, 'CANDIDATE_MODE_CHANGED')
        return after, changed, ws.fingerprint({'files': after, 'modes': modes})

    def propose(self, session_id, cwd, brief, *, source=None):
        require(isinstance(session_id, str) and 0 < len(session_id) <= 256, 'SESSION_REQUIRED')
        # Trusted operator callers can attribute an explicit user delegation.
        # This keyword is deliberately absent from the model tool / GUI payload.
        if source is None:
            source = {'kind': 'hermes-conversation', 'session_id': session_id}
        else:
            require(type(source) is dict and set(source) == {'kind', 'session_id', 'authorizing_thread_id', 'authorization_reference'}
                and source['kind'] == 'delegated-operator' and source['session_id'] == session_id
                and all(isinstance(v, str) and 0 < len(v.strip()) <= 2000 for v in source.values()), 'INVALID_SOURCE')
        objective = brief.get('objective', '')
        require(isinstance(objective, str) and 0 < len(objective.strip()) <= 8000, 'INVALID_OBJECTIVE')
        repo = Path(cwd).absolute()
        require(repo.is_dir() and repo.resolve() == repo, 'CANONICAL_REPO_REQUIRED')
        read_paths = brief.get('read_paths', [])
        allowed_paths = brief.get('allowed_paths', [])
        require(isinstance(read_paths, list) and isinstance(allowed_paths, list) and allowed_paths, 'SCOPE_REQUIRED')
        paths = list(dict.fromkeys(read_paths + allowed_paths))
        before = ws.snapshot(repo, paths)
        require(all(before[name] is not None for name in read_paths), 'READ_FILE_MISSING')
        limits = {'max_requests': 8, 'max_seconds': 600, **brief.get('limits', {})}
        require(set(limits) == {'max_requests', 'max_seconds'} and type(limits['max_requests']) is int and 1 <= limits['max_requests'] <= 32
                and type(limits['max_seconds']) is int and 30 <= limits['max_seconds'] <= 1800, 'INVALID_LIMITS')
        provider = brief.get('provider', '')
        require(supports_provider(provider), 'PROVIDER_NOT_AVAILABLE')
        model = brief.get('model', '')
        require(isinstance(model, str) and model and len(model) <= 128 and all(c.isalnum() or c in '-._' for c in model), 'MODEL_REQUIRED')
        task = {'objective_id': uuid.uuid4().hex, 'approval_version': 1, 'session_id': session_id,
            'objective': objective.strip(), 'repo': str(repo), 'read_paths': list(read_paths), 'allowed_paths': list(allowed_paths),
            'allowed_commands': ws.commands(brief.get('allowed_commands', [])), 'limits': limits, 'provider': provider, 'model': model,
            'source': copy.deepcopy(source),
            'status': 'PROPOSED', 'baseline': before, 'baseline_modes': ws.file_modes(repo, before),
            'created_at': time.time(), 'updated_at': time.time(),
            'requests_used': 0, 'requests': [], 'seconds_used': 0, 'checks': [], 'permissions': [], 'completion': None,
            'native_session': None, 'feedback': [], 'diff': '', 'changes': [], 'process_status': None,
            'route': {'executor': 'opencode', 'reason': '跨檔案開發：完整目標交接一次，Hermes 保留對話入口。'}}
        self.store.create(task)
        return self.public(task)

    @staticmethod
    def public(task):
        result = {key: copy.deepcopy(value) for key, value in task.items() if key not in ('baseline', 'baseline_modes')}
        if needs_reverification(task):
            result['verification_upgrade_required'] = True
        return result

    def snapshot(self, session_id, task_id=None):
        capabilities = self.capabilities()
        if task_id is None:
            return [{**self.public(t), 'capabilities': capabilities, 'notes': self.store.notes(t['objective_id'],session_id), 'candidate_directory': str(self.candidate(t['objective_id'])), 'events': self.store.events(t['objective_id'], session_id)[-20:]}
                for t in self.store.list(session_id)]
        task = self.store.load(task_id, session_id)
        return {**self.public(task), 'capabilities': capabilities, 'notes': self.store.notes(task_id,session_id), 'candidate_directory': str(self.candidate(task_id)), 'events': self.store.events(task_id, session_id)}

    @staticmethod
    def _note_source(task, actor):
        Service._actor(task, actor)
        return {'objective_id':task['objective_id'], 'session_id':task['session_id'], 'approval_version':task['approval_version'],
            'channel':'gui' if actor == 'human' else 'delegated-operator'}

    @staticmethod
    def _note_id(value):
        require(isinstance(value,str) and len(value)==32 and all(c in '0123456789abcdef' for c in value),'INVALID_NOTE_ID')

    def record_note(self, session, ident, version, note_id, kind, text, *, actor='human'):
        self._note_id(note_id)
        require(kind in ('decision','todo'),'INVALID_NOTE_KIND')
        require(isinstance(text,str) and 0 < len(text.strip()) <= 1000,'INVALID_NOTE_TEXT')
        text=text.strip()
        def record(task, old):
            source=self._note_source(task,actor)
            if old:
                require(old['kind']==kind and old['text']==text and old['source']==source,'NOTE_ID_CONFLICT')
                return old
            now=time.time()
            return {'id':note_id,'kind':kind,'text':text,'status':'active' if kind=='decision' else 'open','revision':1,
                'source':source,'last_updated_source':source,'created_at':now,'updated_at':now,'execution_authorized':False}
        self.store.change_note(ident,session,version,note_id,record,'note-recorded')
        return self.snapshot(session,ident)

    def update_note(self, session, ident, version, note_id, revision, status, *, actor='human'):
        self._note_id(note_id)
        require(type(revision) is int and revision>=1,'INVALID_NOTE_REVISION')
        def update(task, note):
            source=self._note_source(task,actor)
            require(note is not None,'NOTE_NOT_FOUND')
            require(note['revision']==revision,'NOTE_VERSION_CONFLICT')
            require(status in (('open','done') if note['kind']=='todo' else ('withdrawn',)),'INVALID_NOTE_STATUS')
            require(note['status']!=status,'NOTE_STATE_CONFLICT')
            note.update(status=status,revision=revision+1,updated_at=time.time(),last_updated_source=source)
            return note
        self.store.change_note(ident,session,version,note_id,update,'note-status-changed')
        return self.snapshot(session,ident)

    def usage(self, session):
        require(isinstance(session,str) and 0 < len(session) <= 256,'SESSION_REQUIRED')
        def counters():
            return {'task_count':0,'requests_used':0,'dispatch_committed':0,'unknown_tasks':0,
                'unattributed_requests':0,'request_states':{state:0 for state in
                    ('reserved','inflight','completed','failed','unknown','cancelled','unrecognized')}}
        total=counters();groups={}
        for provider,model,status,used,raw in self.store.usage_rows(session):
            records=json.loads(raw or '[]')
            group=groups.setdefault((provider,model),counters())
            for value in (total,group):
                value['task_count']+=1;value['requests_used']+=used
                value['unknown_tasks']+=status=='TERMINATION_UNKNOWN'
                value['unattributed_requests']+=max(0,used-len(records))
                for record in records:
                    state=record.get('status')
                    value['request_states'][state if state in value['request_states'] else 'unrecognized']+=1
                    value['dispatch_committed']+='committed_at' in record
        return {**total,'scope':'current-session','account_quota':None,'tokens':None,'cost':None,'expires_at':None,
            'by_model':[{'provider':provider,'model':model,**value} for (provider,model),value in groups.items()]}

    @staticmethod
    def progress(task):
        """One receipt-backed summary for both the GUI and conversation recall."""
        state = task['status']
        applied = (task.get('integration') or {}).get('status')
        next_step = {'PROPOSED': '核對範圍後批准開發。', 'RUNNING': '查看目前進度，等待開發完成。',
                'VERIFYING': '正在離線驗證候選，不會呼叫模型。',
                'WAITING_APPROVAL': '核對並批准或拒絕驗收命令。', 'REVIEW': '核對 Diff 與測試，再接受候選或退回修正。',
                'ACCEPTED': '候選已接受；預覽來源差異，再決定是否套回專案。',
                'FAILED': '核對失敗原因與現存候選，先不要自動開始新任務。',
                'TERMINATION_UNKNOWN': '保留原收據並確認結果，不可重送或改 key 派發。',
                'CANCEL_REQUESTED': '等待程序與遠端請求狀態確認。',
                'PROCESS_TERMINATED': '程序已停止，核對保留的候選與結果。',
                'REJECTED': '提案已拒絕，不會執行。'}.get(state, '核對持久任務狀態。')
        if task.get('error') == 'REQUEST_LIMIT' and state == 'FAILED':
            next_step = '請求額度已用完；保留 Diff，先核對現有成果，不自動重置或重派。'
        if applied == 'APPLIED':
            next_step = '已套回本機來源；尚未 Git 提交、推送或部署。'
        elif applied == 'ROLLED_BACK':
            next_step = '本次套用已撤回，候選與備份仍保留。'
        elif applied in ('APPLYING', 'ROLLING_BACK', 'RECOVERY_REQUIRED'):
            next_step = '套用／回復尚未確認；保留備份並檢查衝突，不可強制覆寫。'
        fingerprint = task.get('candidate_fingerprint')
        passed = sum(any(c.get('id') == command['id'] and c.get('exit_code') == 0 and
            c.get('version') == task['approval_version'] and fingerprint and c.get('fingerprint') == fingerprint
            for c in task['checks']) for command in task['allowed_commands'])
        notes = task.get('notes',[])
        pending = [note for note in reversed(notes) if note['status'] in ('active','open')]
        note_summary = [{**{k:copy.deepcopy(v) for k,v in note.items() if k in ('id','kind','status','source','revision')},
            'text':note['text'][:279]+'…' if len(note['text'])>280 else note['text'],
            'text_truncated':len(note['text'])>280} for note in pending[:4]]
        return {'objective_id': task['objective_id'], 'objective': task['objective'][:500],
                'status': state, 'approval_version': task['approval_version'],
                'requests_used': task['requests_used'], 'max_requests': task['limits']['max_requests'],
                'updated_at': task['updated_at'], 'source': copy.deepcopy(task['source']),
                'changed_files': task.get('changes', []),
                'tests': {'passed': passed, 'required': len(task['allowed_commands'])},
                'integration_status': applied, 'next_step': next_step,
                'notes':note_summary,
                'notes_truncated':len(pending)>4 or any(note['text_truncated'] for note in note_summary),
                'note_counts':{'open_todos':sum(n['status']=='open' for n in notes),
                    'done_todos':sum(n['status']=='done' for n in notes),'active_decisions':sum(n['status']=='active' for n in notes)}}

    def project_context(self, session, repo):
        from .executor import reconcile
        require(isinstance(session, str) and 0 < len(session) <= 256, 'SESSION_REQUIRED')
        repo = Path(repo).absolute()
        require(repo.is_dir() and repo.resolve() == repo, 'CANONICAL_REPO_REQUIRED')
        sharing, tasks, truncated = self.store.project(str(repo), session)
        # Only inspect tasks already visible through this profile/project gate.
        # Reconciliation records an absent owner; it never launches or retries.
        rows = [self.progress({**reconcile(self, task), 'notes':self.store.notes(task['objective_id'],task['session_id'])}) for task in tasks]
        return {'repo': str(repo), 'sharing': sharing, 'tasks': rows, 'truncated': truncated,
            'execution_authorized': False, 'scope': 'project' if sharing['enabled'] else 'current-session'}

    def set_project_sharing(self, session, ident, version, enabled, *, actor='human'):
        require(type(enabled) is bool, 'INVALID_DECISION')
        task = self.store.load(ident, session)
        self._actor(task, actor)
        repo = self.store.set_project_sharing(ident, session, version, enabled, actor)
        return self.project_context(session, repo)

    def _active(self, ident, version):
        task = self.store.load(ident)
        require(task['approval_version'] == version, 'VERSION_CONFLICT')
        require(task['status'] in ACTIVE, 'NOT_RUNNING')
        require(time.time() < task['deadline'], 'TASK_DEADLINE')
        return task

    def _start(self, ident, version, *, initial):
        try:
            task = self._active(ident, version)
            if initial:
                require(ws.snapshot(task['repo'], list(task['baseline'])) == task['baseline'], 'SOURCE_CHANGED')
                modes = self.source_modes(task)
                require(ws.file_modes(task['repo'], task['baseline']) == modes, 'SOURCE_CHANGED')
                ws.materialize(self.candidate(ident), task['baseline'], modes)
            self._active(ident, version)
            require(self.launch is not None, 'EXECUTOR_NOT_CONFIGURED')
            self.launch(self.store.load(ident))
        except Exception as error:
            def failed(t):
                if t['status'] == 'CANCEL_REQUESTED':
                    t.update(status='PROCESS_TERMINATED', process_status='PROCESS_TERMINATED')
                elif t['status'] in ACTIVE:
                    uncertain = str(error) == 'EXECUTOR_START_UNCONFIRMED'
                    t.update(status='TERMINATION_UNKNOWN' if uncertain else 'FAILED',
                        process_status='TERMINATION_UNKNOWN' if uncertain else 'PROCESS_TERMINATED', error=str(error)[:300])
            self.store.update(ident, failed, version=version, event='start-stopped')
            raise

    @staticmethod
    def _actor(task, actor):
        require(actor in ('human', 'delegated-operator'), 'INVALID_ACTOR')
        require(actor != 'delegated-operator' or task['source']['kind'] == 'delegated-operator', 'DELEGATION_SOURCE_REQUIRED')
        return actor

    def approve(self, session, ident, version, *, actor='human'):
        def approved(t):
            require(t['status'] == 'PROPOSED', 'STATE_CONFLICT')
            self._actor(t, actor)
            self.preflight('development')
            t.update(approval_actor=self._actor(t, actor), status='RUNNING', started_at=time.time(), deadline=time.time() + t['limits']['max_seconds'], process_status='STARTING')
        self.store.update(ident, approved, session=session, version=version, event='approved')
        self._start(ident, version, initial=True)
        return self.snapshot(session, ident)

    def reject(self, session, ident, version):
        def rejected(t):
            require(t['status'] == 'PROPOSED', 'STATE_CONFLICT')
            t['status'] = 'REJECTED'
        return self.public(self.store.update(ident, rejected, session=session, version=version, event='rejected'))

    def reserve_request(self, ident, version, request_id):
        def reserve(t):
            require(t['status'] == 'RUNNING', 'NOT_RUNNING')
            require(time.time() < t['deadline'], 'TASK_DEADLINE')
            require(t['requests_used'] < t['limits']['max_requests'], 'REQUEST_LIMIT')
            require(not any(r['id'] == request_id for r in t['requests']), 'DUPLICATE_REQUEST')
            require(not any(r['status'] in ('reserved', 'inflight', 'unknown') for r in t['requests']), 'REQUEST_UNSETTLED')
            t['requests'].append({'id': request_id, 'version': version, 'status': 'reserved'})
            t['requests_used'] += 1
        return self.store.update(ident, reserve, version=version, event='model-reserved')

    def commit_request(self, ident, version, request_id):
        """Linearization point: after this commit a request may consume quota.

        Cancellation before this point cancels the reservation. After it the
        request is in-flight: the provider may finish even if the worker stops.
        """
        def commit(t):
            require(t['status'] == 'RUNNING' and time.time() < t['deadline'], 'NOT_RUNNING')
            record = next((r for r in t['requests'] if r['id'] == request_id and r['version'] == version), None)
            require(record is not None and record['status'] == 'reserved', 'REQUEST_NOT_RESERVED')
            record.update(status='inflight', committed_at=time.time())
        return self.store.update(ident, commit, version=version, event='model-dispatch-committed')

    def finish_request(self, ident, version, request_id, status):
        require(status in ('completed', 'failed', 'unknown'), 'INVALID_REQUEST_STATUS')
        def finish(t):
            record = next((r for r in t['requests'] if r['id'] == request_id and r['version'] == version), None)
            require(record is not None and record['status'] == 'inflight', 'REQUEST_NOT_INFLIGHT')
            record['status'] = status
        self.store.update(ident, finish, version=version, event='model-settled')

    def budget(self, ident, version):
        task = self.store.load(ident)
        require(task['approval_version'] == version, 'VERSION_CONFLICT')
        return {'requests_used': task['requests_used'], 'max_requests': task['limits']['max_requests'],
            'requests_remaining': max(0, task['limits']['max_requests'] - task['requests_used']),
            'seconds_remaining': max(0, int(task.get('deadline', time.time()) - time.time()))}

    def tool(self, ident, version, args):
        task = self._active(ident, version)
        require(task['status'] == 'RUNNING', 'NOT_RUNNING')
        action = args.get('action'); name = args.get('path')
        if action == 'read':
            require(name in task['baseline'], 'READ_NOT_ALLOWED')
            return {'path': name, 'content': ws.read(self.candidate(ident), name)}
        if action == 'search':
            query = args.get('query')
            require(isinstance(query, str) and 0 < len(query) <= 200, 'INVALID_QUERY')
            require(name is None or name in task['baseline'], 'READ_NOT_ALLOWED')
            rows = []
            for path, content in ws.snapshot(self.candidate(ident), [name] if name is not None else list(task['baseline'])).items():
                rows.extend({'path': path, 'line': i + 1, 'text': line[:500]} for i, line in enumerate((content or '').splitlines()) if query.casefold() in line.casefold())
            return {'matches': rows[:80], 'truncated': len(rows) > 80}
        if action in ('edit', 'replace', 'replace_many'):
            require(name in task['allowed_paths'], 'WRITE_NOT_ALLOWED')
            # The SQLite lock also serializes cancellation against writes.
            def edit(t):
                require(t['status'] == 'RUNNING' and time.time() < t['deadline'], 'NOT_RUNNING')
                before = ws.snapshot(self.candidate(ident), list(t['baseline']))
                content = args.get('content')
                if action in ('replace', 'replace_many'):
                    edits = args.get('edits') if action == 'replace_many' else [{'old_text': args.get('old_text'), 'new_text': args.get('new_text')}]
                    require(isinstance(edits, list) and 1 <= len(edits) <= 16, 'INVALID_EDITS')
                    content = before[name]
                    for item in edits:
                        require(isinstance(item, dict) and set(item) == {'old_text', 'new_text'}, 'INVALID_EDITS')
                        old, new = item['old_text'], item['new_text']
                        require(isinstance(old, str) and old and isinstance(content, str)
                            and content.count(old) == 1, 'REPLACEMENT_NOT_UNIQUE')
                        require(isinstance(new, str) and len(new.encode()) <= ws.MAX_FILE, 'INVALID_FILE_CONTENT')
                        content = content.replace(old, new, 1)
                        require(len(content.encode()) <= ws.MAX_FILE, 'INVALID_FILE_CONTENT')
                planned = {**before, name: content}
                require(isinstance(content, str) and sum(len((v or '').encode()) for v in planned.values()) <= ws.MAX_TOTAL, 'TOTAL_SIZE_LIMIT')
                ws.write(self.candidate(ident), name, content)
                t['checks'] = []
            self.store.update(ident, edit, version=version, event='candidate-edited')
            return {'path': name, 'written': True}
        raise ValueError('TOOL_ACTION_NOT_ALLOWED')

    def request_check(self, ident, version, command_id):
        request = {'id': uuid.uuid4().hex, 'command_id': command_id, 'version': version, 'decision': 'pending'}
        def pending(t):
            require(t['status'] == 'RUNNING' and time.time() < t['deadline'], 'NOT_RUNNING')
            command = next((c for c in t['allowed_commands'] if c['id'] == command_id), None)
            require(command is not None, 'COMMAND_NOT_ALLOWED')
            request['argv'] = command['argv']
            t['permissions'].append(request.copy()); t['status'] = 'WAITING_APPROVAL'
        self.store.update(ident, pending, version=version, event='check-awaiting-approval')
        return request

    def decide_check(self, session, ident, version, request_id, allow, *, actor='human'):
        require(type(allow) is bool, 'INVALID_DECISION')
        def decide(t):
            require(t['status'] == 'WAITING_APPROVAL' and time.time() < t['deadline'], 'STATE_CONFLICT')
            request = next((p for p in t['permissions'] if p['id'] == request_id and p['version'] == version), None)
            require(request is not None and request['decision'] == 'pending', 'PERMISSION_NOT_PENDING')
            request['decision_actor'] = self._actor(t, actor)
            request['decision'] = 'allowed' if allow else 'denied'
            t['status'] = 'RUNNING'
        return self.public(self.store.update(ident, decide, session=session, version=version, event='check-decision'))

    def check_decision(self, ident, request_id):
        return next(p['decision'] for p in self.store.load(ident)['permissions'] if p['id'] == request_id)

    def record_check(self, ident, version, command_id, result, *, tested_fingerprint=None):
        def record(t):
            require(t['status'] in ('RUNNING', 'REVIEW'), 'NOT_RUNNING')
            require(any(c['id'] == command_id for c in t['allowed_commands']), 'COMMAND_NOT_ALLOWED')
            _, _, fingerprint = self.candidate_state(t)
            require(tested_fingerprint is None or tested_fingerprint == fingerprint, 'CHECK_CHANGED_CANDIDATE')
            t['checks'] = [c for c in t['checks'] if c['id'] != command_id]
            t['checks'].append({'id': command_id, 'version': version, 'fingerprint': fingerprint,
                'exit_code': result.get('exit_code'), 'stdout': result.get('stdout', '')[:16000],
                'stderr': result.get('stderr', '')[:16000], 'code': result.get('code', '')})
        self.store.update(ident, record, version=version, event='check-result')

    def settle(self, ident, version, *, native_session, text, success, code=None):
        def settled(t):
            require(t['status'] in ACTIVE | {'CANCEL_REQUESTED'}, 'STATE_CONFLICT')
            after, changes, fingerprint = self.candidate_state(t)
            unknown = any(r['status'] in ('inflight', 'unknown') for r in t['requests'])
            if t['status'] == 'CANCEL_REQUESTED':
                t['status'] = 'TERMINATION_UNKNOWN' if unknown else 'PROCESS_TERMINATED'
            else:
                t['status'] = 'TERMINATION_UNKNOWN' if unknown else 'REVIEW' if success else 'FAILED'
            t.update(native_session=native_session or t['native_session'], summary=str(text)[:8000],
                diff=ws.diff(t['baseline'], after), changes=changes,
                candidate_fingerprint=fingerprint, process_status='PROCESS_TERMINATED',
                seconds_used=t['seconds_used'] + max(0, time.time() - t['started_at']))
            if code and not success:
                t['error'] = str(code)[:200]
        return self.store.update(ident, settled, version=version, event='executor-settled')

    def revise(self, session, ident, version, feedback, *, actor='human'):
        require(isinstance(feedback, str) and 0 < len(feedback.strip()) <= 8000, 'FEEDBACK_REQUIRED')
        def revision(t):
            require(t['status'] in ('REVIEW', 'FAILED'), 'STATE_CONFLICT')
            require(not any(r['status'] in ('inflight', 'unknown') for r in t['requests']), 'REQUEST_UNSETTLED')
            require(t['requests_used'] < t['limits']['max_requests'] and t['seconds_used'] < t['limits']['max_seconds'], 'BUDGET_EXHAUSTED')
            self._actor(t, actor)
            self.candidate_state(t)
            self.preflight('development')
            t['approval_actor'] = self._actor(t, actor)
            t['approval_version'] += 1
            t['feedback'].append({'version': t['approval_version'], 'text': feedback.strip(), 'source': t['source'], 'at': time.time()})
            if t.get('verification'):
                t.setdefault('verification_history', []).append(t.pop('verification'))
            t.update(status='RUNNING', checks=[], permissions=[], completion=None, diff='', changes=[],
                started_at=time.time(), deadline=time.time() + t['limits']['max_seconds'] - t['seconds_used'], process_status='STARTING', worker=None, error=None)
        task = self.store.update(ident, revision, session=session, version=version, event='revision-approved')
        self._start(ident, task['approval_version'], initial=False)
        return self.snapshot(session, ident)

    def accept(self, session, ident, version, *, actor='human'):
        def accept(t):
            require(t['status'] == 'REVIEW', 'STATE_CONFLICT')
            _, _, fingerprint = self.candidate_state(t)
            require(fingerprint == t.get('candidate_fingerprint'), 'CANDIDATE_CHANGED')
            require(t['allowed_commands'] and all(any(c['id'] == cmd['id'] and c['version'] == version and c['exit_code'] == 0 and c['fingerprint'] == fingerprint for c in t['checks']) for cmd in t['allowed_commands']), 'CHECKS_REQUIRED')
            require(not any(r['status'] in ('inflight', 'unknown') for r in t['requests']), 'REQUEST_UNSETTLED')
            verification = t.get('verification') or {}
            verified = (verification.get('status') == 'PASSED' and
                verification.get('approval_version') == version and verification.get('fingerprint') == fingerprint)
            t['status'] = 'ACCEPTED'
            t['completion'] = {'changed_files': t['changes'], 'tests': copy.deepcopy(t['checks']),
                'verification': copy.deepcopy(verification) if verified else None,
                'execution_outcome': 'operator-verified-candidate' if verified else 'executor-completed',
                'open_items': ['原始專案尚未套用；其他待決事項請核對執行器摘要。'],
                'source': {**t['source'], 'objective_id': ident, 'approval_version': version},
                'decision': self._actor(t, actor) + '-accepted-candidate', 'accepted_at': time.time(), 'source_repo_modified': False}
        return self.public(self.store.update(ident, accept, session=session, version=version, event='accepted'))

    def cancel(self, session, ident, version):
        def cancel(t):
            require(t['status'] in ACTIVE | {'VERIFYING', 'CANCEL_REQUESTED'}, 'STATE_CONFLICT')
            t['status'] = 'CANCEL_REQUESTED'
            for record in t['requests']:
                if record['status'] == 'reserved': record['status'] = 'cancelled'
        return self.public(self.store.update(ident, cancel, session=session, version=version, event='cancel-requested'))

    def preview_apply(self, session, ident, version):
        from .integration import preview
        return preview(self, session, ident, version)

    def preview_verify(self, session, ident, version):
        from .verification import preview
        return preview(self, session, ident, version)

    def verify(self, session, ident, version, token, *, actor='human'):
        from .verification import begin
        return begin(self, session, ident, version, token, actor)

    def apply(self, session, ident, version, token, *, actor='human'):
        from .integration import apply
        return apply(self, session, ident, version, token, actor)

    def rollback(self, session, ident, version, apply_id, *, actor='human'):
        from .integration import rollback
        return rollback(self, session, ident, version, apply_id, actor)

    def terminated(self, ident, version, *, confirmed, guard=None):
        def terminal(t):
            # Reconciliation rechecks the owner while holding the task lock.
            # A stale read cannot terminate a newly started verifier or worker.
            require(guard is None or guard(t), 'TERMINATION_OBSERVATION_STALE')
            require(t['status'] in ACTIVE | {'VERIFYING', 'CANCEL_REQUESTED', 'TERMINATION_UNKNOWN'}, 'STATE_CONFLICT')
            unknown = any(r['status'] in ('inflight', 'unknown') for r in t['requests'])
            t['process_status'] = 'PROCESS_TERMINATED' if confirmed else 'TERMINATION_UNKNOWN'
            t['status'] = 'PROCESS_TERMINATED' if confirmed and not unknown else 'TERMINATION_UNKNOWN'
            if (t.get('verification') or {}).get('status') == 'RUNNING':
                t['verification'].update(status='CANCELLED' if confirmed and not unknown else 'TERMINATION_UNKNOWN', finished_at=time.time())
        return self.store.update(ident, terminal, version=version, event='termination-recorded')
