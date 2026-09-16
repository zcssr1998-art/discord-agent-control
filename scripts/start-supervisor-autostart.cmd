@echo off
rem P2.2B daily bootstrap for the Jarvis auto-start task.
rem The Task Scheduler runs THIS wrapper; the wrapper runs the supervisor
rem (which owns bridge restart/backoff + LiteLLM lifecycle) and appends all
rem supervisor output to logs\wrapper.log for on-machine diagnostics.
set "REPO=%~dp0.."
cd /d "%REPO%"
if not exist "%REPO%\logs" mkdir "%REPO%\logs"
echo [%DATE% %TIME%] autostart bootstrap: %~f0 >> "%REPO%\logs\wrapper.log"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO%\scripts\start-supervisor.ps1" >> "%REPO%\logs\wrapper.log" 2>&1
echo [%DATE% %TIME%] autostart wrapper exited with %ERRORLEVEL% >> "%REPO%\logs\wrapper.log"
