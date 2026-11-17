#!/usr/bin/env bash
# Download first, verify SHA256, then install. No sudo or automatic Hermes updates.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  printf '%s\n' 'This installer targets Linux. Use install.ps1 for Windows.' >&2
  exit 1
fi
command -v python3 >/dev/null || { printf '%s\n' 'Python 3.10+ is required.' >&2; exit 1; }
command -v curl >/dev/null || { printf '%s\n' 'curl is required.' >&2; exit 1; }
wisp_stage="$(mktemp -d -t wisp-install-XXXXXXXX)"
trap 'rm -rf -- "$wisp_stage"' EXIT
curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  'https://momonong.me/sites/wisp/releases/0.1.4/wisp-0.1.4.zip' -o "$wisp_stage/wisp.zip"
python3 - "$wisp_stage" '__ZIP_SHA256__' <<'PY'
import hashlib, pathlib, sys, zipfile
root=pathlib.Path(sys.argv[1]); raw=(root/'wisp.zip').read_bytes()
if hashlib.sha256(raw).hexdigest()!=sys.argv[2]: raise SystemExit('Wisp archive SHA256 mismatch; nothing installed.')
allowed={'launcher.py','install.py','wisp.ps1','wisp.cmd','README.md','manifest.json'}
with zipfile.ZipFile(root/'wisp.zip') as z:
    if set(z.namelist())!=allowed or len(z.namelist())!=len(allowed): raise SystemExit('Unexpected Wisp archive entries.')
    if any(i.file_size>1024*1024 for i in z.infolist()): raise SystemExit('Oversized Wisp archive entry.')
    z.extractall(root/'payload')
PY
python3 -B "$wisp_stage/payload/install.py" "$@"
