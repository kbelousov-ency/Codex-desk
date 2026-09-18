$ErrorActionPreference = 'Stop'
$deskRoot = $PSScriptRoot
$shortcutShell = New-Object -ComObject WScript.Shell
$deskChannels = @(
  @{ Directory = 'stable'; Shortcut = 'Codex Desk.lnk'; Launcher = 'Start Codex Desk.vbs'; Description = 'Codex Desk - Release' },
  @{ Directory = 'nightly'; Shortcut = 'Codex Desk Nightly.lnk'; Launcher = 'Start Codex Desk Nightly.vbs'; Description = 'Codex Desk - Nightly' }
)
foreach ($deskChannel in $deskChannels) {
  $deskExe = Join-Path $deskRoot ('release\' + $deskChannel.Directory + '\Codex Desk.exe')
  if (-not (Test-Path -LiteralPath $deskExe -PathType Leaf)) { throw ('Channel is not built: ' + $deskChannel.Directory) }
  $shortcutPath = Join-Path $deskRoot $deskChannel.Shortcut
  $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $shortcut.Arguments = '"' + (Join-Path $deskRoot $deskChannel.Launcher) + '"'
  $shortcut.WorkingDirectory = $deskRoot
  $shortcut.Description = $deskChannel.Description
  $shortcut.IconLocation = $deskExe + ',0'
  $shortcut.Save()
  Write-Output $shortcutPath
}
