"""Keep the Windows-launched WSL session open for the dedicated Wisp gateway."""
import hashlib
import os
from pathlib import Path
import select
import subprocess
import time

# Hermes names a standalone profile's service after its resolved home.
PROFILE_HOME = (Path.home() / '.local/share/wisp/hermes').resolve()
UNIT = 'hermes-gateway-' + hashlib.sha256(os.fsencode(PROFILE_HOME)).hexdigest()[:8] + '.service'
CTL = ['/usr/bin/systemctl', '--user']


def state():
    result = subprocess.check_output(
        [*CTL, 'show', UNIT, '--property=ActiveState,MainPID'], text=True
    )
    return dict(line.split('=', 1) for line in result.splitlines())


def hold_gateway():
    subprocess.run([*CTL, 'start', UNIT], check=True)
    stopped_since = None
    while True:
        props = state()
        pid = int(props['MainPID'])
        if props['ActiveState'] in {'inactive', 'failed'}:
            # A supervised restart can pass through inactive before the new PID appears.
            if stopped_since is None:
                stopped_since = time.monotonic()
            elif time.monotonic() - stopped_since >= 10:
                return
        else:
            stopped_since = None

        if not pid:
            time.sleep(1)
            continue
        try:
            fd = os.pidfd_open(pid)
        except ProcessLookupError:
            continue
        try:
            if int(state()['MainPID']) == pid:
                select.select([fd], [], [])
        finally:
            os.close(fd)


if __name__ == '__main__':
    hold_gateway()
