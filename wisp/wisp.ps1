# Wisp Windows entry point. PowerShell 5.1+; no profile scripts are loaded by wisp.cmd.
[CmdletBinding()]
param(
    [ValidateSet('open','status','doctor','prepare','version','help')]
    [string]$Command = 'open',
    [switch]$NoOpen,
    [switch]$Version
)
$ErrorActionPreference = 'Stop'
$wispVersion = '0.1.4'
if ($Version -or $Command -eq 'version') { Write-Output "Wisp $wispVersion"; exit 0 }
if ($Command -eq 'help') { Write-Output 'wisp [open|status|doctor|prepare|version] [-NoOpen]'; exit 0 }
if ($NoOpen -and $Command -ne 'open') { Write-Error '-NoOpen requires open'; exit 2 }
$saved = @{}
$keys = @('HERMES_HOME','HERMES_DESKTOP_USER_DATA_DIR','HERMES_WEBAPP_DIST','HERMES_PROFILE','HERMES_PROFILE_NAME','HERMES_CONFIG','HERMES_ENV','HERMES_RUNTIME_DIR')
try {
    $configFile = if ($env:WISP_CONFIG) { $env:WISP_CONFIG } else { Join-Path $env:LOCALAPPDATA 'Wisp\config.json' }
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf) -or (Get-Item -LiteralPath $configFile).Length -gt 65536) {
        throw 'Wisp config is missing or invalid. Run the Wisp installer first.'
    }
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.schema_version -ne 1) { throw 'Unsupported config version. Global Hermes will not be used.' }
    foreach ($key in @('hermes','hermes_home','desktop_data')) {
        if (-not $config.$key -or -not [IO.Path]::IsPathRooted($config.$key)) { throw "Invalid absolute path: $key" }
    }
    if (-not (Test-Path -LiteralPath $config.hermes -PathType Leaf)) { throw 'Configured Hermes executable is missing.' }
    if (-not (Test-Path -LiteralPath $config.hermes_home -PathType Container)) { throw 'Wisp Hermes home is missing.' }
    if ($config.webapp_dist -and (-not [IO.Path]::IsPathRooted($config.webapp_dist) -or
        -not (Test-Path -LiteralPath (Join-Path $config.webapp_dist 'index.html') -PathType Leaf))) { throw 'Configured Webapp bundle is missing.' }
    foreach ($key in $keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $env:HERMES_HOME = $config.hermes_home
    $env:HERMES_DESKTOP_USER_DATA_DIR = $config.desktop_data
    if ($config.webapp_dist) { $env:HERMES_WEBAPP_DIST = $config.webapp_dist }
    if ($Command -eq 'prepare') {
        $probePreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $probeOutput = @(& $config.hermes --version 2>&1)
            $probeExit = $LASTEXITCODE
            if ($probeExit -ne 0 -and ($probeOutput -join "`n") -match 'no dependency environment is committed') {
                Write-Output 'Preparing official dependencies for this Wisp profile. Existing login is preserved.'
                & $config.hermes pm repair 2>&1 | ForEach-Object {
                    Write-Output ([string]$_ -replace 'https?://[^\s<>]+[?#][^\s<>]*','[private URL hidden]')
                }
                if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
                $probeOutput = @(& $config.hermes --version 2>&1)
                $probeExit = $LASTEXITCODE
            }
        } finally { $ErrorActionPreference = $probePreference }
        if ($probeExit -ne 0) {
            Write-Output (($probeOutput -join "`n") -replace 'https?://[^\s<>]+[?#][^\s<>]*','[private URL hidden]')
            exit $probeExit
        }
        if ($config.webapp_dist) { Write-Output 'Runtime and prebuilt Webapp are ready.'; exit 0 }
        Write-Output 'Preparing the official Webapp. First run may download dependencies.'
    }
    [string[]]$engineArgs = switch ($Command) {
        'open' { @('webapp','--skip-build') }
        'status' { @('webapp','--status') }
        'doctor' { @('--version') }
        'prepare' { @('webapp','--build-only') }
    }
    if ($NoOpen) { $engineArgs += '--no-open' }
    if ($Command -eq 'doctor') {
        Write-Output "Wisp $wispVersion`nConfig: $configFile`nHermes home: $($config.hermes_home)"
        Write-Output 'Version and path checks only. No model request or login changes.'
    }
    # Call operator passes the fixed argument list without expression evaluation.
    $LASTEXITCODE = 0
    $nativePreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 wraps native stderr as ErrorRecord. Preserve
        # warning output and use the process exit code as the success signal.
        if ($PSVersionTable.PSVersion.Major -le 5) { $ErrorActionPreference = 'Continue' }
        & $config.hermes @engineArgs 2>&1 | ForEach-Object {
            $line = [string]$_
            if (-not $NoOpen) { $line = $line -replace 'https?://[^\s<>]+[?#][^\s<>]*', '[private launch link hidden; use wisp -NoOpen in your own terminal]' }
            Write-Output $line
        }
        $engineExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $nativePreference
    }
    if ($Command -eq 'doctor') { Write-Output 'Validated engine baseline: Hermes 0.23.1. Other versions require verification.' }
    exit $engineExit
} catch {
    $message = [string]$_.Exception.Message
    if (-not $NoOpen) { $message = $message -replace 'https?://[^\s<>]+[?#][^\s<>]*', '[private launch link hidden]' }
    Write-Error ("Wisp stopped: " + $message) -ErrorAction Continue
    exit 1
} finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
