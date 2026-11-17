# Download, verify, and install Wisp into the current user's profile. No administrator access.
[CmdletBinding()]
param(
    [string]$Source = '',
    [string]$InstallRoot = $(Join-Path $env:LOCALAPPDATA 'Wisp'),
    [string]$HermesCommand = '',
    [string]$HermesHome = '',
    [string]$DesktopData = '',
    [string]$WebappDist = '',
    [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
$releaseVersion = '0.1.4'
$archiveUrl = 'https://momonong.me/sites/wisp/releases/0.1.4/wisp-0.1.4.zip'
$archiveSha = '__ZIP_SHA256__'
$temporary = $null
$utf8 = New-Object System.Text.UTF8Encoding($false)
function Write-Atomic([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $tmp = Join-Path $parent ('.wisp-' + [guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($tmp, $Text, $utf8)
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) }
        else { [IO.File]::Move($tmp, $Path) }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Assert-Regular([string]$Path) {
    if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing a symbolic link or reparse point: $Path"
    }
}
function Get-Sha([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
try {
    $InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
    $configFile = Join-Path $InstallRoot 'config.json'
    $receiptFile = Join-Path $InstallRoot 'install-receipt.json'
    $binDir = Join-Path $InstallRoot 'bin'
    $commandFile = Join-Path $binDir 'wisp.cmd'
    $bashCommandFile = Join-Path $binDir 'wisp'
    $resolvedCommand = Get-Command wisp -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolvedCommand -and [IO.Path]::GetFullPath($resolvedCommand.Source) -ne $commandFile) {
        throw "PATH already contains another wisp command. Preserved: $($resolvedCommand.Source)"
    }
    foreach ($path in @($InstallRoot,$configFile,$receiptFile,$binDir,$commandFile,$bashCommandFile)) { Assert-Regular $path }
    $receipt = if (Test-Path -LiteralPath $receiptFile) { Get-Content -LiteralPath $receiptFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
    if (Test-Path -LiteralPath $commandFile) {
        if (-not $receipt -or $receipt.command -ne $commandFile -or $receipt.command_sha256 -ne (Get-Sha $commandFile)) {
            throw "Existing wisp command is not an unchanged Wisp installation. Preserved: $commandFile"
        }
    }
    if (Test-Path -LiteralPath $bashCommandFile) {
        if (-not $receipt -or $receipt.bash_command -ne $bashCommandFile -or $receipt.bash_command_sha256 -ne (Get-Sha $bashCommandFile)) {
            throw "Existing Git Bash command is not an unchanged Wisp installation. Preserved: $bashCommandFile"
        }
    }
    $hasExistingConfig = Test-Path -LiteralPath $configFile
    $existing = $null
    if ($hasExistingConfig) {
        if (-not (Test-Path -LiteralPath $configFile -PathType Leaf) -or (Get-Item -LiteralPath $configFile).Length -gt 65536) { throw 'Existing Wisp config is invalid; preserved.' }
        $existing = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($existing -isnot [pscustomobject] -or $existing.schema_version -ne 1) { throw 'Existing Wisp config version is unsupported; preserved.' }
        foreach ($key in @('hermes','hermes_home','desktop_data','webapp_dist')) {
            $value = $existing.$key
            if ($key -eq 'webapp_dist' -and $null -eq $value) { continue }
            if ($value -isnot [string] -or -not $value -or -not [IO.Path]::IsPathRooted($value)) { throw "Invalid saved absolute path: $key" }
        }
        if (-not $HermesCommand) { $HermesCommand = $existing.hermes }
    }
    if (-not $HermesCommand) {
        $found = Get-Command hermes -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $HermesCommand = $found.Source }
    }
    if (-not $HermesCommand -or -not (Test-Path -LiteralPath $HermesCommand -PathType Leaf)) {
        throw 'Install official Hermes first: https://hermes-agent.nousresearch.com/docs/user-guide/windows-native'
    }
    $HermesCommand = [IO.Path]::GetFullPath($HermesCommand)
    $adoptedHome = [bool]$HermesHome
    $createProfile = -not $hasExistingConfig -and -not $adoptedHome
    if (-not $HermesHome) { $HermesHome = if ($hasExistingConfig) { $existing.hermes_home } else { Join-Path $InstallRoot 'hermes' } }
    if (-not $DesktopData) { $DesktopData = if ($hasExistingConfig) { $existing.desktop_data } else { Join-Path $InstallRoot 'desktop' } }
    if (-not $WebappDist -and $hasExistingConfig) { $WebappDist = $existing.webapp_dist }
    if (($adoptedHome -or $hasExistingConfig) -and -not (Test-Path -LiteralPath $HermesHome -PathType Container)) { throw 'Specified Hermes home does not exist.' }
    $HermesHome = [IO.Path]::GetFullPath($HermesHome)
    if ($createProfile) {
        Assert-Regular $HermesHome
        if (Test-Path -LiteralPath $HermesHome) {
            throw 'Default Wisp home already exists without a matching config. Use -HermesHome explicitly or choose a new InstallRoot.'
        }
    }
    $DesktopData = [IO.Path]::GetFullPath($DesktopData)
    if ($WebappDist) {
        $WebappDist = [IO.Path]::GetFullPath($WebappDist)
        if (-not (Test-Path -LiteralPath (Join-Path $WebappDist 'index.html') -PathType Leaf)) { throw 'Specified Webapp bundle is missing.' }
    }
    $intended = [ordered]@{ schema_version=1; hermes=$HermesCommand; hermes_home=$HermesHome; desktop_data=$DesktopData; webapp_dist=$(if ($WebappDist) { $WebappDist } else { $null }) }
    if ($hasExistingConfig) {
        foreach ($key in $intended.Keys) { if ($existing.$key -cne $intended[$key]) { throw "Different existing Wisp config preserved: $configFile" } }
    }
    if (-not $Source) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('wisp-install-' + [guid]::NewGuid().ToString('N'))
        [IO.Directory]::CreateDirectory($temporary) | Out-Null
        $zipPath = Join-Path $temporary 'wisp.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $zipPath
        if ((Get-Sha $zipPath) -ne $archiveSha) { throw 'Release archive SHA256 mismatch. Nothing was installed.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            $names = @($zip.Entries | ForEach-Object { $_.FullName })
            $allowed = @('launcher.py','install.py','wisp.ps1','wisp.cmd','README.md','manifest.json')
            if ($names.Count -ne $allowed.Count -or @($names | Select-Object -Unique).Count -ne $names.Count) { throw 'Unexpected archive entries.' }
            foreach ($entry in $zip.Entries) { if ($entry.FullName -notin $allowed -or $entry.Length -gt 1048576) { throw 'Unexpected archive entry.' } }
        } finally { $zip.Dispose() }
        $Source = Join-Path $temporary 'payload'
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $Source)
    }
    $manifestFile = Join-Path $Source 'manifest.json'
    Assert-Regular $manifestFile
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $names = @($manifest.files.PSObject.Properties.Name)
    $expected = @('launcher.py','install.py','wisp.ps1','wisp.cmd','README.md')
    if ($manifest.version -ne $releaseVersion -or $names.Count -ne $expected.Count) { throw 'Unexpected release manifest.' }
    foreach ($name in $names) {
        if ($name -notin $expected) { throw 'Unexpected manifest filename.' }
        $file = Join-Path $Source $name
        Assert-Regular $file
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -gt 1048576 -or (Get-Sha $file) -ne $manifest.files.$name) { throw "Payload verification failed: $name" }
    }
    $release = Join-Path $InstallRoot ('releases\' + $releaseVersion + '-' + (Get-Sha $manifestFile).Substring(0,16))
    Assert-Regular $release
    if (Test-Path -LiteralPath $release) {
        foreach ($name in $names) {
            $file = Join-Path $release $name
            Assert-Regular $file
            if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Sha $file) -ne $manifest.files.$name) { throw 'Installed release was modified; preserved.' }
        }
    } else {
        [IO.Directory]::CreateDirectory((Split-Path -Parent $release)) | Out-Null
        $stage = $release + '.staging-' + [guid]::NewGuid().ToString('N')
        [IO.Directory]::CreateDirectory($stage) | Out-Null
        foreach ($name in $names) { Copy-Item -LiteralPath (Join-Path $Source $name) -Destination (Join-Path $stage $name) }
        Copy-Item -LiteralPath $manifestFile -Destination (Join-Path $stage 'manifest.json')
        [IO.Directory]::Move($stage, $release)
    }
    # Parse and run the candidate's version-only entry before replacing a usable command.
    # This path bypasses Hermes, network access, and profile state.
    $prepareShell = (Get-Process -Id $PID).Path
    $candidateEntry = (Join-Path $release 'wisp.ps1').Replace("'", "''")
    # Windows PowerShell 5.1 sends first-use module progress to stderr as CLIXML.
    # Suppress only progress in this child; actual stderr and exit checks stay strict.
    $probeScript = "`$ProgressPreference = 'SilentlyContinue'; & '$candidateEntry' version"
    $probeEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($probeScript))
    $probe = New-Object System.Diagnostics.Process
    $probe.StartInfo.FileName = $prepareShell
    $probe.StartInfo.Arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $probeEncoded
    $probe.StartInfo.UseShellExecute = $false
    $probe.StartInfo.CreateNoWindow = $true
    $probe.StartInfo.RedirectStandardOutput = $true
    $probe.StartInfo.RedirectStandardError = $true
    $probeStarted = $false
    try {
        $probeStarted = $probe.Start()
        if (-not $probeStarted) { throw 'Candidate version check could not start.' }
        # Drain both pipes concurrently so a noisy failed candidate cannot block exit.
        $probeStdout = $probe.StandardOutput.ReadToEndAsync()
        $probeStderr = $probe.StandardError.ReadToEndAsync()
        if (-not $probe.WaitForExit(15000)) {
            throw 'Candidate version check timed out after 15 seconds. Existing command and config were not switched.'
        }
        if (-not $probeStdout.Wait(1000) -or -not $probeStderr.Wait(1000)) {
            throw 'Candidate output did not finish. Existing command and config were not switched.'
        }
        $probeOutput = $probeStdout.Result + $probeStderr.Result
        if ($probe.ExitCode -ne 0 -or $probeOutput.Trim() -cne "Wisp $releaseVersion") { throw 'Candidate entry failed its version check. Existing command and config were not switched.' }
    } finally {
        try {
            if ($probeStarted -and -not $probe.HasExited) {
                try { $probe.Kill() }
                catch { if (-not $probe.HasExited) { throw 'Candidate probe termination is unconfirmed. Existing command and config were not switched; inspect before retrying.' } }
                if (-not $probe.WaitForExit(5000)) { throw 'Candidate probe termination is unconfirmed. Existing command and config were not switched; inspect before retrying.' }
            }
        } finally { $probe.Dispose() }
    }
    if ($createProfile) {
        [IO.Directory]::CreateDirectory($HermesHome) | Out-Null
        $homeConfig = Join-Path $HermesHome 'config.yaml'
        if (-not (Test-Path -LiteralPath $homeConfig)) {
            Write-Atomic $homeConfig '{"webapp":{"enabled":true,"host":"127.0.0.1","port":18767},"auxiliary":{"background_review":{"enabled":false}},"agent":{"max_turns":20}}'
        }
    }
    [IO.Directory]::CreateDirectory($DesktopData) | Out-Null
    if (-not (Test-Path -LiteralPath $configFile)) { Write-Atomic $configFile ($intended | ConvertTo-Json) }
    # Paths inside a .cmd line must not introduce expansion or extra lines.
    if ($configFile -match '[%\r\n"]' -or $release -match '[%\r\n"]') { throw 'Install path contains unsupported command-shell characters.' }
    # Keep the .cmd itself ASCII: cmd.exe's code page must not corrupt a Unicode user path.
    $releaseName = Split-Path -Leaf $release
    $shim = "@echo off`r`nsetlocal DisableDelayedExpansion`r`nset `"WISP_CONFIG=%~dp0..\config.json`"`r`npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"%~dp0..\releases\$releaseName\wisp.ps1`" %*`r`nexit /b %errorlevel%`r`n"
    Write-Atomic $commandFile $shim
    # Git Bash resolves this extensionless entry. Both shells use one installation.
    $bashShim = @'
#!/usr/bin/env bash
set -euo pipefail
wisp_bin="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
wisp_config="$(cygpath -w "$wisp_bin/../config.json")"
wisp_entry="$(cygpath -w "$wisp_bin/../releases/@@RELEASE@@/wisp.ps1")"
export WISP_CONFIG="$wisp_config"
exec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$wisp_entry" "$@"
'@
    Write-Atomic $bashCommandFile ($bashShim.Replace('@@RELEASE@@', $releaseName).Replace("`r`n", "`n") + "`n")
    $newReceipt = @{version=$releaseVersion; release=$release; command=$commandFile; command_sha256=(Get-Sha $commandFile); bash_command=$bashCommandFile; bash_command_sha256=(Get-Sha $bashCommandFile); config=$configFile; manifest_sha256=(Get-Sha $manifestFile)}
    Write-Atomic $receiptFile ($newReceipt | ConvertTo-Json)
    if ($createProfile) {
        Write-Output 'Preparing the new Wisp profile and official Webapp. First run may download pinned dependencies.'
        $priorWispConfig = $env:WISP_CONFIG
        try {
            $env:WISP_CONFIG = $configFile
            & $prepareShell -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $release 'wisp.ps1') prepare
            if ($LASTEXITCODE -ne 0) { throw 'Wisp command is installed but setup is incomplete. Resolve the error above, then run wisp prepare.' }
        } finally { $env:WISP_CONFIG = $priorWispConfig }
    } elseif ($hasExistingConfig) {
        Write-Output 'Existing profile and config reused. Reinstall does not call Hermes or rebuild dependencies. Run wisp prepare explicitly if needed.'
    }
    if (-not $NoPath) {
        $userPath = [string][Environment]::GetEnvironmentVariable('Path','User')
        if (@($userPath -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $binDir.TrimEnd('\')) {
            [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $binDir).TrimStart(';'), 'User')
        }
        if (@($env:Path -split ';') -notcontains $binDir) { $env:Path += ';' + $binDir }
    }
    Write-Output "Wisp $releaseVersion installed at $commandFile"
    Write-Output 'Open a new terminal, run wisp doctor, then wisp. If the Webapp bundle is missing, run wisp prepare once.'
} catch {
    Write-Error ("Wisp install stopped: " + $_.Exception.Message) -ErrorAction Continue
    exit 1
} finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
