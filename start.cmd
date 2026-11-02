@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem NOTE: keep this file ASCII-only. cmd.exe parses .cmd byte-wise, so Chinese
rem text here gets mangled into commands unless the whole file is ANSI-encoded.

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
echo Your browser will open automatically.
echo Closing this window stops the workbench; your data stays in workbench\data.
echo.
node src\server.mjs
if errorlevel 1 (
  echo.
  echo Startup failed. Send the error above to whoever maintains this copy.
  pause
)
