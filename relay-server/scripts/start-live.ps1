[CmdletBinding()]
param(
  [switch]$SyntheticTest,
  [ValidateRange(30, 3600)] [int]$TestDurationSeconds = 180
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:OutputReaderLoaded = $false
$script:OutputHistory = @{}
$script:LastOriginError = 'Проверка ещё не выполнялась.'
$script:ExitCode = 0

function Ensure-OutputReaderType {
  if ($script:OutputReaderLoaded) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Collections.Generic;

namespace KuzmichRelayLauncher {
  public sealed class OutputReader {
    public readonly ConcurrentQueue<string> Stdout = new ConcurrentQueue<string>();
    public readonly ConcurrentQueue<string> Stderr = new ConcurrentQueue<string>();
    public OutputReader(Process process) {
      process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Stdout.Enqueue(e.Data); };
      process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) Stderr.Enqueue(e.Data); };
      process.BeginOutputReadLine();
      process.BeginErrorReadLine();
    }
  }
}
'@
  $script:OutputReaderLoaded = $true
}

function Write-Stage([string]$Text) { Write-Host ("[Kuzmich] " + $Text) }

function Get-CommandPath([string]$Name) {
  try { return (Get-Command $Name -ErrorAction Stop).Source }
  catch { return $null }
}

function Stop-ProcessTree([object]$Process) {
  if ($Process -is [System.Collections.IDictionary]) { $Process = $Process['Process'] }
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      & taskkill.exe /PID $Process.Id /T /F *> $null
      [void]$Process.WaitForExit(5000)
    }
  } catch { try { $Process.Kill() } catch {} }
}

function New-ProcessInfo([string]$FileName, [string]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment, [bool]$RedirectOutput = $true) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  # .cmd files are not PE executables; invoke npm through the Windows command host.
  if ($FileName -match '(?i)\.cmd$') {
    $info.FileName = $env:ComSpec
    # npm.cmd is resolved from PATH. Avoid /s quote normalization: it breaks
    # npm's prefix discovery under Windows PowerShell 5.1.
    $info.Arguments = '/d /c ' + $FileName + ' ' + $Arguments
  } else {
    $info.FileName = $FileName
    $info.Arguments = $Arguments
  }
  $info.WorkingDirectory = $WorkingDirectory
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $info.RedirectStandardOutput = $RedirectOutput
  $info.RedirectStandardError = $RedirectOutput
  if ($null -ne $Environment) {
    # Remove inherited project/secret switches before applying process-local values.
    $remove = @($info.EnvironmentVariables.Keys | Where-Object {
      $_ -like 'VITE_*' -or $_ -like 'RELAY_*' -or $_ -like 'TELEGRAM_BOT_*' -or $_ -eq 'NODE_OPTIONS'
    })
    foreach ($key in $remove) { [void]$info.EnvironmentVariables.Remove($key) }
    foreach ($entry in $Environment.GetEnumerator()) {
      if ($null -eq $entry.Value) { [void]$info.EnvironmentVariables.Remove([string]$entry.Key) }
      else { $info.EnvironmentVariables[[string]$entry.Key] = [string]$entry.Value }
    }
  }
  return $info
}

function Invoke-ShortProcess([string]$FileName, [string]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment) {
  $info = New-ProcessInfo $FileName $Arguments $WorkingDirectory $Environment $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) { throw "Не удалось запустить $FileName" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $process.WaitForExit()
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "Команда $FileName завершилась с кодом $($process.ExitCode): $stderr" }
  return @{ Output = $stdout; Error = $stderr }
}

function Start-ManagedProcess([string]$FileName, [string]$Arguments, [string]$WorkingDirectory, [hashtable]$Environment) {
  Ensure-OutputReaderType
  $info = New-ProcessInfo $FileName $Arguments $WorkingDirectory $Environment $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) { throw "Не удалось запустить $FileName" }
  $reader = New-Object -TypeName KuzmichRelayLauncher.OutputReader -ArgumentList $process
  return @{ Process = $process; Reader = $reader }
}

function Read-Queue([object]$Queue, [string]$HistoryName = '') {
  $line = $null
  while ($Queue.TryDequeue([ref]$line)) {
    if ($HistoryName) {
      if (-not $script:OutputHistory.ContainsKey($HistoryName)) {
        $script:OutputHistory[$HistoryName] = New-Object 'System.Collections.Generic.List[string]'
      }
      $history = $script:OutputHistory[$HistoryName]
      [void]$history.Add([string]$line)
      while ($history.Count -gt 40) { $history.RemoveAt(0) }
    }
    $line
  }
}

function Get-CloudflaredPath {
  $found = Get-CommandPath 'cloudflared.exe'; if ($found) { return $found }
  $found = Get-CommandPath 'cloudflared'; if ($found) { return $found }
  foreach ($candidate in @(
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\cloudflared.exe'),
      (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
      (Join-Path $env:ProgramFiles 'Cloudflare\cloudflared.exe')
    )) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $packageRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
  if (Test-Path -LiteralPath $packageRoot) {
    $found = Get-ChildItem -LiteralPath $packageRoot -Filter 'cloudflared.exe' -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

function Install-Cloudflared {
  $winget = Get-CommandPath 'winget.exe'
  if ($winget) {
    Write-Stage 'Устанавливаю cloudflared через официальный источник winget.'
    try {
      $wingetProcess = Start-Process -FilePath $winget -ArgumentList @('install', '--id', 'Cloudflare.cloudflared', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent') -WindowStyle Hidden -PassThru
      if (-not $wingetProcess.WaitForExit(60000)) {
        try { & taskkill.exe /PID $wingetProcess.Id /T /F *> $null } catch {}
        throw 'winget timed out'
      }
      if ($wingetProcess.ExitCode -ne 0) { throw "winget exit $($wingetProcess.ExitCode)" }
      $found = Get-CloudflaredPath
      if ($found) { return $found }
    } catch { Write-Stage 'winget недоступен, скачиваю официальный релиз Cloudflare.' }
  }
  $bin = Join-Path $script:StateRoot 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $target = Join-Path $bin 'cloudflared.exe'
  if (-not (Test-Path -LiteralPath $target)) {
    $headers = @{ 'User-Agent' = 'KuzmichRelay-live-launcher' }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -Headers $headers -TimeoutSec 30
    $asset = @($release.assets | Where-Object { $_.name -match 'windows-amd64.exe$' }) | Select-Object -First 1
    if ($null -eq $asset) { throw 'В официальном релизе Cloudflare не найден windows-amd64.exe.' }
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $target -UseBasicParsing -TimeoutSec 60
  }
  return $target
}

function Read-TunnelOrigin([object]$Tunnel) {
  foreach ($line in (Read-Queue $Tunnel.Reader.Stdout 'tunnel stdout')) {
    if ($line -match '(https://[A-Za-z0-9.-]+\.trycloudflare\.com)') { return $Matches[1].TrimEnd('/') }
    try {
      $json = $line | ConvertFrom-Json
      if ($json.url -and ([string]$json.url -match '^https://')) { return ([string]$json.url).TrimEnd('/') }
      if ($json.msg -and ([string]$json.msg -match '(https://[A-Za-z0-9.-]+\.ngrok[^\s"]*)')) { return $Matches[1].TrimEnd('/') }
    } catch {}
  }
  foreach ($line in (Read-Queue $Tunnel.Reader.Stderr 'tunnel stderr')) {
    if ($line -match '(https://[A-Za-z0-9.-]+\.trycloudflare\.com)') { return $Matches[1].TrimEnd('/') }
    try {
      $json = $line | ConvertFrom-Json
      if ($json.url -and ([string]$json.url -match '^https://')) { return ([string]$json.url).TrimEnd('/') }
    } catch {}
  }
  return $null
}

function Test-OriginDelivery([string]$Origin) {
  $script:LastOriginError = ''
  try {
    $page = Invoke-WebRequest -Uri "$Origin/" -Headers @{ Origin = $Origin } -UseBasicParsing -TimeoutSec 10
    if ($page.StatusCode -eq 200 -and $page.Content -match 'id\s*=\s*["'']root["'']') { return $true }
    $script:LastOriginError = "Invoke-WebRequest: HTTP $($page.StatusCode), production root marker отсутствует."
  } catch {
    $script:LastOriginError = "Invoke-WebRequest: $($_.Exception.ToString())"
  }

  $curl = Get-CommandPath 'curl.exe'
  if (-not $curl) {
    $script:LastOriginError += ' curl.exe не найден.'
    return $false
  }
  try {
    $curlArgs = '--silent --show-error --location --max-time 10 --header "Origin: ' + $Origin + '" --write-out "__KUZMICH_HTTP_STATUS__:%{http_code}" "' + $Origin + '/"'
    $info = New-ProcessInfo $curl $curlArgs $root @{} $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    if (-not $process.Start()) { throw 'curl.exe не запустился.' }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $curlOutput = $stdoutTask.GetAwaiter().GetResult()
    $curlError = $stderrTask.GetAwaiter().GetResult()
    $curlExit = $process.ExitCode
    $statusMatch = [regex]::Match($curlOutput, '__KUZMICH_HTTP_STATUS__:(\d{3})')
    $status = if ($statusMatch.Success) { [int]$statusMatch.Groups[1].Value } else { 0 }
    $body = if ($statusMatch.Success) { $curlOutput.Substring(0, $statusMatch.Index) } else { $curlOutput }
    if ($curlExit -eq 0 -and $status -eq 200 -and $body -match 'id\s*=\s*["'']root["'']') { return $true }
    $script:LastOriginError += " curl.exe exit=$curlExit HTTP=$status stderr=$curlError"
  } catch {
    $script:LastOriginError += " curl.exe: $($_.Exception.ToString())"
  }
  return $false
}

function Capture-ProcessOutput([object]$Managed, [string]$Name) {
  if ($null -eq $Managed -or $null -eq $Managed.Reader) { return }
  [void](Read-Queue $Managed.Reader.Stdout "$Name stdout")
  [void](Read-Queue $Managed.Reader.Stderr "$Name stderr")
}

function Write-OriginDiagnostics([string]$Origin, [object]$Relay, [object]$Tunnel) {
  Capture-ProcessOutput $Relay 'relay'
  Capture-ProcessOutput $Tunnel 'tunnel'
  Write-Stage 'Диагностика проверки HTTPS-origin:'
  Write-Output "Origin: $Origin"
  Write-Output "Последняя ошибка: $script:LastOriginError"
  foreach ($name in @('relay stdout', 'relay stderr', 'tunnel stdout', 'tunnel stderr')) {
    Write-Output "Последние строки ${name}:"
    $history = $script:OutputHistory[$name]
    if ($null -eq $history -or $history.Count -eq 0) { Write-Output '(пусто)' }
    else { $history | Select-Object -Last 20 | ForEach-Object { Write-Output ([string]$_) } }
  }
}

function New-PersistentPayloadKey([string]$Path) {
  Add-Type -AssemblyName System.Security
  $entropy = [Text.Encoding]::UTF8.GetBytes('KuzmichRelay command payload key v1')
  if (Test-Path -LiteralPath $Path) {
    $protected = [IO.File]::ReadAllBytes($Path)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    try { return ([Convert]::ToBase64String($plain).TrimEnd('=') -replace '\+', '-' -replace '/', '_') }
    finally { [Array]::Clear($plain, 0, $plain.Length) }
  }
  $plain = New-Object byte[] 32
  $rng = New-Object Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($plain) } finally { $rng.Dispose() }
  $protected = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $tmp = "$Path.$PID.tmp"
  [IO.File]::WriteAllBytes($tmp, $protected)
  Move-Item -LiteralPath $tmp -Destination $Path -Force
  try { return ([Convert]::ToBase64String($plain).TrimEnd('=') -replace '\+', '-' -replace '/', '_') }
  finally { [Array]::Clear($plain, 0, $plain.Length) }
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:StateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'KuzmichRelay'
New-Item -ItemType Directory -Force -Path $script:StateRoot | Out-Null
$relayDir = Join-Path $root 'relay-server'
$miniDir = Join-Path $root 'miniapp'
$staticDir = Join-Path $miniDir 'dist'
$tunnel = $null; $relay = $null; $origin = $null
$token = $null; $username = $null

try {
  $node = Get-CommandPath 'node.exe'; if (-not $node) { $node = Get-CommandPath 'node' }
  if (-not $node) { throw 'Не найден Node.js 24+. Установите Node.js и повторите запуск.' }
  $npmPath = Get-CommandPath 'npm.cmd'; if (-not $npmPath) { throw 'Не найден npm.cmd вместе с Node.js.' }
  # Resolve by PATH inside cmd.exe; passing the absolute Program Files path
  # would need another quoting layer around a .cmd file.
  $npm = 'npm.cmd'
  if (-not (Test-Path (Join-Path $miniDir 'node_modules'))) {
    Write-Stage 'Устанавливаю зависимости Mini App.'
    Invoke-ShortProcess $npm 'ci --ignore-scripts' $miniDir @{} | Out-Null
  }
  Write-Stage 'Собираю production Mini App.'
  $buildEnv = @{ VITE_LOCAL_RELAY = '0'; VITE_TELEGRAM_FIXTURE = '0'; VITE_RELAY_URL = '/api'; NODE_ENV = 'production' }
  Invoke-ShortProcess $npm 'run build' $miniDir $buildEnv | Out-Null
  if (-not (Test-Path (Join-Path $staticDir 'index.html'))) { throw 'Production build не создал miniapp/dist/index.html.' }

  $cloudflared = Get-CloudflaredPath
  $tunnelExe = $cloudflared; $tunnelArgs = 'tunnel --url http://127.0.0.1:8787 --no-autoupdate'
  if (-not $tunnelExe) {
    $ngrok = Get-CommandPath 'ngrok.exe'; if (-not $ngrok) { $ngrok = Get-CommandPath 'ngrok' }
    if ($ngrok) { $tunnelExe = $ngrok; $tunnelArgs = 'http 127.0.0.1:8787 --log stdout --log-format json --inspect=false' }
    else { $tunnelExe = Install-Cloudflared; $tunnelArgs = 'tunnel --url http://127.0.0.1:8787 --no-autoupdate' }
  }
  Write-Stage 'Запускаю HTTPS-туннель.'
  $tunnel = Start-ManagedProcess $tunnelExe $tunnelArgs $root @{}
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (-not $origin -and [DateTime]::UtcNow -lt $deadline) {
    $origin = Read-TunnelOrigin $tunnel
    if (-not $origin) { Start-Sleep -Milliseconds 250 }
    if ($tunnel.Process.HasExited -and -not $origin) { throw 'Туннель завершился до выдачи HTTPS-адреса.' }
  }
  if (-not $origin) { throw 'Не дождался HTTPS-адреса туннеля за 90 секунд.' }

  if ($SyntheticTest) {
    $token = '100000:LOCAL_ONLY_NOT_A_TELEGRAM_BOT_TOKEN'; $username = 'kuzmich_fixture_bot'
  } else {
    $secureToken = Read-Host 'Введите token тестового бота BotFather (значение не сохраняется)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    $username = Read-Host 'Введите username бота без @'
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($username)) { throw 'Token и username обязательны.' }
  }
  $payloadKey = New-PersistentPayloadKey (Join-Path $script:StateRoot 'command-payload.key.dpapi')
  $database = Join-Path $script:StateRoot 'relay.sqlite'
  $relayEnv = @{
    RELAY_DEV_FIXTURE = '0'; RELAY_HOST = '127.0.0.1'; RELAY_PORT = '8787'; RELAY_STATIC_DIR = $staticDir
    RELAY_TRUST_LOOPBACK_PROXY = '1'; RELAY_ALLOWED_ORIGINS = $origin; RELAY_DATABASE = $database
    RELAY_COMMAND_PAYLOAD_KEY = $payloadKey; TELEGRAM_BOT_TOKEN = $token; TELEGRAM_BOT_USERNAME = $username
    RELAY_TLS_CERT = $null; RELAY_TLS_KEY = $null
  }
  Write-Stage 'Запускаю relay.'
  $relay = Start-ManagedProcess $node 'src/main.ts' $relayDir $relayEnv
  $healthDeadline = [DateTime]::UtcNow.AddSeconds(30); $ready = $false
  while (-not $ready -and [DateTime]::UtcNow -lt $healthDeadline) {
    try {
      # Health is a local readiness probe; no browser Origin is needed here.
      $headers = @{ 'X-Forwarded-Proto' = 'https' }
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -Headers $headers -UseBasicParsing -TimeoutSec 2
      $ready = ($response.StatusCode -eq 200)
    } catch { Start-Sleep -Milliseconds 300 }
  }
  if (-not $ready) { throw 'Relay не ответил на health за 30 секунд.' }

  if ($SyntheticTest) {
    Write-Stage 'Проверяю страницу через HTTPS-origin туннеля и Origin guard.'
    $originDeadline = [DateTime]::UtcNow.AddSeconds(300)
    $nextDnsFlush = [DateTime]::UtcNow.AddSeconds(60)
    $originDelivered = $false
    while (-not $originDelivered -and [DateTime]::UtcNow -lt $originDeadline) {
      $originDelivered = Test-OriginDelivery $origin
      if ($originDelivered) { break }
      if ([DateTime]::UtcNow -ge $nextDnsFlush) {
        try { & ipconfig.exe /flushdns *> $null } catch {}
        $nextDnsFlush = [DateTime]::UtcNow.AddSeconds(60)
      }
      Start-Sleep -Seconds 2
    }
    if (-not $originDelivered) {
      Write-OriginDiagnostics $origin $relay $tunnel
      throw 'HTTPS-origin не отдал production Mini App за 300 секунд.'
    }
    $foreignStatus = 0
    try {
      $foreignPage = Invoke-WebRequest -Uri "$origin/" -Headers @{ Origin = 'https://unrelated.invalid' } -UseBasicParsing -TimeoutSec 20
      $foreignStatus = [int]$foreignPage.StatusCode
    } catch {
      if ($_.Exception.Response) { $foreignStatus = [int]$_.Exception.Response.StatusCode }
      else { throw }
    }
    if ($foreignStatus -ne 403) { throw "Origin guard вернул $foreignStatus вместо 403." }
  }

  if ($SyntheticTest) {
    # Keep smoke mode bounded; no external Telegram request is made.
    Write-Stage "SyntheticTest: relay и туннель готовы, остановка через $TestDurationSeconds секунд."
  }
  # These are the three owner-facing startup lines; background DNS checking follows.
  Write-Output "BotFather Mini App URL: $origin/"
  Write-Output "Адрес сервера: wss://$($origin.Substring(8)) (хвост /bridge/v2 дописывается сам)"
  Write-Output 'Окно запуска нельзя закрывать: оно держит relay и HTTPS-туннель.'

  if ($SyntheticTest) {
    Start-Sleep -Seconds $TestDurationSeconds
  } else {
    $ownerCheckDone = $false
    $ownerCheckDeadline = [DateTime]::UtcNow.AddSeconds(300)
    $nextOwnerCheck = [DateTime]::UtcNow
    while ($true) {
      if ($tunnel.Process.HasExited) { throw 'Туннель завершился.' }
      if ($relay.Process.HasExited) { throw 'Relay завершился.' }
      if (-not $ownerCheckDone -and [DateTime]::UtcNow -ge $nextOwnerCheck) {
        if (Test-OriginDelivery $origin) {
          Write-Output 'Ссылка проверена, открывается'
          $ownerCheckDone = $true
        } elseif ([DateTime]::UtcNow -ge $ownerCheckDeadline) {
          Write-Output 'Имя туннеля ещё расходится по DNS, подождите и попробуйте открыть Mini App позже'
          $ownerCheckDone = $true
        } else {
          $nextOwnerCheck = [DateTime]::UtcNow.AddSeconds(5)
        }
      }
      Start-Sleep -Seconds 2
    }
  }
}
catch {
  Write-Error $_
  $script:ExitCode = 1
}
finally {
  Stop-ProcessTree $relay
  Stop-ProcessTree $tunnel
  if ($token) { $token = $null }
}
if ($script:ExitCode -ne 0) { exit $script:ExitCode }
