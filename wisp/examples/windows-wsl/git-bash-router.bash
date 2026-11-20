#!/usr/bin/env bash
set -euo pipefail
HOME="$(cygpath -u "$USERPROFILE")"
export HOME
settings="$HOME/.config/wisp/git-bash.bash"
if [[ ! -r "$settings" ]]; then
    printf '%s\n' 'Wisp: the configured Git Bash desktop route is missing.' >&2
    exit 1
fi
source "$settings"
declare -F wisp >/dev/null || { printf '%s\n' 'Wisp: the configured Git Bash route did not define wisp.' >&2; exit 1; }
wisp "$@"
