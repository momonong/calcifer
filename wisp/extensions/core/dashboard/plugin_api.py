"""Mounted behind Hermes authentication and its profile-scoped plugin namespace."""
import hashlib
import importlib.util
from pathlib import Path
import sys
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

# Dashboard and agent loaders use different module names. State is in SQLite,
# workers are separately owned processes: neither depends on an in-process cache.
root = Path(__file__).resolve().parent.parent
name = '_wisp_api_' + hashlib.sha256(str(root).encode()).hexdigest()[:12]
if name not in sys.modules:
    spec = importlib.util.spec_from_file_location(name, root/'__init__.py', submodule_search_locations=[str(root)])
    package = importlib.util.module_from_spec(spec); sys.modules[name] = package; spec.loader.exec_module(package)
runtime = importlib.import_module(name + '.runtime')
get_service = runtime.get_service
router = APIRouter()


@router.get('/overview')
def overview(session_id: str = Query(min_length=1,max_length=256)):
    try:
        return runtime.overview(get_service(),session_id)
    except (ValueError,OSError) as error:
        raise HTTPException(status_code=409,detail=str(error)) from None


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    session_id: str = Field(min_length=1, max_length=256)
    task_id: str = Field(pattern='^[a-f0-9]{32}$')
    version: int = Field(ge=1, strict=True)
    action: Literal['approve','reject','revise','cancel','accept','check','preview_apply','apply','rollback','project_context','share_project','preview_verify','verify','record_note','update_note']
    feedback: str = Field(default='', max_length=8000)
    request_id: str = Field(default='', max_length=64)
    allow: StrictBool = False
    preview_token: str = Field(default='', max_length=64, pattern='^([a-f0-9]{64})?$')
    apply_id: str = Field(default='', max_length=32, pattern='^([a-f0-9]{32})?$')
    note_id: str = Field(default='', max_length=32, pattern='^([a-f0-9]{32})?$')
    note_kind: Literal['decision','todo'] = 'todo'
    note_text: str = Field(default='', max_length=1000)
    note_revision: int = Field(default=1, ge=1, strict=True)
    note_status: Literal['open','done','withdrawn'] = 'open'


@router.get('/tasks')
def tasks(session_id: str = Query(min_length=1,max_length=256)):
    return {'tasks':runtime.snapshots(get_service(),session_id)}


@router.get('/tasks/{task_id}')
def task(task_id: str, session_id: str = Query(min_length=1,max_length=256)):
    try:
        return runtime.snapshots(get_service(),session_id,task_id)
    except ValueError as error:
        raise HTTPException(status_code=409,detail=str(error)) from None


@router.post('/action')
def action(body: Action):
    service=get_service()
    try:
        args=(body.session_id,body.task_id,body.version)
        if body.action=='record_note':
            return service.record_note(*args,body.note_id,body.note_kind,body.note_text)
        if body.action=='update_note':
            return service.update_note(*args,body.note_id,body.note_revision,body.note_status)
        if body.action=='check':
            return service.decide_check(*args,body.request_id,body.allow)
        if body.action=='revise':
            return service.revise(*args,body.feedback)
        if body.action=='preview_apply':
            return service.preview_apply(*args)
        if body.action=='preview_verify':
            return service.preview_verify(*args)
        if body.action=='verify':
            return service.verify(*args,body.preview_token)
        if body.action=='apply':
            return service.apply(*args,body.preview_token)
        if body.action=='rollback':
            return service.rollback(*args,body.apply_id)
        if body.action=='share_project':
            return service.set_project_sharing(*args,body.allow)
        if body.action=='project_context':
            task=service.store.load(body.task_id,body.session_id)
            if task['approval_version']!=body.version:
                raise ValueError('VERSION_CONFLICT')
            return service.project_context(body.session_id,task['repo'])
        return getattr(service,body.action)(*args)
    except (ValueError,OSError) as error:
        raise HTTPException(status_code=409,detail=str(error)) from None
