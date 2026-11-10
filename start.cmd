@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem NOTE: keep this file ASCII-only. cmd.exe parses .cmd byte-wise, so Chinese
rem text here gets mangled into commands unless the whole file is ANSI-encoded.
rem
rem This window is only a launcher: it starts the server in the background,
rem then closes itself. The workbench keeps running after this window is gone.
rem To stop it: tray icon (packaged build) or  taskkill /fi "imagename eq node.exe"
rem or  taskkill /pid <pid from data\server.pid>

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [X] Node.js not found.
  echo   This workbench needs Node.js 22.5 or newer ^(24 recommended^).
  echo   Download: https://nodejs.org
  echo.
  pause
  exit /b 1
)

set NODE_MAJOR=
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if not defined NODE_MAJOR (
  echo.
  echo   [X] Could not read the Node.js version. Please reinstall Node.js 22.5+.
  echo.
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo.
  echo   [X] Node.js %NODE_MAJOR%.x is too old. Need 22.5 or newer.
  echo   Run  node -v  to check, then upgrade from https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo Starting workbench...
node scripts\launch.mjs
if errorlevel 1 (
  echo.
  echo Startup failed - see data\server.log for details.
  pause
  exit /b 1
)

rem Successful start: the server now runs detached, the browser is opening.
rem Give the message half a second to be readable, then close this window.
ping -n 2 127.0.0.1 >nul 2>nul
exit /b 0
