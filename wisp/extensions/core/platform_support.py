"""Read-only prerequisites shared by installation, GUI and execution.

Checking files is not an active kernel/user-namespace probe. Actual checks keep
the existing Linux isolation and may still report a host-policy failure.
"""
import json
import os
from pathlib import Path
import platform
import sys

BUN_VERSION = '1.4.4'
SDK_VERSION = '2.1.4'
ISOLATION = ('/usr/bin/unshare', '/usr/bin/bwrap', '/usr/bin/timeout')


def executable(path):
    return Path(path).is_file() and os.access(path, os.X_OK)


def assess(runtime=None, *, require_runtime=True, require_worker=True):
    issues = []
    def issue(code, message):
        issues.append({'code': code, 'message': message})
    platform_ok = sys.platform == 'linux'
    architecture_ok = platform.machine().lower() in ('x86_64', 'amd64')
    if not platform_ok:
        issue('EXECUTOR_PLATFORM_NOT_VERIFIED', 'Wisp 開發與離線驗收目前只支援 Linux；Windows 仍可使用 Hermes 聊天。')
    elif not architecture_ok:
        issue('EXECUTOR_ARCH_NOT_VERIFIED', 'Wisp 固定版執行環境目前只驗證 Linux x86_64。')
    missing = [path for path in ISOLATION if not executable(path)] if platform_ok and architecture_ok else []
    if missing:
        issue('CHECK_ISOLATION_UNAVAILABLE', '缺少可執行的隔離工具：' + '、'.join(missing) + '。不會改用無隔離模式。')
    runtime_ok = None
    if require_runtime:
        runtime_ok = False
        if runtime is None:
            issue('EXECUTOR_RUNTIME_MISSING', '尚未配置固定版 OpenCode／Bun 執行環境。')
        elif not isinstance(runtime, dict) or runtime.get('bun_version') != BUN_VERSION or runtime.get('opencode_version') != SDK_VERSION:
            issue('PINNED_RUNTIME_REQUIRED', f'需要固定版本 OpenCode {SDK_VERSION} 與 Bun {BUN_VERSION}。')
        else:
            try:
                bun, sdk = Path(runtime['bun']), Path(runtime['sdk'])
                if not bun.is_absolute() or not sdk.is_absolute() or not executable(bun) or not sdk.is_file():
                    raise FileNotFoundError
                if require_worker:
                    worker = Path(runtime['worker'])
                    if not worker.is_absolute() or not worker.is_file(): raise FileNotFoundError
                for path, version in ((bun, BUN_VERSION), (sdk, SDK_VERSION)):
                    if json.loads((path.resolve().parent.parent/'package.json').read_text()).get('version') != version:
                        raise ValueError
                runtime_ok = True
            except (KeyError, TypeError, OSError):
                issue('EXECUTOR_RUNTIME_MISSING', '固定版執行檔、SDK 或工作者檔案缺少／不可執行。請重新準備 Wisp 執行環境。')
            except (ValueError, AttributeError):
                issue('PINNED_RUNTIME_REQUIRED', '執行環境版本或套件資料不符合固定版本，請重新準備。')
    return {'ready': not issues, 'platform_supported': platform_ok and architecture_ok,
        'platform': sys.platform, 'architecture': platform.machine(),
        'isolation_tools_available': platform_ok and architecture_ok and not missing,
        'runtime_verified': runtime_ok, 'kernel_isolation_verified': False, 'issues': issues}


def require_ready(result):
    if not result['ready']:
        first = result['issues'][0]
        raise ValueError(first['code'] + ': ' + first['message'])
    return result


def require_support(runtime=None, **kwargs):
    return require_ready(assess(runtime, **kwargs))
