#!/usr/bin/env python3
"""A small, explicit entry point into official Hermes Desktop or Webapp."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

VERSION = '0.1.4'
ENGINE_VERSIONS = ('0.23.1', '0.23.2')


def config_path() -> Path:
    if os.environ.get('WISP_CONFIG'):
        return Path(os.environ['WISP_CONFIG']).expanduser().resolve()
    if os.name == 'nt':
        return Path(os.environ.get('LOCALAPPDATA', Path.home()/'AppData/Local'))/'Wisp/config.json'
    return Path(os.environ.get('XDG_CONFIG_HOME', Path.home()/'.config'))/'wisp/config.json'


def load_config(path: Path) -> dict:
    if not path.is_file() or path.stat().st_size > 65536:
        raise ValueError(f'找不到有效的 Wisp 設定：{path}。請先執行安裝程式。')
    config = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(config, dict) or config.get('schema_version') != 1:
        raise ValueError('Wisp 設定版本不支援；不會改用全域 Hermes。')
    for key in ('hermes','hermes_home','desktop_data','webapp_dist'):
        value = config.get(key)
        if key == 'webapp_dist' and value is None:
            continue
        if not isinstance(value,str) or not value or not Path(value).is_absolute():
            raise ValueError(f'設定 {key} 必須是完整絕對路徑。')
    if not Path(config['hermes']).is_file():
        raise ValueError('找不到設定的 Hermes。請安裝官方 Hermes，再重新指定執行檔。')
    if not Path(config['hermes_home']).is_dir():
        raise ValueError('Wisp 專用 Hermes 資料目錄不存在；不會改用全域資料。')
    desktop=config.get('desktop')
    if desktop is not None:
        if not isinstance(desktop,dict): raise ValueError('desktop 設定必須是物件。')
        for key in ('executable','app','hermes_root','cwd'):
            value=desktop.get(key)
            if not isinstance(value,str) or not value or not Path(value).is_absolute():
                raise ValueError(f'desktop.{key} 必須是完整絕對路徑。')
        if not isinstance(desktop.get('version'),str) or not re.fullmatch(r'[0-9][0-9A-Za-z.+-]{0,63}',desktop['version']):
            raise ValueError('desktop.version 必須是明確的版本號。')
    return config


def engine_env(config: dict) -> dict:
    env=dict(os.environ)
    # Desktop overrides can replace the backend, renderer or authentication.
    # Only this installation's explicit desktop settings are restored below.
    for key in tuple(env):
        if key.startswith('HERMES_DESKTOP_'): env.pop(key)
    # Inherited profile/config overrides must not escape this installation.
    for key in ('HERMES_PROFILE','HERMES_PROFILE_NAME','HERMES_CONFIG','HERMES_ENV',
                'HERMES_RUNTIME_DIR','HERMES_WEB_DIST','ELECTRON_RUN_AS_NODE'):
        env.pop(key,None)
    env['HERMES_HOME']=config['hermes_home']
    env['HERMES_DESKTOP_USER_DATA_DIR']=config['desktop_data']
    env.pop('HERMES_WEBAPP_DIST',None)
    if config.get('webapp_dist'): env['HERMES_WEBAPP_DIST']=config['webapp_dist']
    return env


def open_desktop(config: dict) -> int:
    desktop=config.get('desktop')
    if not desktop: raise ValueError('尚未設定桌面入口；可使用 wisp webapp。')
    executable=Path(desktop['executable']); app=Path(desktop['app'])
    if not executable.is_file() or not os.access(executable,os.X_OK):
        raise ValueError('桌面執行檔不存在或不可執行；不會自動改用瀏覽器。')
    if not (app/'package.json').is_file() or not (app/'dist/electron-main.mjs').is_file():
        raise ValueError('桌面成品不完整；請恢復已驗證版本。')
    if not all(Path(desktop[k]).is_dir() for k in ('hermes_root','cwd')):
        raise ValueError('桌面引擎來源或工作目錄不存在。')
    env=engine_env(config)
    env['HERMES_DESKTOP_HERMES_ROOT']=desktop['hermes_root']
    env['HERMES_DESKTOP_CWD']=desktop['cwd']
    log_dir=Path(config['desktop_data'])/'logs'; log_dir.mkdir(parents=True,exist_ok=True,mode=0o700)
    log_path=log_dir/'wisp-desktop.log'
    flags=os.O_WRONLY|os.O_CREAT|os.O_APPEND|getattr(os,'O_NOFOLLOW',0)
    with os.fdopen(os.open(log_path,flags,0o600),'ab') as log:
        os.fchmod(log.fileno(),0o600)
        process=subprocess.Popen([str(executable),str(app)],cwd=desktop['cwd'],env=env,
                                 stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    try: code=process.wait(timeout=1)
    except subprocess.TimeoutExpired: code=None
    if code not in (None,0):
        print(f'Wisp：桌面程序啟動失敗（{code}），私人日誌：{log_path}',file=sys.stderr)
        return code if code>0 else 128-code
    print(f'已送出 Wisp 桌面啟動要求（Hermes {desktop["version"]}）；這不代表介面已完成載入。')
    return 0


def safe_output(text: str) -> str:
    # A failed browser launch can print a one-use credential. Keep it local unless
    # the person deliberately requested a terminal link with --no-open.
    return re.sub(r'https?://[^\s<>]+[?#][^\s<>]*',
                  '[私人啟動連結已隱藏；請在自己的終端執行 wisp --no-open]',text)


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(prog='wisp',description='開啟 Wisp：沿用 Hermes 的原生對話、工具與開發介面。')
    parser.add_argument('command',nargs='?',choices=['open','desktop','webapp','status','doctor','prepare','smoke'],default='open')
    parser.add_argument('--no-open',action='store_true',help='只在自己的終端顯示一次性登入連結；請勿分享')
    parser.add_argument('--offline',action='store_true',help='執行 smoke 的隔離離線案例')
    parser.add_argument('--version',action='version',version=f'Wisp {VERSION}')
    args=parser.parse_args(argv)
    if args.no_open and args.command not in ('open','webapp'): parser.error('--no-open 只用於開啟 Webapp')
    if args.command=='smoke' and not args.offline: parser.error('smoke 需要 --offline')
    if args.offline and args.command!='smoke': parser.error('--offline 只用於 smoke')
    try:
        path=config_path(); config=load_config(path)
        if args.command=='smoke':
            plugin=Path(config['hermes_home'])/'plugins/wisp-core'
            return subprocess.call([sys.executable,'-I','-B',str(Path(__file__).with_name('smoke.py')),str(plugin)])
        if args.command=='desktop' or (args.command=='open' and config.get('desktop') and not args.no_open):
            return open_desktop(config)
        if args.command in ('open','webapp','prepare'):
            dist=config.get('webapp_dist')
            if dist and not (Path(dist)/'index.html').is_file():
                raise ValueError('設定的 Webapp 成品不存在；請恢復該成品，不會修改原 Hermes 安裝。')
        if args.command=='prepare':
            env=engine_env(config)
            probe=subprocess.run([config['hermes'],'--version'],env=env,capture_output=True,
                                 text=True,encoding='utf-8',errors='replace',timeout=15)
            if probe.returncode and 'no dependency environment is committed' in probe.stdout+probe.stderr:
                print('首次準備這個 Wisp profile 的官方 Hermes 依賴；不搬動原登入。',flush=True)
                repair=subprocess.run([config['hermes'],'pm','repair'],env=env,capture_output=True,
                                      text=True,encoding='utf-8',errors='replace',timeout=1200)
                print(safe_output(repair.stdout+repair.stderr),end='')
                if repair.returncode: return repair.returncode
                probe=subprocess.run([config['hermes'],'--version'],env=env,capture_output=True,
                                     text=True,encoding='utf-8',errors='replace',timeout=15)
            if probe.returncode:
                print(safe_output(probe.stdout+probe.stderr),end=''); return probe.returncode
            if config.get('webapp_dist'):
                print('依賴可用，已指定預建的 Webapp，不需建置。'); return 0
            print('準備官方 Webapp 成品；首次可能下載依賴，請稍候。',flush=True)
        command={'open':['webapp','--skip-build'], 'webapp':['webapp','--skip-build'], 'status':['webapp','--status'],
                 'doctor':['--version'], 'prepare':['webapp','--build-only']}[args.command]
        if args.no_open: command.append('--no-open')
        result=subprocess.run([config['hermes'],*command],env=engine_env(config),
                              capture_output=True,text=True,encoding='utf-8',errors='replace',
                              timeout=15 if args.command=='doctor' else 1200 if args.command=='prepare' else 120)
        if args.command=='doctor':
            print(f'Wisp {VERSION}\n設定：{path}\nHermes 資料：{config["hermes_home"]}')
            desktop=config.get('desktop')
            print(f'預設入口：Desktop（Hermes {desktop["version"]}）' if desktop else '預設入口：Webapp')
            print('診斷只查版本與路徑，不啟動模型或變更登入。')
        output=result.stdout+result.stderr
        print(output if args.no_open else safe_output(output),end='' if output.endswith('\n') else '\n')
        if args.command=='doctor' and result.returncode==0:
            if not any(v in output for v in ENGINE_VERSIONS):
                print(f'此 Hermes 版本未列入實測範圍（{", ".join(ENGINE_VERSIONS)}）。',file=sys.stderr)
            if config.get('desktop') and config['desktop']['version'] not in output:
                print('桌面與後端版本不同；請先對齊版本再更新入口。',file=sys.stderr)
        return result.returncode
    except (ValueError,OSError) as exc:
        print(f'Wisp：{exc}',file=sys.stderr); return 1
    except subprocess.TimeoutExpired:
        print('Wisp：啟動狀態尚未確認。請先執行 wisp status；不自動重啟或重送工作。',file=sys.stderr)
        return 124


if __name__ == '__main__': raise SystemExit(main())
