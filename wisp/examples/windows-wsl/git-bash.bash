unalias wisp 2>/dev/null || :
function wisp {
    if [[ $# -eq 0 ]]; then
        local wsl_launcher
        wsl_launcher=$(cygpath -w "$HOME/.config/wisp/launch-wsl-desktop.ps1") || return 1
        MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$wsl_launcher"
        return $?
    fi
    case "${1:-desktop}" in
        smoke)
            shift
            MSYS2_ARG_CONV_EXCL='*' wsl.exe -d Ubuntu --cd '~' --exec .local/bin/wisp smoke "$@"
            return $?
            ;;
        desktop)
            MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoLogo -NoProfile -Command '
                $ErrorActionPreference = "Stop"
                $root = Join-Path $env:LOCALAPPDATA "Wisp"
                $cfg = Get-Content -LiteralPath (Join-Path $root "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
                $source = Join-Path $root "engine-source"
                if ($cfg.schema_version -ne 1 -or -not (Test-Path -LiteralPath $cfg.hermes_home -PathType Container) -or -not (Test-Path -LiteralPath $source -PathType Container)) { throw "Invalid Wisp installation." }
                Get-ChildItem Env: | Where-Object Name -Match "^(HERMES_DESKTOP_.*|HERMES_PROFILE(_NAME)?|HERMES_CONFIG|HERMES_ENV|HERMES_RUNTIME_DIR|HERMES_DATA_DIR_SUFFIX|HERMES_WEB_DIST|ELECTRON_RUN_AS_NODE)$" | ForEach-Object { Remove-Item -LiteralPath ("Env:" + $_.Name) }
                $env:HERMES_HOME = $cfg.hermes_home
                $env:HERMES_DESKTOP_USER_DATA_DIR = $cfg.desktop_data
                $env:HERMES_WEBAPP_DIST = $cfg.webapp_dist
                $exe = Join-Path $source "apps\desktop\release\win-unpacked\Hermes.exe"
                if (Test-Path -LiteralPath $exe -PathType Leaf) {
                    & $cfg.hermes desktop --skip-build --hermes-root $source
                } else {
                    & $cfg.hermes desktop --hermes-root $source
                }
                exit $LASTEXITCODE
            '
            return $?
            ;;
        webapp) shift; set -- open "$@" ;;
    esac
    local wisp_base
    wisp_base=$(cygpath -u "$LOCALAPPDATA") || return 1
    command bash "$wisp_base/Wisp/bin/wisp" "$@"
}

wisp-wsl() {
    MSYS2_ARG_CONV_EXCL='*' wsl.exe -d Ubuntu --cd '~' --exec .local/bin/wisp desktop
}
