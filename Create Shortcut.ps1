$ErrorActionPreference = 'Stop'
$deskRoot = $PSScriptRoot
$shortcutShell = New-Object -ComObject WScript.Shell
$deskChannels = @(
  @{ Directory = 'stable'; Shortcuts = @('Кузьмич.lnk'); Launcher = 'Start Codex Desk.vbs'; Description = 'Кузьмич - Release' },
  @{ Directory = 'nightly'; Shortcuts = @('Кузьмич Nightly.lnk'); Launcher = 'Start Codex Desk Nightly.vbs'; Description = 'Кузьмич - Nightly' }
)
foreach ($deskChannel in $deskChannels) {
  $deskExe = Join-Path $deskRoot ('release\' + $deskChannel.Directory + '\' + $(if ($deskChannel.Directory -eq 'stable') { 'Codex Desk.exe' } else { 'Kuzmich.exe' }))
  if (-not (Test-Path -LiteralPath $deskExe -PathType Leaf) -and $deskChannel.Directory -eq 'nightly') { $deskExe = Join-Path $deskRoot 'release\nightly\Codex Desk.exe' }
  if (-not (Test-Path -LiteralPath $deskExe -PathType Leaf)) { throw ('Channel is not built: ' + $deskChannel.Directory) }
  foreach ($shortcutName in $deskChannel.Shortcuts) {
    $shortcutPath = Join-Path $deskRoot $shortcutName
    $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $deskRoot $deskChannel.Launcher) + '"'
    $shortcut.WorkingDirectory = $deskRoot
    $shortcut.Description = $deskChannel.Description
    $shortcut.IconLocation = $deskExe + ',0'
    $shortcut.Save()
    Write-Output $shortcutPath
  }
}
