param(
  [string]$Installer = '',
  [switch]$Cleanup,
  [switch]$Update,
  [switch]$SilentUpdate,
  [switch]$Nightly,
  [string]$RunDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$deskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $deskRoot 'artifacts'))
$channel = if ($Nightly) { 'nightly' } else { 'stable' }
$productLabel = if ($Nightly) { 'Кузьмич Nightly' } else { 'Кузьмич' }
$installerGuid = if ($Nightly) { 'f3d5f7cf-6c7d-5a59-bdfc-1ab813ae4778' } else { 'c9b20eca-5a9a-5a4d-9498-438701eb97b0' }
$updaterDirectory = if ($Nightly) { 'codex-desk-nightly-updater' } else { 'codex-desk-updater' }
# electron-builder derives both names from executableName, which differs per channel.
$executableName = if ($Nightly) { 'Kuzmich.exe' } else { 'Codex Desk.exe' }
$uninstallerName = if ($Nightly) { 'Uninstall Kuzmich.exe' } else { 'Uninstall Codex Desk.exe' }
# Only this channel's own product may block the test. The prefix match used before
# also caught the neighbouring channels (Nightly, Experimental 3), which share
# neither the install key nor the install directory and cannot be overwritten here.
$displayNames = if ($Nightly) { @($productLabel) } else { @($productLabel, 'Codex Desk') }
$installKey = 'Software\' + $installerGuid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $installerGuid
$snapshotPaths = @(
  (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) ($productLabel + '.lnk')),
  (Join-Path ([Environment]::GetFolderPath('Programs')) ($productLabel + '.lnk')),
  (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) ($updaterDirectory + '\installer.exe'))
)

function Assert-PlainPath([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ('Refusing redirected path: ' + $current)
      }
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}

function Assert-RunDirectory([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  if ([IO.Path]::GetDirectoryName($absolute) -ne $artifactRoot -or [IO.Path]::GetFileName($absolute) -notmatch '^installer-test-[0-9a-f]{32}$') {
    throw 'The test directory must be artifacts/installer-test-<32 hex characters>.'
  }
  Assert-PlainPath $absolute
  return $absolute
}

function Read-InstallLocation {
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $hive.OpenSubKey($installKey)
    if ($null -eq $key) { return $null }
    try { return $key.GetValue('InstallLocation') } finally { $key.Dispose() }
  } finally { $hive.Dispose() }
}

function Assert-NoInstalledProduct([string]$TestInstallPath = '') {
  foreach ($scope in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey($scope, $view)
      try {
        foreach ($name in @($installKey, $uninstallKey)) {
          $key = $hive.OpenSubKey($name)
          if ($null -ne $key) {
            try {
              if (-not $TestInstallPath -or $scope -ne [Microsoft.Win32.RegistryHive]::CurrentUser) {
                throw 'A Kuzmich installation already exists. Test refused before mutation.'
              }
              if ($name -eq $installKey) {
                $registeredPath = [string]$key.GetValue('InstallLocation')
                if (-not $registeredPath -or [IO.Path]::GetFullPath($registeredPath).TrimEnd('\') -ne $TestInstallPath) {
                  throw 'Registry belongs to another installation. Test refused.'
                }
              } else {
                $expectedCommand = '"' + (Join-Path $TestInstallPath $uninstallerName) + '" /currentuser'
                if ([string]$key.GetValue('UninstallString') -ne $expectedCommand) { throw 'Unexpected test uninstall command.' }
              }
            } finally { $key.Dispose() }
          }
        }
        $uninstall = $hive.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -ne $uninstall) {
          try {
            foreach ($name in $uninstall.GetSubKeyNames()) {
              $key = $uninstall.OpenSubKey($name)
              if ($null -eq $key) { continue }
              try {
                if ($displayNames -contains [string]$key.GetValue('DisplayName')) {
                  if (-not $TestInstallPath -or $scope -ne [Microsoft.Win32.RegistryHive]::CurrentUser -or $name -ne $installerGuid) {
                    throw 'An existing Kuzmich product was found. Test refused before mutation.'
                  }
                }
              } finally { $key.Dispose() }
            }
          } finally { $uninstall.Dispose() }
        }
      } finally { $hive.Dispose() }
    }
  }
}

function Assert-InstallTree([string]$Path) {
  Assert-PlainPath $Path
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $directories = New-Object 'System.Collections.Generic.Queue[string]'
  $directories.Enqueue($Path)
  while ($directories.Count) {
    foreach ($item in Get-ChildItem -LiteralPath $directories.Dequeue() -Force) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Link in test installation: ' + $item.FullName) }
      if ($item.PSIsContainer) { $directories.Enqueue($item.FullName) }
    }
  }
}

function Read-ShortcutTarget([string]$Path) {
  # WScript.Shell returns an empty TargetPath for the shortcuts this installer
  # writes (observed for "Кузьмич Nightly.lnk" and "Кузьмич Experimental 3.lnk",
  # while the shell itself resolves them). Ask the shell namespace first.
  $full = [IO.Path]::GetFullPath($Path)
  $shell = New-Object -ComObject Shell.Application
  try {
    $folder = $shell.Namespace([IO.Path]::GetDirectoryName($full))
    if ($null -ne $folder) {
      $item = $folder.ParseName([IO.Path]::GetFileName($full))
      if ($null -ne $item -and $item.IsLink) {
        $target = [string]$item.GetLink.Path
        if ($target) { return [IO.Path]::GetFullPath($target) }
      }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  $script = New-Object -ComObject WScript.Shell
  try { return [IO.Path]::GetFullPath($script.CreateShortcut($full).TargetPath) }
  finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($script) }
}

function Save-InstalledSnapshot {
  # Retain the original external backups across upgrades; refresh only test-owned hashes.
  Assert-InstallTree $installPath
  foreach ($snapshotPath in $snapshotPaths) { Assert-PlainPath $snapshotPath }
  $state.installedHashes = @($snapshotPaths | ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } else { '' } })
  $uninstaller = Join-Path $installPath $uninstallerName
  $capturedUninstaller = Join-Path $RunDirectory 'test-uninstaller.exe'
  Assert-PlainPath $capturedUninstaller
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    [IO.File]::Copy($uninstaller, $capturedUninstaller, $true)
    $state.uninstallerHash = (Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash
  }
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Assert-InstalledApp {
  $location = Read-InstallLocation
  if (-not $location -or [IO.Path]::GetFullPath($location).TrimEnd('\') -ne $installPath) { throw 'Installer did not use the isolated test path.' }
  Assert-NoInstalledProduct $installPath
  $exe = Join-Path $installPath $executableName
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed executable missing.' }
  foreach ($shortcut in $snapshotPaths[0..1]) {
    if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf) -or (Read-ShortcutTarget $shortcut) -ne $exe) { throw ('Incorrect installed shortcut: ' + $shortcut) }
  }
}

function Read-VerifiedInstaller {
  Assert-PlainPath $Installer
  $metadataPath = Join-Path ([IO.Path]::GetDirectoryName($Installer)) 'release-info.json'
  Assert-PlainPath $metadataPath
  $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($metadata.channel -ne $channel -or $metadata.installer -ne [IO.Path]::GetFileName($Installer) -or $metadata.buildId -notmatch '^[a-f0-9]{64}$' -or $metadata.sha256 -notmatch '^[a-f0-9]{64}$') {
    throw 'Installer metadata does not match the requested test channel.'
  }
  if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ne $metadata.sha256) { throw 'Installer checksum mismatch.' }
  $source = Join-Path $deskRoot ('release\' + $channel)
  if ($Nightly) {
    $queuePath = Join-Path $artifactRoot 'nightly-update\state.json'
    Assert-PlainPath $queuePath
    if (Test-Path -LiteralPath $queuePath) {
      $queue = Get-Content -LiteralPath $queuePath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($queue.version -ne 1 -or $queue.buildId -ne $metadata.buildId) { throw 'Rebuild the Nightly installer from the current queued candidate.' }
      $source = Join-Path $artifactRoot 'nightly-update\app'
    }
  }
  # Independent release verification reads app.asar and hashes the entire source;
  # paths are arguments to node, never interpolated JavaScript or shell source.
  $verification = @'
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, source, channel, buildId] = process.argv.slice(1);
const { verifyRelease } = await import(pathToFileURL(path.join(root, 'scripts/release-utils.mjs')));
const manifest = await verifyRelease(root, source, channel);
if (manifest.buildId !== buildId) throw new Error('Installer and source build IDs differ.');
console.log(JSON.stringify(manifest));
'@
  $manifestText = & node --input-type=module -e $verification $deskRoot $source $channel $metadata.buildId
  if ($LASTEXITCODE -ne 0) { throw 'Source release verification failed before installing.' }
  return ($manifestText | ConvertFrom-Json)
}

function Assert-InstalledPayload($Manifest) {
  Assert-InstallTree $installPath
  $count = 0
  foreach ($entry in $Manifest.files.PSObject.Properties) {
    $file = [IO.Path]::GetFullPath((Join-Path $installPath $entry.Name))
    if (-not $file.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes the isolated install directory.' }
    Assert-PlainPath $file
    if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.Value) {
      throw ('Installed payload differs from the verified source: ' + $entry.Name)
    }
    $count++
  }
  $marker = Get-Content -LiteralPath (Join-Path $installPath 'resources\channel.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($marker.channel -ne $channel -or @($marker.PSObject.Properties).Count -ne 1) { throw 'Installed channel marker differs.' }
  return $count
}

if (@($Cleanup, $Update, $SilentUpdate | Where-Object { $_ }).Count -gt 1) { throw '-Cleanup, -Update and -SilentUpdate cannot be combined.' }
if ($Cleanup -or $Update -or $SilentUpdate) {
  if (-not $RunDirectory) { throw '-Cleanup, -Update and -SilentUpdate require -RunDirectory.' }
  $RunDirectory = Assert-RunDirectory $RunDirectory
  $statePath = Join-Path $RunDirectory 'snapshot.json'
  Assert-PlainPath $statePath
  $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $installPath = Join-Path $RunDirectory 'install'
  if ($state.installPath -ne $installPath -or $state.installerGuid -ne $installerGuid -or $state.files.Count -ne $snapshotPaths.Count) { throw 'Unexpected test snapshot.' }
  Assert-InstallTree $installPath
  $location = Read-InstallLocation
  if ($location -and [IO.Path]::GetFullPath($location).TrimEnd('\') -ne $installPath) { throw 'Registry belongs to another installation. Test refused.' }
  Assert-NoInstalledProduct $installPath
  foreach ($process in @(Get-CimInstance Win32_Process -Filter ("Name = '" + $executableName + "'"))) {
    if (-not $process.ExecutablePath) { throw 'Cannot identify a running Kuzmich. Test refused.' }
    if ([IO.Path]::GetFullPath($process.ExecutablePath).StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Close the test app before update or cleanup. No process will be terminated.'
    }
  }
  for ($i = 0; $i -lt $snapshotPaths.Count; $i++) {
    $snapshot = $state.files[$i]
    if ($snapshot.path -ne $snapshotPaths[$i] -or $snapshot.backup -ne ('before-' + $i + '.bin')) { throw 'Unexpected snapshot path.' }
    Assert-PlainPath $snapshot.path
    if (Test-Path -LiteralPath $snapshot.path) {
      $currentHash = (Get-FileHash -LiteralPath $snapshot.path -Algorithm SHA256).Hash
      $expectedHash = if ($state.installedHashes.Count -gt $i) { $state.installedHashes[$i] } else { '' }
      if ($currentHash -ne $expectedHash -and $currentHash -ne $snapshot.hash) {
        throw ('External file changed since the test; update/cleanup refused: ' + $snapshot.path)
      }
    }
    if ($snapshot.existed) {
      $backup = Join-Path $RunDirectory $snapshot.backup
      Assert-PlainPath $backup
      if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $snapshot.hash) { throw 'Snapshot backup hash mismatch.' }
    }
  }
  $uninstaller = Join-Path $RunDirectory 'test-uninstaller.exe'
  Assert-PlainPath $uninstaller
  if ($location) {
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Captured test uninstaller is missing.' }
    if ((Get-FileHash -LiteralPath $uninstaller -Algorithm SHA256).Hash -ne $state.uninstallerHash) { throw 'Captured uninstaller hash mismatch.' }
  }
}

if ($Cleanup) {
  if ($location) {
    # _?= must be the final, unquoted NSIS argument, even when the path contains spaces.
    $process = Start-Process -FilePath $uninstaller -ArgumentList ('/S _?=' + $installPath) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw ('Uninstaller failed: ' + $process.ExitCode) }
  }
  if (Read-InstallLocation) { throw 'Test installation registry entry remains.' }
  foreach ($snapshot in $state.files) {
    if ($snapshot.existed) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($snapshot.path)) | Out-Null
      [IO.File]::Copy((Join-Path $RunDirectory $snapshot.backup), $snapshot.path, $true)
      if ((Get-FileHash -LiteralPath $snapshot.path -Algorithm SHA256).Hash -ne $snapshot.hash) { throw 'Failed to restore original external file.' }
    } elseif (Test-Path -LiteralPath $snapshot.path) {
      # Only the snapshot's exact known paths, already checked for concurrent changes above.
      Remove-Item -LiteralPath $snapshot.path -Force
    }
  }
  if (Test-Path -LiteralPath $installPath) {
    # Recheck the absolute workspace child and links immediately before recursive cleanup.
    [void](Assert-RunDirectory $RunDirectory)
    Assert-InstallTree $installPath
    Remove-Item -LiteralPath $installPath -Recurse -Force
  }
  Assert-NoInstalledProduct
  $result = @{ status = 'cleaned'; runDirectory = $RunDirectory; restoredExternalFiles = $state.files.Count }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'cleanup-result.json') -Encoding UTF8
  $result | ConvertTo-Json
  exit 0
}

if ($RunDirectory -and -not ($Update -or $SilentUpdate)) { throw '-RunDirectory is accepted only with -Cleanup, -Update or -SilentUpdate.' }
if (-not $Installer) {
  $delivery = if ($Nightly) { Join-Path $artifactRoot 'installer-nightly' } else { Join-Path $deskRoot 'release\installer' }
  $metadataPath = Join-Path $delivery 'release-info.json'
  Assert-PlainPath $metadataPath
  $deliveryMetadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([IO.Path]::GetFileName($deliveryMetadata.installer) -ne $deliveryMetadata.installer -or $deliveryMetadata.installer -notlike '*.exe') { throw 'Unexpected installer filename.' }
  $Installer = Join-Path $delivery $deliveryMetadata.installer
}
$Installer = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Build the installer first.' }
$manifest = Read-VerifiedInstaller
if ($Update) {
  Assert-InstalledApp
  $installedUninstaller = Join-Path $installPath $uninstallerName
  if ((Get-FileHash -LiteralPath $installedUninstaller -Algorithm SHA256).Hash -ne $state.uninstallerHash) { throw 'Installed uninstaller changed since the test.' }
  try {
    try {
      # Omit /D to exercise registry-based discovery of the existing installation.
      $process = Start-Process -FilePath $Installer -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
    } finally {
      # Partial upgrades may already have replaced shortcuts, cache or the uninstaller.
      Save-InstalledSnapshot
    }
    if ($process.ExitCode -ne 0) { throw ('Installer update failed: ' + $process.ExitCode) }
    Assert-InstalledApp
    $verifiedFiles = Assert-InstalledPayload $manifest
    $result = @{ status = 'updated'; channel = $channel; buildId = $manifest.buildId; verifiedFiles = $verifiedFiles; runDirectory = $RunDirectory; installPath = $installPath; executable = (Join-Path $installPath $executableName); exitCode = $process.ExitCode }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'update-result.json') -Encoding UTF8
    $result | ConvertTo-Json
  } catch {
    Write-Warning ('Test snapshot retained for cleanup: ' + $RunDirectory)
    throw
  }
  exit 0
}

if ($SilentUpdate) {
  # Silent self-update protocol of scripts/installer.nsh: the only argument is /S,
  # everything else arrives in the child environment. Both branches run against the
  # real installer. The "running application" is a stub with the same file name at a
  # different path, so the user's own Кузьмич is never waited for or touched.
  Assert-InstalledApp
  $installedExe = Join-Path $installPath $executableName
  $installedUninstaller = Join-Path $installPath $uninstallerName
  if ((Get-FileHash -LiteralPath $installedUninstaller -Algorithm SHA256).Hash -ne $state.uninstallerHash) { throw 'Installed uninstaller changed since the test.' }

  # The successful branch ends with the installer starting the installed application.
  # Require another instance to already hold the single-instance lock, so the
  # relaunched process quits at once instead of opening a window on the owner's
  # profile without supervision.
  $lockHolders = @(Get-CimInstance Win32_Process -Filter ("Name = '" + $executableName + "'") | ForEach-Object {
    if (-not $_.ExecutablePath) { return }
    $directory = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($_.ExecutablePath))
    if ($directory -eq $installPath -or $directory -eq (Join-Path $RunDirectory 'fake')) { return }
    $marker = Join-Path $directory 'resources\channel.json'
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return }
    if ((Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json).channel -ne $channel) { return }
    [IO.Path]::GetFullPath($_.ExecutablePath)
  } | Select-Object -Unique)
  if (-not $lockHolders.Count) {
    throw ('Start the ' + $channel + ' application before -SilentUpdate: without a running instance holding the single-instance lock the relaunch would open a new window on the real profile.')
  }

  # Unsigned-installer surroundings: recorded, never worked around.
  $environment = [ordered]@{ lockHolders = $lockHolders; zoneIdentifier = ''; smartScreenShell = ''; smartScreenAppHost = '' }
  try { $environment.zoneIdentifier = [string](Get-Content -LiteralPath $Installer -Stream 'Zone.Identifier' -Raw -ErrorAction Stop) } catch { $environment.zoneIdentifier = '(нет метки загрузки)' }
  try {
    $defender = Get-MpComputerStatus
    $environment.defenderRealTime = [bool]$defender.RealTimeProtectionEnabled
    $environment.defenderAntivirus = [bool]$defender.AntivirusEnabled
    $environment.defenderBehaviour = [bool]$defender.BehaviorMonitorEnabled
  } catch { $environment.defenderStatus = 'unavailable' }
  try {
    $preference = Get-MpPreference
    $environment.controlledFolderAccess = [int]$preference.EnableControlledFolderAccess
    $environment.asrRules = @($preference.AttackSurfaceReductionRules_Ids).Count
  } catch { $environment.defenderPreference = 'unavailable' }
  try { $environment.smartScreenShell = [string](Get-ItemPropertyValue -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' -Name 'SmartScreenEnabled' -ErrorAction Stop) } catch { $environment.smartScreenShell = '(значение не задано)' }
  try { $environment.smartScreenAppHost = [string](Get-ItemPropertyValue -Path 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppHost' -Name 'EnableWebContentEvaluation' -ErrorAction Stop) } catch { $environment.smartScreenAppHost = '(значение не задано)' }
  $detectionsBefore = -1
  try { $detectionsBefore = @(Get-MpThreatDetection).Count } catch { }
  $windowStart = (Get-Date).AddSeconds(-5)

  $fakeDirectory = Join-Path $RunDirectory 'fake'
  Assert-PlainPath $fakeDirectory
  [IO.Directory]::CreateDirectory($fakeDirectory) | Out-Null
  $fakeExe = Join-Path $fakeDirectory $executableName
  $stopFile = Join-Path $fakeDirectory 'stop'
  Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $fakeExe -PathType Leaf)) {
    # A stub, not a copy of the real app: it only waits for the stop file, so the
    # installer never has to deal with a real Кузьмич and nothing is force-killed.
    $stubSource = @'
using System;
using System.IO;
using System.Threading;
public static class KuzmichUpdateStub {
  public static int Main(string[] args) {
    string home = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    while (!File.Exists(Path.Combine(home, "stop"))) Thread.Sleep(100);
    return 0;
  }
}
'@
    Add-Type -TypeDefinition $stubSource -OutputAssembly $fakeExe -OutputType ConsoleApplication
  }

  # A tampered payload file is the evidence: it survives a refusal and is restored
  # by a real installation.
  $marker = Join-Path $installPath 'resources\channel.json'
  Assert-PlainPath $marker
  $markerBackup = Join-Path $RunDirectory 'marker-original.json'
  [IO.File]::Copy($marker, $markerBackup, $true)
  $tampered = '{"channel":"tampered"}'

  # The relaunched application quits within a second: another instance already
  # holds the single-instance lock. The cheap process list is polled every
  # iteration, the slower CIM query carries the command line.
  function Find-Relaunch([string]$Executable, [bool]$WithCommandLine) {
    if ($WithCommandLine) {
      foreach ($instance in @(Get-CimInstance Win32_Process -Filter ("Name = '" + [IO.Path]::GetFileName($Executable) + "'") -ErrorAction SilentlyContinue)) {
        if (-not $instance.ExecutablePath) { continue }
        if (-not [string]::Equals([IO.Path]::GetFullPath($instance.ExecutablePath), $Executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($instance.CommandLine) { return @{ observed = $true; command = [string]$instance.CommandLine } }
      }
    }
    foreach ($candidate in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Executable)) -ErrorAction SilentlyContinue)) {
      $image = ''
      try { $image = [string]$candidate.Path } catch { continue }
      if (-not $image) { continue }
      if (-not [string]::Equals([IO.Path]::GetFullPath($image), $Executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
      $command = ''
      try { $command = [string](Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $candidate.Id) -ErrorAction Stop).CommandLine } catch { }
      return @{ observed = $true; command = $command }
    }
    return @{ observed = $false; command = '' }
  }

  function Start-SilentUpdate([string]$LogPath, [int]$FakePid, [string]$Image = '', [string]$ExtraArguments = '') {
    # CreateProcess with its own environment block and no shell — exactly how the
    # application will spawn the installer.
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = if ($Image) { $Image } else { $Installer }
    $startInfo.Arguments = ('/S ' + $ExtraArguments).Trim()
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.EnvironmentVariables['CODEX_DESK_UPDATE_PID'] = [string]$FakePid
    $startInfo.EnvironmentVariables['CODEX_DESK_UPDATE_EXE'] = $fakeExe
    $startInfo.EnvironmentVariables['CODEX_DESK_UPDATE_LOG'] = $LogPath
    return [Diagnostics.Process]::Start($startInfo)
  }

  function Read-Report([string]$LogPath) {
    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { return @{ text = ''; bytes = '' } }
    $bytes = [IO.File]::ReadAllBytes($LogPath)
    return @{ text = [Text.Encoding]::ASCII.GetString($bytes); bytes = (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') }
  }

  # Mark-of-the-Web probe: if the downloaded file ever carries a zone stamp, does
  # a shell-less CreateProcess (what the application uses) still run it? /allusers
  # makes the installer refuse in .onInit, so nothing is installed by this probe.
  $motwInstaller = Join-Path $RunDirectory 'motw-installer.exe'
  Assert-PlainPath $motwInstaller
  [IO.File]::Copy($Installer, $motwInstaller, $true)
  Set-Content -LiteralPath $motwInstaller -Stream 'Zone.Identifier' -Value "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://coder-portal.encycam.com/`r`n"
  $motwLog = Join-Path $RunDirectory 'silent-update-motw.log'
  Remove-Item -LiteralPath $motwLog -Force -ErrorAction SilentlyContinue
  $motwProcess = Start-SilentUpdate $motwLog $PID $motwInstaller '/allusers'
  if (-not $motwProcess.WaitForExit(120000)) { throw 'The marked installer did not even exit.' }
  $environment.motwZone = [string](Get-Content -LiteralPath $motwInstaller -Stream 'Zone.Identifier' -Raw)
  $environment.motwExitCode = $motwProcess.ExitCode
  $environment.motwReport = (Read-Report $motwLog).text.Trim()
  $environment.motwStarted = $true
  try {
    $environment.antivirusProducts = @(Get-CimInstance -Namespace 'root\SecurityCenter2' -ClassName AntiVirusProduct -ErrorAction Stop |
      ForEach-Object { $_.displayName + ' (state 0x' + ([int]$_.productState).ToString('x6') + ')' })
  } catch { $environment.antivirusProducts = @('(SecurityCenter2 недоступен)') }

  $refusal = $null
  $success = $null
  $relaunch = ''
  $relaunchSeen = $false
  try {
    # --- 1. the application never closes: refusal without installing ----------
    Set-Content -LiteralPath $marker -Value $tampered -Encoding UTF8 -NoNewline
    $sentinel = Join-Path $installPath 'silent-update-sentinel.txt'
    Set-Content -LiteralPath $sentinel -Value 'refusal branch' -Encoding UTF8
    $exeStamp = (Get-Item -LiteralPath $installedExe -Force).LastWriteTimeUtc
    $refusalLog = Join-Path $RunDirectory 'silent-update-timeout.log'
    Remove-Item -LiteralPath $refusalLog -Force -ErrorAction SilentlyContinue
    $fake = Start-Process -FilePath $fakeExe -WindowStyle Hidden -PassThru
    try {
      Start-Sleep -Seconds 2
      if (-not (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) { throw 'The stub application exited before the test started.' }
      $started = Get-Date
      $process = Start-SilentUpdate $refusalLog $fake.Id
      if (-not $process.WaitForExit(300000)) { throw 'The installer did not give up within five minutes.' }
      $waited = ((Get-Date) - $started).TotalSeconds
      $exitCode = $process.ExitCode
      $report = Read-Report $refusalLog
      if ($report.text.Trim() -ne 'timeout') { throw ('Expected a single "timeout" line, got: ' + $report.text) }
      if ($exitCode -ne 2) { throw ('Expected exit code 2, got ' + $exitCode) }
      if ($waited -lt 115) { throw ('The installer gave up after ' + [int]$waited + ' s instead of waiting 120 s.') }
      if (-not (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) { throw 'The installer terminated the application. It must never do that.' }
      if ((Get-Content -LiteralPath $marker -Raw -Encoding UTF8) -ne $tampered) { throw 'The refused run still replaced payload files.' }
      if (-not (Test-Path -LiteralPath $sentinel -PathType Leaf)) { throw 'The refused run still touched the installation.' }
      if ((Get-Item -LiteralPath $installedExe -Force).LastWriteTimeUtc -ne $exeStamp) { throw 'The refused run still replaced the executable.' }
      $refusal = @{ waitedSeconds = [math]::Round($waited, 1); exitCode = $exitCode; report = $report.text.Trim(); reportBytes = $report.bytes; applicationSurvived = $true; installationUntouched = $true }
    } finally {
      Set-Content -LiteralPath $stopFile -Value '' -Encoding UTF8
      Wait-Process -Id $fake.Id -Timeout 30 -ErrorAction SilentlyContinue
      Save-InstalledSnapshot
    }

    # --- 2. the application closes while the installer waits ------------------
    Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
    $successLog = Join-Path $RunDirectory 'silent-update-ok.log'
    Remove-Item -LiteralPath $successLog -Force -ErrorAction SilentlyContinue
    $fake = Start-Process -FilePath $fakeExe -WindowStyle Hidden -PassThru
    try {
      Start-Sleep -Seconds 2
      if (-not (Get-Process -Id $fake.Id -ErrorAction SilentlyContinue)) { throw 'The stub application exited before the test started.' }
      $started = Get-Date
      try {
        $process = Start-SilentUpdate $successLog $fake.Id
        Start-Sleep -Seconds 10
        $earlyMarker = (Get-Content -LiteralPath $marker -Raw -Encoding UTF8)
        Set-Content -LiteralPath $stopFile -Value '' -Encoding UTF8
        # Watch for the relaunch from here on: it happens in the installer's last
        # moments and the started process leaves again almost immediately.
        $watchDeadline = (Get-Date).AddSeconds(330)
        $afterExit = $null
        $round = 0
        Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $PID) -ErrorAction SilentlyContinue | Out-Null
        while ((Get-Date) -lt $watchDeadline) {
          $round++
          if (-not $relaunchSeen) {
            $found = Find-Relaunch $installedExe ($round % 4 -eq 0)
            if ($found.observed) { $relaunchSeen = $true; $relaunch = [string]$found.command }
          }
          if ($process.HasExited) {
            if ($null -eq $afterExit) { $afterExit = (Get-Date).AddSeconds(25); $waited = ((Get-Date) - $started).TotalSeconds }
            if ($relaunchSeen -or (Get-Date) -gt $afterExit) { break }
          }
          Start-Sleep -Milliseconds 60
        }
        if (-not $process.HasExited) { throw 'The installer did not finish within five minutes after the application left.' }
        $exitCode = $process.ExitCode
      } finally {
        Save-InstalledSnapshot
      }
      $report = Read-Report $successLog
      if ($earlyMarker -ne $tampered) { throw 'The installer started installing before the application closed.' }
      if ($report.text.Trim() -ne 'ok') { throw ('Expected a single "ok" line, got: ' + $report.text) }
      if ($exitCode -ne 0) { throw ('Expected exit code 0, got ' + $exitCode) }
      Assert-InstalledApp
      $verifiedFiles = Assert-InstalledPayload $manifest
      if (Test-Path -LiteralPath (Join-Path $installPath 'silent-update-sentinel.txt') -PathType Leaf) {
        Remove-Item -LiteralPath (Join-Path $installPath 'silent-update-sentinel.txt') -Force
      }
      if (-not $relaunchSeen) { throw 'The relaunched application was not observed.' }
      # The relaunched instance quits as soon as it sees the lock, so its command
      # line is not always readable in time. scripts/ui-silent-update-host.mjs
      # checks the argument itself on the same macro with a stub application.
      if ($relaunch -and $relaunch -notmatch '--updated') { throw ('The application was relaunched without --updated: ' + $relaunch) }
      $success = @{ waitedSeconds = [math]::Round($waited, 1); exitCode = $exitCode; report = $report.text.Trim(); reportBytes = $report.bytes;
        verifiedFiles = $verifiedFiles; relaunchObserved = $true; relaunchCommand = $relaunch
        relaunchArgumentChecked = [bool]($relaunch -match '--updated') }
    } finally {
      Set-Content -LiteralPath $stopFile -Value '' -Encoding UTF8
      Wait-Process -Id $fake.Id -Timeout 30 -ErrorAction SilentlyContinue
    }
  } catch {
    if (Test-Path -LiteralPath $markerBackup -PathType Leaf) { [IO.File]::Copy($markerBackup, $marker, $true) }
    Write-Warning ('Test snapshot retained for cleanup: ' + $RunDirectory)
    throw
  }

  $detectionsAfter = -1
  try { $detectionsAfter = @(Get-MpThreatDetection).Count } catch { }
  $environment.threatDetectionsBefore = $detectionsBefore
  $environment.threatDetectionsAfter = $detectionsAfter
  $environment.defenderEvents = @()
  try {
    $environment.defenderEvents = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $windowStart } -ErrorAction Stop |
      Where-Object { $_.Id -in @(1006, 1007, 1008, 1009, 1015, 1116, 1117, 1121, 1122, 5007) } |
      ForEach-Object { '' + $_.Id + ': ' + $_.TimeCreated.ToString('o') })
  } catch { $environment.defenderEvents = @('(журнал Defender недоступен)') }
  $result = @{ status = 'silent-update-verified'; channel = $channel; buildId = $manifest.buildId; runDirectory = $RunDirectory;
    installPath = $installPath; executable = $installedExe; stubApplication = $fakeExe;
    refusal = $refusal; success = $success; environment = $environment }
  $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $RunDirectory 'silent-update-result.json') -Encoding UTF8
  $result | ConvertTo-Json -Depth 6
  exit 0
}
Assert-NoInstalledProduct
foreach ($snapshotPath in $snapshotPaths) { Assert-PlainPath $snapshotPath }
$RunDirectory = Assert-RunDirectory (Join-Path $artifactRoot ('installer-test-' + [Guid]::NewGuid().ToString('N')))
$installPath = Join-Path $RunDirectory 'install'
[IO.Directory]::CreateDirectory($RunDirectory) | Out-Null
$state = [ordered]@{ channel = $channel; installerGuid = $installerGuid; installPath = $installPath; files = @(); installedHashes = @(); uninstallerHash = '' }
for ($i = 0; $i -lt $snapshotPaths.Count; $i++) {
  $snapshotPath = $snapshotPaths[$i]
  $existed = Test-Path -LiteralPath $snapshotPath -PathType Leaf
  if ((Test-Path -LiteralPath $snapshotPath) -and -not $existed) { throw ('External snapshot target is not a file: ' + $snapshotPath) }
  $backupName = 'before-' + $i + '.bin'
  $hash = ''
  if ($existed) {
    [IO.File]::Copy($snapshotPath, (Join-Path $RunDirectory $backupName))
    $hash = (Get-FileHash -LiteralPath (Join-Path $RunDirectory $backupName) -Algorithm SHA256).Hash
  }
  $state.files += @{ path = $snapshotPath; existed = [bool]$existed; backup = $backupName; hash = $hash }
}
$statePath = Join-Path $RunDirectory 'snapshot.json'
$state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $statePath -Encoding UTF8
try {
  # /S suppresses automatic application launch. /D must be last, without quotes.
  try {
    $process = Start-Process -FilePath $Installer -ArgumentList ('/S /D=' + $installPath) -WindowStyle Hidden -Wait -PassThru
  } finally {
    Save-InstalledSnapshot
  }
  if ($process.ExitCode -ne 0) { throw ('Installer failed: ' + $process.ExitCode) }
  Assert-InstalledApp
  $verifiedFiles = Assert-InstalledPayload $manifest
  $exe = Join-Path $installPath $executableName
  $result = @{ status = 'installed'; channel = $channel; buildId = $manifest.buildId; verifiedFiles = $verifiedFiles; runDirectory = $RunDirectory; installPath = $installPath; executable = $exe; exitCode = $process.ExitCode }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'install-result.json') -Encoding UTF8
  $result | ConvertTo-Json
} catch {
  Write-Warning ('Test snapshot retained for cleanup: ' + $RunDirectory)
  throw
}
