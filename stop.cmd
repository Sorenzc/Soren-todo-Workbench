@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem NOTE: keep this file ASCII-only (see start.cmd).
rem Stops the background workbench started by start.cmd.

node scripts\stop.mjs
if errorlevel 1 (
  echo.
  pause
  exit /b 1
)
ping -n 2 127.0.0.1 >nul 2>nul
exit /b 0
