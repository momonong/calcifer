# Prepare the pinned Hermes runtime alongside an older installation.
# Does not publish a global hermes command or copy authentication data.
[CmdletBinding()]
param(
    [string]$InstallRoot = $(Join-Path $env:LOCALAPPDATA 'Wisp'),
    [Parameter(Mandatory=$true)][string]$BootstrapPython,
    [string]$InstallerFile = ''
)
$ErrorActionPreference = 'Stop'
$commit = '72c880370ff2e47dd587982ddded1b1ce90cfde4'
$installerSha = '44bb5b021498c0bba95f77ac30b6c4676f3ffb7aa92ea48c731cd0940e941cdc'
$utf8 = New-Object Text.UTF8Encoding($false)
$savedEnvironment = @{}
$environmentKeys = @('HERMES_HOME','HERMES_PROFILE','HERMES_PROFILE_NAME','HERMES_CONFIG','HERMES_ENV','HERMES_RUNTIME_DIR')
try {
    foreach ($key in $environmentKeys) {
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $null, 'Process')
    }
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $data = Join-Path $InstallRoot 'hermes'
    $source = Join-Path $InstallRoot 'engine-source'
    $marker = Join-Path $InstallRoot 'engine-bootstrap.json'
    foreach ($p in @($InstallRoot,$data,$source,$marker)) {
        if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Refusing reparse point: $p" }
    }
    if (Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json')) { throw 'Wisp is already configured. Preserve it; inspect the configured engine before preparing another runtime.' }
    if (-not (Test-Path -LiteralPath $BootstrapPython -PathType Leaf)) { throw 'Bootstrap Python is missing. No existing Hermes installation was changed.' }
    $expected = [ordered]@{schema_version=1; commit=$commit; hermes_home=$data; source=$source}
    if (Test-Path -LiteralPath $marker) {
        $saved = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($key in $expected.Keys) { if ($saved.$key -cne $expected[$key]) { throw 'Existing engine preparation belongs to a different configuration; preserved.' } }
    } elseif ((Test-Path -LiteralPath $data) -or (Test-Path -LiteralPath $source)) {
        throw 'Existing unowned Hermes data or source directory preserved. No preparation started.'
    }
    [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
    if (-not $InstallerFile) {
        $InstallerFile = Join-Path $InstallRoot 'hermes-installer-pinned.ps1'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/NousResearch/hermes-agent/$commit/scripts/install.ps1" -OutFile $InstallerFile
    }
    if ((Get-FileHash -LiteralPath $InstallerFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $installerSha) { throw 'Official installer hash mismatch; no installer was executed.' }
    if (-not (Test-Path -LiteralPath $marker)) { [IO.File]::WriteAllText($marker, ($expected | ConvertTo-Json), $utf8) }
    [IO.Directory]::CreateDirectory($data) | Out-Null
    $config = Join-Path $data 'config.yaml'
    if (-not (Test-Path -LiteralPath $config)) {
        [IO.File]::WriteAllText($config, '{"webapp":{"enabled":true,"host":"127.0.0.1","port":18767},"auxiliary":{"background_review":{"enabled":false}},"agent":{"max_turns":20}}', $utf8)
    }
    $shell = (Get-Process -Id $PID).Path
    # The official products stage publishes to User PATH. Use only its
    # documented runtime stages, then the same launcher writer without PATH edits.
    foreach ($stage in @('prerequisites','repository','venv','python-deps')) {
        Write-Output "Preparing Wisp engine: $stage"
        & $shell -NoLogo -NoProfile -ExecutionPolicy Bypass -File $InstallerFile -Stage $stage -HermesHome $data -InstallDir $source -Commit $commit -Channel main -NonInteractive -SkipBrowser -SkipComputerUse
        if ($LASTEXITCODE -ne 0) { throw "Official stage $stage failed. Preparation files were retained; original Hermes was not changed." }
    }
    $env:HERMES_HOME = $data
    $writer = Join-Path $source 'hermes_cli\_launchers.py'
    & $BootstrapPython -I -B -X utf8 $writer (Join-Path $data 'bin')
    if ($LASTEXITCODE -ne 0) { throw 'Pinned engine launcher preparation failed; original Hermes was not changed.' }
    $engine = Join-Path $data 'bin\hermes.exe'
    if (-not (Test-Path -LiteralPath $engine)) { $engine = Join-Path $data 'bin\hermes.cmd' }
    if (-not (Test-Path -LiteralPath $engine -PathType Leaf)) { throw 'Pinned engine launcher was not created.' }
    Write-Output "Wisp engine prepared at $engine"
    Write-Output 'Original Hermes command, login, and User PATH were preserved. Install Wisp using this engine and Hermes home, then run wisp prepare.'
} catch {
    Write-Error ("Wisp engine preparation stopped: " + $_.Exception.Message) -ErrorAction Continue
    exit 1
} finally {
    foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
}
