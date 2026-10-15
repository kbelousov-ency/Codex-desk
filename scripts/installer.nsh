; Match the product palette. Native navigation controls keep Windows behaviour.
!ifndef SETUP_ARGS
  !define SETUP_ARGS ""
!endif
!define MUI_BGCOLOR "181A1C"
!define MUI_TEXTCOLOR "E3E5E5"
!define MUI_INSTFILESPAGE_COLORS "B6D8CC 141618"
!define MUI_UNINSTFILESPAGE_COLORS "B6D8CC 141618"
!define MUI_ABORTWARNING

; Silent self-update protocol (docs/RELEASES.md). The running application spawns
; this installer with the single argument /S and passes everything else in the
; child environment:
;   CODEX_DESK_UPDATE_PID  decimal pid of the running application; enables the mode
;   CODEX_DESK_UPDATE_EXE  full path of the running executable to wait for
;   CODEX_DESK_UPDATE_LOG  report file; receives exactly one line
; Command-line switches were rejected on purpose: a shell-less spawn quotes the
; whole argument ("/UPDATEEXE=C:\path with space\x.exe") and ${GetOptions} parses
; that inconsistently. The environment removes the quoting question entirely and
; the same trick is already used for CODEX_DESK_INSTALL_TARGET below.
; CODEX_DESK_UPDATE_EXE is never written by the installer; CODEX_DESK_INSTALL_TARGET
; stays what it always was — the private input of the process probe.
!define DESK_UPDATE_WAIT_MS 120000
!define DESK_UPDATE_POLL_MS 2000

; _MODE becomes "1" only for a silent run that carries the pid; _EXE and _LOG may
; still be empty, so every caller has to tolerate that.
!macro deskUpdateEnv _MODE _EXE _LOG
  StrCpy ${_EXE} ""
  StrCpy ${_LOG} ""
  StrCpy ${_MODE} "0"
  ${If} ${Silent}
    ReadEnvStr ${_MODE} "CODEX_DESK_UPDATE_PID"
    ${If} ${_MODE} == ""
      StrCpy ${_MODE} "0"
    ${Else}
      StrCpy ${_MODE} "1"
      ReadEnvStr ${_EXE} "CODEX_DESK_UPDATE_EXE"
      ReadEnvStr ${_LOG} "CODEX_DESK_UPDATE_LOG"
    ${EndIf}
  ${EndIf}
!macroend

; Exactly one line, ASCII, CRLF. Outside the silent update mode this writes nothing.
!macro deskUpdateReport _TEXT
  Push $R7
  Push $R8
  Push $R9
  !insertmacro deskUpdateEnv $R7 $R8 $R9
  ${If} $R7 == "1"
  ${AndIf} $R9 != ""
    ClearErrors
    FileOpen $R8 "$R9" w
    ${IfNot} ${Errors}
      FileWrite $R8 "${_TEXT}$\r$\n"
      FileClose $R8
    ${EndIf}
  ${EndIf}
  Pop $R9
  Pop $R8
  Pop $R7
!macroend

; Assisted mode otherwise exposes a machine-wide choice and can elevate on /S.
; Enforce the existing per-user contract for install, upgrade and uninstall.
!macro deskCurrentUser
  ${If} ${isForAllUsers}
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "Кузьмич устанавливается только для текущего пользователя. Запустите установщик без параметра /allusers."
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      ; A silent self-update must not die without telling the application why.
      !insertmacro deskUpdateReport "error"
    !endif
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
  !ifdef APP_WELCOME_TEXT
    !define MUI_WELCOMEPAGE_TEXT "${APP_WELCOME_TEXT}"
  !else
    !define MUI_WELCOMEPAGE_TEXT "Установим приложение и подготовим рабочее пространство для ваших проектов.$\r$\n$\r$\nПри первом запуске мастер поможет выбрать Codex и Claude, установить нужные CLI, применить конфигурацию Codex и войти в аккаунт.$\r$\n$\r$\nПриложение устанавливается для текущего пользователя."
  !endif
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customFinishPage
  Function DeskStartApp
    ${If} ${isUpdated}
      StrCpy $1 "${SETUP_ARGS} --updated"
    ${Else}
      StrCpy $1 "${SETUP_ARGS}"
    ${EndIf}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd
  !define MUI_FINISHPAGE_TITLE "${PRODUCT_NAME} установлен"
  !define MUI_FINISHPAGE_TITLE_3LINES
  !if "${APP_FILENAME}" == "Kuzmich"
    !define MUI_FINISHPAGE_TEXT "Откройте Кузьмич и войдите в Portal один раз в окне приложения — остальное Кузьмич настроит автоматически.$\r$\n$\r$\nМастер настройки можно открыть снова позже в настройках."
  !else
    !define MUI_FINISHPAGE_TEXT "Откройте приложение, чтобы начать работу.$\r$\n$\r$\nМастер первоначальной настройки проверит агентов и предложит следующие шаги. Позже его можно открыть снова в настройках."
  !endif
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

; Is a process alive whose image is exactly _TARGET? Release and Nightly share the
; file name, so only the full path may decide. The path travels in the child
; environment, never as PowerShell source.
; _RESULT: 0 nothing running, 1 running, 2 could not tell.
!macro deskProbeRunning _TARGET _RESULT
  Push $0
  Push $1
  Push $2
  ReadEnvStr $2 "CODEX_DESK_INSTALL_TARGET"
  System::Call 'Kernel32::SetEnvironmentVariableW(w "CODEX_DESK_INSTALL_TARGET", w "${_TARGET}") i.r0'
  ${If} $0 != 0
    nsExec::ExecToStack /TIMEOUT=30000 `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "try { $$target = [IO.Path]::GetFullPath($$env:CODEX_DESK_INSTALL_TARGET); $$name = [IO.Path]::GetFileName($$target); foreach ($$process in @(Get-CimInstance Win32_Process -ErrorAction Stop)) { if ($$process.Name -ne $$name) { continue }; if (-not $$process.ExecutablePath) { exit 2 }; if ([string]::Equals([IO.Path]::GetFullPath($$process.ExecutablePath), $$target, [StringComparison]::OrdinalIgnoreCase)) { exit 1 } }; exit 0 } catch { exit 2 }"`
    Pop $0
    Pop $1
    ${If} $0 != 0
    ${AndIf} $0 != 1
      StrCpy $0 2
    ${EndIf}
  ${Else}
    StrCpy $0 2
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariableW(w "CODEX_DESK_INSTALL_TARGET", w r2) i.r1'
  Pop $2
  Pop $1
  Exch $0
  Pop ${_RESULT}
!macroend

; The upstream NSIS template can fall back to taskkill by executable name.
; Release and Nightly share that name, so never stop applications from Setup.
; In the silent self-update mode the running application closes itself, so here we
; only wait for it — up to ${DESK_UPDATE_WAIT_MS} — and report the outcome.
!macro customCheckAppRunning
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  ; The uninstaller shares this macro but is never the self-update child, and the
  ; silent upgrade runs the old uninstaller with this very environment inherited.
  ; Keep its behaviour exactly as it was.
  !ifdef BUILD_UNINSTALLER
    StrCpy $3 "0"
    StrCpy $4 ""
    StrCpy $5 ""
  !else
  !insertmacro deskUpdateEnv $3 $4 $5
  ${If} $3 == "1"
    ${If} $4 == ""
      StrCpy $4 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
    DetailPrint "Ожидание завершения ${PRODUCT_NAME}…"
    System::Call 'Kernel32::GetTickCount()i.r1'
    ${Do}
      !insertmacro deskProbeRunning "$4" $0
      ${If} $0 == 0
        ${ExitDo}
      ${EndIf}
      System::Call 'Kernel32::GetTickCount()i.r2'
      IntOp $2 $2 - $1
      ${If} $2 >= ${DESK_UPDATE_WAIT_MS}
        ; Give up without installing. The process is never terminated from here.
        ${If} $0 == 1
          !insertmacro deskUpdateReport "timeout"
          SetErrorLevel 2
        ${Else}
          !insertmacro deskUpdateReport "error"
          SetErrorLevel 3
        ${EndIf}
        Quit
      ${EndIf}
      Sleep ${DESK_UPDATE_POLL_MS}
    ${Loop}
    ; Handles go away with the process; a short pause covers the file system.
    Sleep 1500
  ${EndIf}
  !endif
  !insertmacro deskProbeRunning "$INSTDIR\${APP_EXECUTABLE_FILENAME}" $0
  ${If} $0 != 0
    ${If} $3 == "1"
      ${If} $0 == 1
        !insertmacro deskUpdateReport "timeout"
        SetErrorLevel 2
      ${Else}
        !insertmacro deskUpdateReport "error"
        SetErrorLevel 3
      ${EndIf}
      Quit
    ${EndIf}
    ${IfNot} ${Silent}
      ${If} $0 == 1
        MessageBox MB_OK|MB_ICONEXCLAMATION "Закройте Кузьмича и повторите действие. Приложение не будет закрыто автоматически."
      ${Else}
        MessageBox MB_OK|MB_ICONEXCLAMATION "Не удалось проверить, закрыт ли Кузьмич. Закройте приложение и повторите действие."
      ${EndIf}
    ${EndIf}
    Pop $5
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Pop $0
    SetErrorLevel 2
    Abort
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

; Silent self-update only: report success, then bring the application back for the
; current user. The wizard and its finish page are untouched.
!macro customInstall
  Push $0
  Push $1
  Push $2
  !insertmacro deskUpdateEnv $0 $1 $2
  ${If} $0 == "1"
    !insertmacro deskUpdateReport "ok"
    StrCpy $1 "${SETUP_ARGS} --updated"
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" "$1"
    DetailPrint "Запуск ${PRODUCT_NAME} после обновления: $0"
  ${EndIf}
  Pop $2
  Pop $1
  Pop $0
!macroend

!ifndef BUILD_UNINSTALLER
  ; A failed silent self-update still owes the application one line. This callback
  ; is emitted into the generated header, before LogicLib exists, so it is written
  ; with plain instructions instead of ${If}. The refusal paths above exit with
  ; Quit, which does not reach here, so they keep their own report.
  Function .onInstFailed
    IfSilent 0 deskInstFailedDone
    ReadEnvStr $R7 "CODEX_DESK_UPDATE_PID"
    StrCmp $R7 "" deskInstFailedDone
    ReadEnvStr $R9 "CODEX_DESK_UPDATE_LOG"
    StrCmp $R9 "" deskInstFailedDone
    ClearErrors
    FileOpen $R8 "$R9" w
    IfErrors deskInstFailedDone
    FileWrite $R8 "error$\r$\n"
    FileClose $R8
    deskInstFailedDone:
  FunctionEnd
!endif
