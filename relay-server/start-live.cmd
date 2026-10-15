@echo off
setlocal
set "SCRIPT_DIR=%~dp0scripts"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%\start-live.ps1" %*
exit /b %ERRORLEVEL%
