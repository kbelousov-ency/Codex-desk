param([switch]$WaitForExit)
$ErrorActionPreference = 'Stop'
$deskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $deskRoot 'release'))
$allowedRoot = Get-Item -LiteralPath $releaseRoot -Force
if ($allowedRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Release root must not be a junction or link.' }
# Explicit migration list: future directories and the three fixed slots are never candidates.
$oldReleaseNames = @('access-modes','cache-hour','cache-ping','compact-ui','compact-work-log','continue-avatar','diagnostics','dialog-archive','files-panel','link-path-fix','logo-aligned','mcp-json','mcp-settings','messenger-search','model-menus','multi-session','project-actions','session-terminal','standard-commands','tab-alignment','thread-recovery','token-details','win-unpacked','work-collapse')
foreach ($deskChannel in @('stable','nightly')) {
  $channelRoot = Join-Path $releaseRoot $deskChannel
  if (-not (Test-Path -LiteralPath (Join-Path $channelRoot 'Codex Desk.exe') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $channelRoot 'release-manifest.json') -PathType Leaf)) { throw ('Build both fixed channels before cleanup: ' + $deskChannel) }
}
$deadline = [DateTime]::UtcNow.AddDays(7)
do {
  $runningPaths = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Codex Desk.exe' } | ForEach-Object {
    if (-not $_.ExecutablePath) { throw 'Cannot determine the path of a running Codex Desk. No cleanup performed.' }
    [IO.Path]::GetFullPath($_.ExecutablePath)
  })
  $pending = @()
  foreach ($oldReleaseName in $oldReleaseNames) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $releaseRoot $oldReleaseName))
    if ([IO.Path]::GetDirectoryName($candidate) -ne $releaseRoot) { throw 'Unsafe cleanup target.' }
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $item = Get-Item -LiteralPath $candidate -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Unexpected cleanup target: ' + $candidate) }
    if (-not (Test-Path -LiteralPath (Join-Path $candidate 'Codex Desk.exe')) -and -not (Test-Path -LiteralPath (Join-Path $candidate 'win-unpacked\Codex Desk.exe'))) { throw ('Unrecognized build folder: ' + $candidate) }
    if (@($runningPaths | Where-Object { $_.StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { $pending += $oldReleaseName; continue }
    # Refuse nested reparse points before recursive deletion; never follow a redirected tree.
    $directories = New-Object 'System.Collections.Generic.Queue[string]'
    $directories.Enqueue($candidate)
    while ($directories.Count) {
      foreach ($child in Get-ChildItem -LiteralPath $directories.Dequeue() -Force) {
        if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Link inside cleanup target: ' + $child.FullName) }
        if ($child.PSIsContainer) { $directories.Enqueue($child.FullName) }
      }
    }
    $latestProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'Codex Desk.exe' })
    if (@($latestProcesses | Where-Object { -not $_.ExecutablePath }).Count) { throw 'Cannot identify a running application. Cleanup stopped.' }
    if (@($latestProcesses | Where-Object { ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($candidate + '\', [StringComparison]::OrdinalIgnoreCase) }).Count) { $pending += $oldReleaseName; continue }
    try { Remove-Item -LiteralPath $candidate -Recurse -Force; Write-Output ('Removed: ' + $oldReleaseName) }
    catch { $pending += $oldReleaseName; Write-Warning ('Still in use: ' + $oldReleaseName) }
  }
  if ($pending.Count -eq 0) { break }
  if (-not $WaitForExit) { Write-Output ('Pending close: ' + ($pending -join ', ')); break }
  Start-Sleep -Seconds 20
} while ([DateTime]::UtcNow -lt $deadline)
