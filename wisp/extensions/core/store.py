"""Profile-local transactional task state. No credentials or chat transcripts."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
import time


class Store:
    def __init__(self, root):
        self.root = Path(root).absolute()
        for path in (self.root, *self.root.parents):
            if path.is_symlink():
                raise ValueError('STATE_SYMLINK_REJECTED')
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = self.root / 'tasks.sqlite3'
        if self.db.is_symlink():
            raise ValueError('STATE_SYMLINK_REJECTED')
        with self.connection() as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT NOT NULL, body TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, task TEXT NOT NULL, at REAL NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS project_sharing (repo TEXT PRIMARY KEY, body TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS task_notes (task TEXT NOT NULL, note_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(task,note_id))')
        os.chmod(self.db, 0o600)

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.db, timeout=10, isolation_level=None)
        try:
            conn.execute('PRAGMA busy_timeout=10000')
            conn.execute('PRAGMA synchronous=FULL')
            conn.execute('BEGIN IMMEDIATE')
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
        finally:
            conn.close()

    def create(self, task):
        with self.connection() as conn:
            conn.execute('INSERT INTO tasks VALUES (?,?,?)', (task['objective_id'], task['session_id'], json.dumps(task)))
            self.event(conn, task['objective_id'], 'proposed', {'version': 1})

    @staticmethod
    def event(conn, ident, kind, data):
        conn.execute('INSERT INTO events(task,at,kind,body) VALUES (?,?,?,?)', (ident, time.time(), kind, json.dumps(data)))

    @staticmethod
    def _load(conn, ident, session=None):
        row = conn.execute('SELECT session,body FROM tasks WHERE id=?', (ident,)).fetchone()
        if not row:
            raise ValueError('TASK_NOT_FOUND')
        if session is not None and row[0] != session:
            raise ValueError('SESSION_MISMATCH')
        return json.loads(row[1])

    def load(self, ident, session=None):
        with self.connection() as conn:
            return self._load(conn, ident, session)

    def update(self, ident, change, *, session=None, version=None, event=None):
        with self.connection() as conn:
            task = self._load(conn, ident, session)
            if version is not None and task['approval_version'] != version:
                raise ValueError('VERSION_CONFLICT')
            change(task)
            task['updated_at'] = time.time()
            conn.execute('UPDATE tasks SET body=? WHERE id=?', (json.dumps(task), ident))
            if event:
                self.event(conn, ident, event, {'version': task['approval_version'], 'status': task['status']})
            return task

    def list(self, session):
        with self.connection() as conn:
            rows = conn.execute('SELECT body FROM tasks WHERE session=? ORDER BY rowid DESC LIMIT 50', (session,)).fetchall()
            return [json.loads(row[0]) for row in rows]

    def events(self, ident, session):
        with self.connection() as conn:
            self._load(conn, ident, session)
            return [dict(seq=r[0], at=r[1], kind=r[2], data=json.loads(r[3])) for r in conn.execute(
                'SELECT seq,at,kind,body FROM events WHERE task=? ORDER BY seq DESC LIMIT 80', (ident,)).fetchall()][::-1]

    def notes(self, ident, session):
        with self.connection() as conn:
            self._load(conn, ident, session)
            return [json.loads(row[0]) for row in conn.execute('SELECT body FROM task_notes WHERE task=? ORDER BY rowid', (ident,))]

    def change_note(self, ident, session, version, note_id, change, event):
        with self.connection() as conn:
            task = self._load(conn, ident, session)
            if task['approval_version'] != version: raise ValueError('VERSION_CONFLICT')
            row = conn.execute('SELECT body FROM task_notes WHERE task=? AND note_id=?', (ident, note_id)).fetchone()
            old = json.loads(row[0]) if row else None
            previous_status = old['status'] if old else None
            value = change(task, old)
            body = json.dumps(value)
            if row and body == row[0]: return value
            if not row:
                count = conn.execute('SELECT count(*) FROM task_notes WHERE task=?', (ident,)).fetchone()[0]
                if count >= 32: raise ValueError('NOTE_LIMIT')
            conn.execute('INSERT INTO task_notes VALUES (?,?,?) ON CONFLICT(task,note_id) DO UPDATE SET body=excluded.body', (ident, note_id, body))
            self.event(conn, ident, event, {'version': version, 'note_id': note_id, 'note_revision': value['revision'],
                'status': value['status'], 'previous_status': previous_status, 'channel': value['last_updated_source']['channel']})
            return value

    def usage_rows(self, session):
        # All of this session's history, not just the most recent 50 cards.
        # Project files, prompts, auth and other conversations are not selected.
        with self.connection() as conn:
            return conn.execute("SELECT json_extract(body,'$.provider'), json_extract(body,'$.model'), "
                "json_extract(body,'$.status'), json_extract(body,'$.requests_used'), json_extract(body,'$.requests') "
                "FROM tasks WHERE session=?", (session,)).fetchall()

    def append(self, ident, kind, data):
        with self.connection() as conn:
            self._load(conn, ident)
            self.event(conn, ident, kind, data)

    def project(self, repo, session):
        with self.connection() as conn:
            row = conn.execute('SELECT body FROM project_sharing WHERE repo=?', (repo,)).fetchone()
            sharing = json.loads(row[0]) if row else {'enabled': False, 'source': None}
            rows = conn.execute("SELECT body FROM tasks WHERE json_extract(body,'$.repo')=? AND (? OR session=?) "
                "ORDER BY json_extract(body,'$.updated_at') DESC LIMIT 21", (repo, sharing['enabled'], session)).fetchall()
            return sharing, [json.loads(row[0]) for row in rows[:20]], len(rows) > 20

    def set_project_sharing(self, ident, session, version, enabled, actor):
        with self.connection() as conn:
            task = self._load(conn, ident, session)
            if task['approval_version'] != version:
                raise ValueError('VERSION_CONFLICT')
            sharing = {'enabled': enabled, 'actor': actor, 'updated_at': time.time(),
                'source': {**task['source'], 'objective_id': ident, 'approval_version': version}}
            conn.execute('INSERT INTO project_sharing VALUES (?,?) ON CONFLICT(repo) DO UPDATE SET body=excluded.body',
                (task['repo'], json.dumps(sharing)))
            self.event(conn, ident, 'project-sharing-changed', {'enabled': enabled, 'actor': actor, 'version': version})
            return task['repo']
