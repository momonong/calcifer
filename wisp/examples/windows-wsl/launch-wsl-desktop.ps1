param()
$ErrorActionPreference = 'Stop'
$root = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Wisp'
$source = Join-Path $root 'engine-source'
$executable = Join-Path $source 'apps\desktop\release\win-unpacked\Hermes.exe'
$client = Join-Path $root 'desktop-wsl-client'
$origin = 'http://127.0.0.1:18769'
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw '找不到 Windows 原生 Wisp 應用程式。'
}
$env:WSL_UTF8 = '1'
# Keep one WSL client attached to the Wisp unit until the gateway stops.
# An otherwise idle distribution exits while its systemd user services are running.
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$hold = New-Object Diagnostics.ProcessStartInfo
$hold.FileName = $wsl
$hold.UseShellExecute = $false
$hold.CreateNoWindow = $true
$hold.Arguments = @(
    '-d Ubuntu --cd ~ --exec /usr/bin/flock -n -E 73 -F',
    '.local/share/wisp/desktop-gateway.lock',
    '/usr/bin/python3 -IB .config/wisp/hold-desktop-gateway.py'
) -join ' '
$lease = [Diagnostics.Process]::Start($hold)
try {
    $lines = @(& $wsl -d Ubuntu --cd '~' --exec .local/bin/wisp webapp --no-open 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw '無法啟動 Ubuntu 的 Wisp 後端。'
    }
    # Another desktop launch may already hold the lock.
    if ($lease.HasExited -and $lease.ExitCode -ne 73) {
        throw ('Wisp 的 WSL 連線已提前結束，退出碼 ' + $lease.ExitCode)
    }
} finally {
    $lease.Dispose()
}
$links = [regex]::Matches(($lines -join [char]10), '(?m)^\s*http://127\.0\.0\.1:18769/webapp/launch#ticket=([A-Za-z0-9_-]{43})(?:&[^\s]*)?\s*$')
if ($links.Count -ne 1) {
    throw 'WSL Wisp 未回傳 18769 的本機登入連結。'
}
Add-Type -AssemblyName System.Net.Http
$handler = [Net.Http.HttpClientHandler]::new()
$handler.UseProxy = $false
$handler.AllowAutoRedirect = $false
$http = [Net.Http.HttpClient]::new($handler)
$http.Timeout = [TimeSpan]::FromSeconds(10)
$request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Post, "$origin/webapp/window-session")
[void]$request.Headers.TryAddWithoutValidation('Origin', $origin)
[void]$request.Headers.TryAddWithoutValidation('X-Hermes-Window-Ticket', $links[0].Groups[1].Value)
try {
    $response = $http.SendAsync($request).GetAwaiter().GetResult()
    try {
        if (!$response.IsSuccessStatusCode) {
            throw ('18769 本機認證失敗，HTTP ' + [int]$response.StatusCode)
        }
        $token = ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).token
        if ($token -notmatch '^[A-Za-z0-9_-]{43}$') { throw '18769 回傳的本機認證格式不符。' }
    } finally {
        $response.Dispose()
    }
} finally {
    $request.Dispose()
    $http.Dispose()
}

$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $executable
$start.WorkingDirectory = Split-Path $executable
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
foreach ($name in @($start.EnvironmentVariables.Keys)) {
    if ($name -match '^(HERMES_DESKTOP_.*|HERMES_HOME|HERMES_PROFILE(_NAME)?|HERMES_CONFIG|HERMES_ENV|HERMES_RUNTIME_DIR|HERMES_DATA_DIR_SUFFIX|HERMES_WEB(APP)?_DIST|ELECTRON_RUN_AS_NODE)$') {
        $start.EnvironmentVariables.Remove($name)
    }
}
$start.EnvironmentVariables['HERMES_HOME'] = Join-Path $client 'hermes'
$start.EnvironmentVariables['HERMES_DESKTOP_USER_DATA_DIR'] = Join-Path $client 'desktop'
$start.EnvironmentVariables['HERMES_DESKTOP_HERMES_ROOT'] = $source
$start.EnvironmentVariables['HERMES_DESKTOP_REMOTE_URL'] = $origin
$start.EnvironmentVariables['HERMES_DESKTOP_REMOTE_TOKEN'] = $token
try {
    $process = [Diagnostics.Process]::Start($start)
    $process.Dispose()
} finally {
    $start.EnvironmentVariables.Remove('HERMES_DESKTOP_REMOTE_TOKEN')
    Remove-Variable token
}