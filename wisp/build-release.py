#!/usr/bin/env python3
"""Deterministic public payload: explicit files only, no repository or profile data."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT=Path(__file__).resolve().parent
VERSION='0.1.3'
FILES=['launcher.py','install.py','wisp.ps1','wisp.cmd','README.md']

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--out',type=Path,required=True)
    out=parser.parse_args().out.resolve(); release=out/'releases'/VERSION
    release.mkdir(parents=True,exist_ok=True)
    payload={name:(ROOT/name).read_bytes() for name in FILES}
    manifest={'version':VERSION,'engine_baseline':{'version':'0.23.1','commit':'72c880370ff2e47dd587982ddded1b1ce90cfde4'},
              'files':{name:hashlib.sha256(data).hexdigest() for name,data in payload.items()}}
    payload['manifest.json']=(json.dumps(manifest,indent=2,sort_keys=True)+'\n').encode()
    archive=release/f'wisp-{VERSION}.zip'
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for name,data in sorted(payload.items()):
            info=zipfile.ZipInfo(name,(2026,11,17,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644<<16; z.writestr(info,data)
    archive_sha=hashlib.sha256(archive.read_bytes()).hexdigest()
    for name in ('install.sh','install.ps1'):
        text=(ROOT/name).read_text().replace('__ZIP_SHA256__',archive_sha)
        if '__ZIP_SHA256__' in text: raise ValueError('unresolved archive hash')
        (out/name).write_text(text,encoding='utf-8',newline='\n')
    (out/'prepare-windows-engine.ps1').write_bytes((ROOT/'prepare-windows-engine.ps1').read_bytes())
    (out/'README.md').write_bytes(payload['README.md'])
    (release/'manifest.json').write_bytes(payload['manifest.json'])
    sums={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [archive,out/'install.sh',out/'install.ps1',out/'prepare-windows-engine.ps1',release/'manifest.json',out/'README.md']}
    (out/'SHA256SUMS').write_text(''.join(f'{h}  {p}\n' for p,h in sorted(sums.items())))
    print(json.dumps({'version':VERSION,'archive':str(archive),'sha256':archive_sha,'files':len(payload)},indent=2))

if __name__=='__main__': main()
