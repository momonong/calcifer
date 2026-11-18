"""Resolve this profile only; no changes to global config or credential files."""
import json
import re
from pathlib import Path

from .service import Service
from .executor import launch_worker, launch_verifier, reconcile
from .provider import available_sources
from .platform_support import assess

RUNTIME_FILE = Path(__file__).with_name('runtime.json')


def read_runtime():
    try:
        return json.loads(RUNTIME_FILE.read_text())
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        # An invalid configured runtime is distinct from a missing one. Read-only
        # task history remains available; execution reports a pinned-runtime error.
        return {}


def get_service():
    from hermes_constants import get_hermes_home
    profile_home = get_hermes_home()
    root = profile_home / 'plugin-data' / 'wisp-core'
    service = Service(root)
    service.verify_launch = lambda task: launch_verifier(service, task, hermes_home=profile_home)
    service.execution_support = lambda purpose: assess(read_runtime(), require_runtime=purpose == 'development')
    if read_runtime() is not None:
        service.launch = lambda task: launch_worker(service, task, read_runtime(), hermes_home=profile_home)
    return service


def snapshots(service, session, ident=None):
    values = [service.store.load(ident, session)] if ident else service.store.list(session)
    for value in values:
        reconcile(service, value)
    return service.snapshot(session, ident)


def current_session():
    from gateway.session_context import get_session_env
    session = get_session_env('HERMES_SESSION_ID')
    if not session:
        raise ValueError('請先在 Hermes 開啟並儲存這個對話，再交辦 Wisp 任務。')
    return session


def current_model():
    from hermes_cli.config import load_config_readonly
    model = (load_config_readonly() or {}).get('model', {})
    if not isinstance(model, dict) or model.get('provider') != 'openai-codex':
        raise ValueError('首個整合版本需明確選用 Hermes 的 ChatGPT／Codex 來源；其他來源尚未接入，不會自動改用。')
    return model.get('default') or model.get('name') or ''


def current_project():
    from agent.runtime_cwd import resolve_agent_cwd
    return str(resolve_agent_cwd())


def source_status():
    """Configuration is not an authentication or account-quota probe."""
    provider=model=None;config_status='read'
    try:
        from hermes_cli.config import load_config_readonly
        config=load_config_readonly()
        value=config.get('model',{}) if isinstance(config,dict) else None
        if isinstance(value,dict):
            provider=value.get('provider');model=value.get('default') or value.get('name')
        else:config_status='unavailable'
    except (ImportError,ValueError,OSError):
        config_status='unavailable'
    def identifier(value):
        return value if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9._/-]{1,128}',value) else None
    return {'hermes_default':{'provider':identifier(provider),'model':identifier(model)},
        'config_status':config_status,'development_sources':available_sources(),
        'authentication_checked':False,'automatic_fallback':False}


def overview(service, session):
    return {'sources':{**source_status(),'executor':'OpenCode','capabilities':service.capabilities()},
        'usage':service.usage(session)}
