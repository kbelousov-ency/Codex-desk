param(
  [string]$Installer = '',
  [switch]$Cleanup,
  [switch]$Update,
  [string]$RunDirectory = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$deskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $deskRoot 'artifacts'))
$installerGuid = 'c9b20eca-5a9a-5a4d-9498-438701eb97b0'
$installKey = 'Software\' + $installerGuid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $installerGuid
$snapshotPaths = @(
  (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Codex Desk.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Codex Desk.lnk'),
  (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'codex-desk-updater\installer.exe')
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
                throw 'A Codex Desk installation already exists. Test refused before mutation.'
              }
              if ($name -eq $installKey) {
                $registeredPath = [string]$key.GetValue('InstallLocation')
                if (-not $registeredPath -or [IO.Path]::GetFullPath($registeredPath).TrimEnd('\') -ne $TestInstallPath) {
                  throw 'Registry belongs to another installation. Test refused.'
                }
              } else {
                $expectedCommand = '"' + (Join-Path $TestInstallPath 'Uninstall Codex Desk.exe') + '" /currentuser'
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
                if ([string]$key.GetValue('DisplayName') -match '^Codex Desk(?:\s|$)') {
                  if (-not $TestInstallPath -or $scope -ne [Microsoft.Win32.RegistryHive]::CurrentUser -or $name -ne $installerGuid) {
                    throw 'An existing Codex Desk product was found. Test refused before mutation.'
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
  $shell = New-Object -ComObject WScript.Shell
  try { return [IO.Path]::GetFullPath($shell.CreateShortcut($Path).TargetPath) }
  finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Save-InstalledSnapshot {
  # Retain the original external backups across upgrades; refresh only test-owned hashes.
  Assert-InstallTree $installPath
  foreach ($snapshotPath in $snapshotPaths) { Assert-PlainPath $snapshotPath }
  $state.installedHashes = @($snapshotPaths | ForEach-Object { if (Test-Path -LiteralPath $_ -PathType Leaf) { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash } else { '' } })
  $uninstaller = Join-Path $installPath 'Uninstall Codex Desk.exe'
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
  $exe = Join-Path $installPath 'Codex Desk.exe'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed executable missing.' }
  foreach ($shortcut in $snapshotPaths[0..1]) {
    if (-not (Test-Path -LiteralPath $shortcut -PathType Leaf) -or (Read-ShortcutTarget $shortcut) -ne $exe) { throw ('Incorrect installed shortcut: ' + $shortcut) }
  }
}

if ($Cleanup -and $Update) { throw '-Cleanup and -Update cannot be combined.' }
if ($Cleanup -or $Update) {
  if (-not $RunDirectory) { throw '-Cleanup and -Update require -RunDirectory.' }
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
  foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'Codex Desk.exe'")) {
    if (-not $process.ExecutablePath) { throw 'Cannot identify a running Codex Desk. Test refused.' }
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

if ($RunDirectory -and -not $Update) { throw '-RunDirectory is accepted only with -Cleanup or -Update.' }
if (-not $Installer) { $Installer = Join-Path $deskRoot 'release\installer\Codex Desk Setup 0.1.0.exe' }
$Installer = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { throw 'Build the installer first.' }
if ($Update) {
  Assert-InstalledApp
  $installedUninstaller = Join-Path $installPath 'Uninstall Codex Desk.exe'
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
    $result = @{ status = 'updated'; runDirectory = $RunDirectory; installPath = $installPath; executable = (Join-Path $installPath 'Codex Desk.exe'); exitCode = $process.ExitCode }
    $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'update-result.json') -Encoding UTF8
    $result | ConvertTo-Json
  } catch {
    Write-Warning ('Test snapshot retained for cleanup: ' + $RunDirectory)
    throw
  }
  exit 0
}
Assert-NoInstalledProduct
foreach ($snapshotPath in $snapshotPaths) { Assert-PlainPath $snapshotPath }
$RunDirectory = Assert-RunDirectory (Join-Path $artifactRoot ('installer-test-' + [Guid]::NewGuid().ToString('N')))
$installPath = Join-Path $RunDirectory 'install'
[IO.Directory]::CreateDirectory($RunDirectory) | Out-Null
$state = [ordered]@{ installerGuid = $installerGuid; installPath = $installPath; files = @(); installedHashes = @(); uninstallerHash = '' }
for ($i = 0; $i -lt $snapshotPaths.Count; $i++) {
  $snapshotPath = $snapshotPaths[$i]
  $existed = Test-Path -LiteralPath $snapshotPath -PathType Leaf
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
  $exe = Join-Path $installPath 'Codex Desk.exe'
  $result = @{ status = 'installed'; runDirectory = $RunDirectory; installPath = $installPath; executable = $exe; exitCode = $process.ExitCode }
  $result | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $RunDirectory 'install-result.json') -Encoding UTF8
  $result | ConvertTo-Json
} catch {
  Write-Warning ('Test snapshot retained for cleanup: ' + $RunDirectory)
  throw
}
