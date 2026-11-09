#!/usr/bin/env python3
"""One app-only, compare-and-swap ingress change. Run in a private sudo TTY.

Never print the current Caddy configuration or authentication material. Preserve
an operation receipt before replacing bytes; UNKNOWN requires readback, no replay.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

CONFIG = Path('/etc/caddy/Caddyfile')
MARKER = '\thandle {\n\t\trespond "Not found" 404\n\t}\n'

def sha(data):
    return hashlib.sha256(data).hexdigest()

def candidate(original, fragment):
    text = original.decode('utf-8')
    if '/calcifer' in text or text.count(MARKER) != 1:
        raise RuntimeError('ROUTE_ALREADY_PRESENT_OR_LAYOUT_CHANGED')
    if not text.startswith('http://:18080 {\n\tbind 127.0.0.1\n'):
        raise RuntimeError('GATEWAY_LISTENER_CHANGED')
    block = fragment.decode('utf-8').rstrip() + '\n\n'
    result = text.replace(MARKER, block + MARKER, 1).encode()
    if result.replace(block.encode(), b'', 1) != original:
        raise RuntimeError('UNRELATED_BYTES_CHANGED')
    return result

def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--expected-sha', required=True)
    parser.add_argument('--operation', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 or not re.fullmatch('[a-f0-9]{64}', args.expected_sha) or not re.fullmatch('[a-f0-9-]{36}', args.operation):
        raise RuntimeError('ROOT_AND_EXACT_OPERATION_REQUIRED')
    root = Path('/var/backups/calcifer-remote')
    root.mkdir(mode=0o700, exist_ok=True)
    receipt_dir = root / args.operation
    # A previous attempt, including UNKNOWN, is never silently repeated.
    receipt_dir.mkdir(mode=0o700)
    original = CONFIG.read_bytes()
    if sha(original) != args.expected_sha:
        raise RuntimeError('CADDY_CHANGED_REPLAN_REQUIRED')
    request = urllib.request.Request('http://127.0.0.1:18470/calcifer/health', headers={'Host':'workbench.example.com','X-Forwarded-Proto':'https'})
    with urllib.request.urlopen(request, timeout=5) as response:
        health = json.load(response)
    if health != {'service':'calcifer','ready':True}:
        raise RuntimeError('CALCIFER_NOT_READY')
    proposed = candidate(original, Path(__file__).with_name('calcifer.caddy').read_bytes())
    write_private(receipt_dir / 'Caddyfile.before', original)
    write_private(receipt_dir / 'Caddyfile.proposed', proposed)
    validation = subprocess.run(['/usr/bin/caddy','validate','--config',str(receipt_dir / 'Caddyfile.proposed'),'--adapter','caddyfile'],capture_output=True)
    write_private(receipt_dir / 'validation.log', validation.stdout + validation.stderr)
    if validation.returncode:
        raise RuntimeError('CADDY_VALIDATION_FAILED')
    receipt = {'operation':args.operation,'before':sha(original),'after':sha(proposed),'status':'PREPARED','scope':'/calcifer/ only'}
    write_private(receipt_dir / 'PREPARED.json', json.dumps(receipt).encode())
    if sha(CONFIG.read_bytes()) != args.expected_sha:
        raise RuntimeError('CADDY_CHANGED_REPLAN_REQUIRED')
    metadata = CONFIG.stat()
    stage = CONFIG.with_name('.calcifer-' + args.operation + '.Caddyfile')
    write_private(stage, proposed)
    os.chown(stage,metadata.st_uid,metadata.st_gid)
    os.chmod(stage,metadata.st_mode & 0o777)
    os.replace(stage,CONFIG)
    fd = os.open(CONFIG.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    write_private(receipt_dir / 'RELOAD_INTENT.json', json.dumps(receipt | {'status':'UNKNOWN'}).encode())
    reload = subprocess.run(['/usr/bin/systemctl','reload','caddy'],capture_output=True,timeout=30)
    write_private(receipt_dir / 'reload.log', reload.stdout + reload.stderr)
    if reload.returncode:
        raise RuntimeError('RELOAD_UNKNOWN_INSPECT_RECEIPT')
    write_private(receipt_dir / 'APPLIED.json', json.dumps(receipt | {'status':'APPLIED'}).encode())
    print(json.dumps({'status':'APPLIED','operation':args.operation,'after':sha(proposed),'scope':'/calcifer/ only'}))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        message = str(error)
        print(message if re.fullmatch('[A-Z_]{3,80}',message) else 'DEPLOYMENT_INCOMPLETE_INSPECT_PRIVATE_RECEIPT')
        raise SystemExit(1)
