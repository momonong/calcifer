#!/usr/bin/env python3
"""User-local installation with explicit official runtime preparation; no credential copying."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile

VERSION='0.1.4'
PAYLOAD_FILES={'launcher.py','smoke.py','install.py','wisp.ps1','wisp.cmd','README.md'}


def digest(data): return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o600):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,tmp=tempfile.mkstemp(prefix='.wisp-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chmod(tmp,mode); os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


def payload(source):
    manifest=json.loads((source/'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version') != VERSION: raise ValueError('安裝包版本不符。')
    files=manifest.get('files')
    if not isinstance(files,dict) or not {'launcher.py','install.py'}<=files.keys() or not files.keys()<=PAYLOAD_FILES:
        raise ValueError('安裝包檔案清單不符。')
    result={}
    for name,expected in files.items():
        path=source/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size>1024*1024:
            raise ValueError('安裝包包含不允許的檔案。')
        data=path.read_bytes()
        if digest(data)!=expected: raise ValueError(f'安裝包校驗失敗：{name}')
        result[name]=data
    return manifest,result


def main(argv=None):
    parser=argparse.ArgumentParser(description='安裝使用者層 Wisp 命令；保留原 Hermes。')
    parser.add_argument('--source',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--prefix',type=Path,default=Path.home()/'.local/share/wisp')
    parser.add_argument('--bin-dir',type=Path,default=Path.home()/'.local/bin')
    parser.add_argument('--config',type=Path,default=Path(os.environ.get('XDG_CONFIG_HOME',Path.home()/'.config'))/'wisp/config.json')
    parser.add_argument('--hermes',type=Path,help='既有官方 Hermes 執行檔')
    parser.add_argument('--hermes-home',type=Path,help='明確沿用已有 profile；不搬登入或設定')
    parser.add_argument('--desktop-data',type=Path)
    parser.add_argument('--webapp-dist',type=Path)
    args=parser.parse_args(argv)
    try:
        if os.name=='nt': raise ValueError('Windows 請使用同一封包的 install.ps1。')
        if sys.version_info<(3,10): raise ValueError('需要 Python 3.10 或更新版本。')
        manifest,files=payload(args.source.resolve())
        prefix=args.prefix.expanduser().absolute(); config=args.config.expanduser().absolute()
        binary=args.bin_dir.expanduser().absolute()/'wisp'
        existing_command=shutil.which('wisp')
        if existing_command and Path(existing_command).absolute()!=binary:
            raise ValueError(f'PATH 已有另一個 wisp 命令，已保留：{existing_command}')
        receipt_path=prefix/'install-receipt.json'
        for path in (prefix,config,binary,receipt_path):
            if path.is_symlink(): raise ValueError(f'不覆寫符號連結：{path}')
        receipt=json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        if binary.exists() and (receipt.get('command')!=str(binary) or receipt.get('command_sha256')!=digest(binary.read_bytes())):
            raise ValueError(f'同名命令不是未修改的 Wisp 安裝產物，已保留：{binary}')
        existing=None
        if config.exists():
            if not config.is_file() or config.stat().st_size>65536:
                raise ValueError('既有 Wisp 設定無效，已保留。')
            existing=json.loads(config.read_text(encoding='utf-8'))
            if not isinstance(existing,dict) or existing.get('schema_version')!=1:
                raise ValueError('既有 Wisp 設定版本不支援，已保留。')
            for key in ('hermes','hermes_home','desktop_data','webapp_dist'):
                value=existing.get(key)
                if key=='webapp_dist' and value is None: continue
                if not isinstance(value,str) or not value or not Path(value).is_absolute():
                    raise ValueError(f'既有 Wisp 設定 {key} 不是絕對路徑，已保留。')
        found=args.hermes or (existing['hermes'] if existing else shutil.which('hermes'))
        if not found: raise ValueError('先安裝官方 Hermes：https://hermes-agent.nousresearch.com/docs/getting-started/installation')
        engine=Path(found).expanduser().absolute()
        if not engine.is_file() or not os.access(engine,os.X_OK): raise ValueError('Hermes 執行檔不存在或不可執行。')
        home=args.hermes_home.expanduser().absolute() if args.hermes_home else Path(existing['hermes_home']) if existing else prefix/'hermes'
        desktop=args.desktop_data.expanduser().absolute() if args.desktop_data else Path(existing['desktop_data']) if existing else prefix/'desktop'
        saved_dist=existing.get('webapp_dist') if existing else None
        dist=args.webapp_dist.expanduser().absolute() if args.webapp_dist else Path(saved_dist) if saved_dist else None
        if (args.hermes_home or existing) and not home.is_dir(): raise ValueError('指定沿用的 Hermes home 不存在。')
        create_profile=existing is None and not args.hermes_home
        if create_profile and (home.is_symlink() or home.exists()):
            raise ValueError('預設 Wisp home 已存在且尚未由此設定管理；請明確指定 --hermes-home 沿用，或選擇新的 --prefix。')
        if dist and not (dist/'index.html').is_file(): raise ValueError('指定的 Webapp 成品不存在。')
        intended={'schema_version':1,'hermes':str(engine),'hermes_home':str(home),
                  'desktop_data':str(desktop),'webapp_dist':str(dist) if dist else None}
        if existing is not None:
            if 'desktop' in existing: intended['desktop']=existing['desktop']
            if existing!=intended: raise ValueError(f'已有不同設定，已保留；請先審閱 {config}')
        canonical=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
        release=prefix/'releases'/f'{VERSION}-{digest(canonical)[:16]}'
        if release.is_symlink(): raise ValueError('Release 不得為符號連結。')
        if release.exists():
            if any(not (release/n).is_file() or (release/n).is_symlink() or (release/n).read_bytes()!=data for n,data in files.items()):
                raise ValueError('已安裝 release 有修改，已保留；不覆寫。')
        else:
            release.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            stage=Path(tempfile.mkdtemp(prefix='.staging-',dir=release.parent))
            try:
                for name,data in files.items(): atomic(stage/name,data)
                atomic(stage/'manifest.json',json.dumps(manifest,indent=2).encode())
                stage.rename(release)
            finally:
                if stage.exists(): shutil.rmtree(stage)
        # Validate the actual candidate entry before moving the working pointer.
        # --version deliberately bypasses Hermes, networking, and profile access.
        probe=subprocess.run([sys.executable,'-B',str(release/'launcher.py'),'--version'],
                             capture_output=True,text=True,timeout=15)
        if probe.returncode or probe.stdout.strip()!=f'Wisp {VERSION}':
            raise ValueError('候選啟動器無法通過版本檢查；既有命令與設定未切換。')
        if create_profile:
            home.mkdir(parents=True,exist_ok=True,mode=0o700)
            if not (home/'config.yaml').exists():
                # JSON is also valid YAML. Never edit an existing Hermes config.
                defaults={'webapp':{'enabled':True,'host':'127.0.0.1','port':18767},
                          'auxiliary':{'background_review':{'enabled':False}},
                          'agent':{'max_turns':20}}
                atomic(home/'config.yaml',(json.dumps(defaults,indent=2)+'\n').encode())
        desktop.mkdir(parents=True,exist_ok=True,mode=0o700)
        if not config.exists(): atomic(config,(json.dumps(intended,indent=2,ensure_ascii=False)+'\n').encode())
        shim=('#!/bin/sh\n# Wisp managed command; ownership is checked against its receipt.\n'
              f'WISP_CONFIG={shlex.quote(str(config))} exec {shlex.quote(sys.executable)} -B {shlex.quote(str(release/"launcher.py"))} "$@"\n').encode()
        atomic(binary,shim,0o755)
        receipt={'version':VERSION,'release':str(release),'command':str(binary),
                 'command_sha256':digest(shim),'config':str(config),'manifest_sha256':digest(canonical)}
        atomic(receipt_path,(json.dumps(receipt,indent=2)+'\n').encode())
        if create_profile:
            print('準備新 Wisp profile 與官方 Webapp；首次需要下載鎖定依賴。',flush=True)
            prepared=subprocess.run([str(binary),'prepare'])
            if prepared.returncode:
                print('Wisp 命令已保留，但首次準備未完成。查看上方原因後，再執行 wisp prepare。',file=sys.stderr)
                return prepared.returncode
        elif existing is not None:
            print('已沿用既有 profile 與設定；重裝不呼叫 Hermes、不重建依賴。需要修復時請明確執行 wisp prepare。')
        print(f'Wisp {VERSION} 已安裝：{binary}\n設定：{config}\n執行 wisp doctor，再輸入 wisp 開啟介面。')
        if str(binary.parent) not in os.environ.get('PATH','').split(os.pathsep):
            print(f'目前 PATH 未包含 {binary.parent}；可直接執行 {shlex.quote(str(binary))}，或將該目錄加入自己的 PATH。')
        return 0
    except (OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as exc:
        print(f'Wisp 安裝停止：{exc}',file=sys.stderr); return 1


if __name__=='__main__': raise SystemExit(main())
