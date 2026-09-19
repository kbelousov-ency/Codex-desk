; The upstream NSIS template can fall back to taskkill by executable name.
; Release and Nightly share that name, so never stop applications from Setup.
; The target path is data in the child environment, never PowerShell source.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  ReadEnvStr $2 "CODEX_DESK_INSTALL_TARGET"
  System::Call 'Kernel32::SetEnvironmentVariableW(w "CODEX_DESK_INSTALL_TARGET", w "$INSTDIR\${APP_EXECUTABLE_FILENAME}") i.r0'
  ${If} $0 != 0
    nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$target = [IO.Path]::GetFullPath($$env:CODEX_DESK_INSTALL_TARGET); $$name = [IO.Path]::GetFileName($$target); foreach ($$process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) { if ($$process.Name -ne $$name) { continue }; if (-not $$process.ExecutablePath) { exit 2 }; if ([string]::Equals([IO.Path]::GetFullPath($$process.ExecutablePath), $$target, [StringComparison]::OrdinalIgnoreCase)) { exit 1 } }; exit 0 } catch { exit 2 }"`
    Pop $0
    Pop $1
  ${Else}
    StrCpy $0 "error"
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariableW(w "CODEX_DESK_INSTALL_TARGET", w r2) i.r1'
  ${If} $0 != 0
    ${IfNot} ${Silent}
      ${If} $0 == 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "Закройте установленный Codex Desk и повторите действие. Приложение не будет закрыто автоматически."
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Не удалось проверить, закрыт ли установленный Codex Desk. Закройте приложение и повторите действие."
      ${EndIf}
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend
