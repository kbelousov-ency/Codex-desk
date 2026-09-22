; Match the product palette. Native navigation controls keep Windows behaviour.
!define MUI_BGCOLOR "181A1C"
!define MUI_TEXTCOLOR "E3E5E5"
!define MUI_INSTFILESPAGE_COLORS "B6D8CC 141618"
!define MUI_UNINSTFILESPAGE_COLORS "B6D8CC 141618"
!define MUI_ABORTWARNING

; Assisted mode otherwise exposes a machine-wide choice and can elevate on /S.
; Enforce the existing per-user contract for install, upgrade and uninstall.
!macro deskCurrentUser
  ${If} ${isForAllUsers}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Codex Desk устанавливается только для текущего пользователя. Запустите установщик без параметра /allusers."
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customInit
  StrCpy $LANGUAGE 1049
  !insertmacro deskCurrentUser
!macroend

!macro customUnInit
  StrCpy $LANGUAGE 1049
  !insertmacro deskCurrentUser
!macroend

!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE_3LINES
  !define MUI_WELCOMEPAGE_TITLE "Добро пожаловать в ${PRODUCT_NAME}"
  !define MUI_WELCOMEPAGE_TEXT "Установим приложение и подготовим рабочее пространство для ваших проектов.$\r$\n$\r$\nПри первом запуске мастер поможет выбрать Codex и Claude, установить нужные CLI, применить конфигурацию Codex и войти в аккаунт.$\r$\n$\r$\nПриложение устанавливается для текущего пользователя."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function DeskStartApp
    ${If} ${isUpdated}
      StrCpy $1 "--updated"
    ${Else}
      StrCpy $1 ""
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} установлен"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !define MUI_FINISHPAGE_TEXT "Откройте приложение, чтобы начать работу.$\r$\n$\r$\nМастер первоначальной настройки проверит агентов и предложит следующие шаги. Позже его можно открыть снова в настройках."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Открыть ${PRODUCT_NAME}"
  !define MUI_FINISHPAGE_RUN_FUNCTION "DeskStartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "DeskFinishPageShow"
  !insertmacro MUI_PAGE_FINISH

  Function DeskFinishPageShow
    ${IfNot} ${RebootFlag}
      ; Windows visual styles ignore SetCtlColors for checkbox text (MUI bug #443).
      ; Disable them only for this control so the dark page keeps a readable label.
      System::Call 'UXTHEME::SetWindowTheme(p$mui.FinishPage.Run, w" ", w" ")'
      SetCtlColors $mui.FinishPage.Run "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${EndIf}
  FunctionEnd
!macroend

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
