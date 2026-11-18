#!/usr/bin/env python3
"""Install the optional Wisp workflow plugin into one explicit Hermes home.

No model calls, config/auth edits, enable switches, global packages or network
fallback. Runtime preparation reuses the local npm cache with a committed lock.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid

SOURCE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location('wisp_platform_support', SOURCE/'extensions/core/platform_support.py')
support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(support)


def safe_directory(path):
    path = Path(path).absolute()
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('SYMLINK_DESTINATION_REFUSED')
    return path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def files(root):
    result = {}
    for path in sorted(Path(root).rglob('*')):
        if path.is_symlink():
            raise ValueError('SYMLINK_PACKAGE_REFUSED')
        if '__pycache__' in path.parts or path.name == '.wisp-install.json':
            continue
        if path.is_file(): result[str(path.relative_to(root))] = digest(path)
    return result


def validate_runtime(runtime):
    runtime = safe_directory(runtime)
    modules = runtime/'node_modules'
    bun = modules/'bun/bin/bun.exe'
    sdk = modules/'@opencode/sdk/dist/index.js'
    config = {'bun':str(bun), 'sdk':str(sdk), 'bun_version':support.BUN_VERSION, 'opencode_version':support.SDK_VERSION}
    support.require_support(config, require_worker=False)
    if subprocess.check_output([str(bun),'--version'],text=True,timeout=10).strip() != '1.4.4':
        raise ValueError('PINNED_BUN_REQUIRED')
    return config


def prepare_runtime(home, *, cache=None):
    support.require_support(require_runtime=False)
    home = safe_directory(home)
    if not home.is_dir():
        raise ValueError('EXISTING_WISP_HOME_REQUIRED')
    parent = home / 'tools/wisp-opencode'
    key=digest(SOURCE/'runtime/package-lock.json')[:20]
    target=parent/key
    if target.exists():
        if digest(target/'package-lock.json') != digest(SOURCE/'runtime/package-lock.json'):
            raise ValueError('RUNTIME_LOCK_CHANGED')
        validate_runtime(target)
        return target
    npm=shutil.which('npm'); node=shutil.which('node')
    if not npm or not node: raise ValueError('NODE_NPM_REQUIRED')
    parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    stage=Path(tempfile.mkdtemp(prefix='.prepare-',dir=parent))
    try:
        for name in ('package.json','package-lock.json'):
            shutil.copy2(SOURCE/'runtime'/name,stage/name)
        argv=[npm,'ci','--offline','--ignore-scripts','--no-audit','--no-fund']
        if cache: argv += ['--cache',str(Path(cache).absolute())]
        subprocess.run(argv,cwd=stage,check=True,timeout=180)
        # npm scripts are disabled. Copy only the existing platform executable;
        # never invoke Bun's download fallback or an unpinned system runtime.
        platform=stage/'node_modules/@oven/bun-linux-x64/bin/bun'
        if sys.platform!='linux' or not platform.is_file():
            raise ValueError('LINUX_X64_RUNTIME_ONLY')
        target_bin=stage/'node_modules/bun/bin/bun.exe'
        shutil.copy2(platform,target_bin)
        validate_runtime(stage)
        os.rename(stage,target)
        return target
    finally:
        if stage.exists(): shutil.rmtree(stage)


def install(home, runtime):
    support.require_support(require_runtime=False)
    home=safe_directory(home)
    if not home.is_dir(): raise ValueError('EXISTING_WISP_HOME_REQUIRED')
    config=validate_runtime(runtime)
    import fcntl
    plugins=safe_directory(home/'plugins'); plugins.mkdir(exist_ok=True,mode=0o700)
    data=safe_directory(home/'plugin-data/wisp-core'); data.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=data/'install.lock'
    if lock.is_symlink(): raise ValueError('INSTALL_LOCK_SYMLINK')
    with lock.open('a') as handle:
        fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        database=data/'tasks.sqlite3'
        if database.exists():
            with sqlite3.connect(f'file:{database}?mode=ro',uri=True) as conn:
                tasks=[json.loads(row[0]) for row in conn.execute('SELECT body FROM tasks')]
            if any(t['status'] in ('RUNNING','WAITING_APPROVAL','VERIFYING','CANCEL_REQUESTED') for t in tasks):
                raise ValueError('ACTIVE_TASK_INSTALL_REFUSED')
            if any((t.get('integration') or {}).get('status') in ('APPLYING','ROLLING_BACK') for t in tasks):
                raise ValueError('ACTIVE_INTEGRATION_INSTALL_REFUSED')
        entry=safe_directory(plugins/'wisp-core')
        if entry.exists():
            receipt=entry/'.wisp-install.json'
            if not receipt.is_file() or json.loads(receipt.read_text()).get('files') != files(entry):
                raise ValueError('UNMANAGED_OR_MODIFIED_PLUGIN_REFUSED')
        config['worker']=str(entry/'executor/opencode-worker.mjs')
        stage=Path(tempfile.mkdtemp(prefix='.wisp-core-',dir=plugins))
        backup=None
        try:
            shutil.copytree(SOURCE/'extensions/core',stage,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','runtime.json'))
            (stage/'executor').mkdir()
            shutil.copy2(SOURCE/'executors/opencode-worker.mjs',stage/'executor/opencode-worker.mjs')
            (stage/'runtime.json').write_text(json.dumps(config,indent=2)+'\n')
            receipt={'schema':1,'installed_at':time.time(),'files':files(stage),'runtime':str(Path(runtime).absolute())}
            (stage/'.wisp-install.json').write_text(json.dumps(receipt,indent=2)+'\n')
            if entry.exists():
                backups=data/'install-backups'; backups.mkdir(exist_ok=True,mode=0o700)
                backup=backups/uuid.uuid4().hex
                os.rename(entry,backup)
            try: os.rename(stage,entry)
            except BaseException:
                if backup: os.rename(backup,entry)
                raise
        finally:
            if stage.exists(): shutil.rmtree(stage)
        return {'plugin':str(entry),'runtime':config,'backup':str(backup) if backup else None,
            'activation_changed':False,'config_modified':False,'model_requests':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hermes-home',required=True,type=Path)
    parser.add_argument('--runtime',type=Path,help='Already prepared, pinned runtime directory')
    parser.add_argument('--npm-cache',type=Path,help='Existing cache, used offline only')
    args=parser.parse_args()
    try:
        runtime=args.runtime or prepare_runtime(args.hermes_home,cache=args.npm_cache)
        print(json.dumps(install(args.hermes_home,runtime),indent=2))
    except ValueError as error:
        parser.exit(2, 'Wisp core: ' + str(error) + '\n')


if __name__=='__main__': main()
