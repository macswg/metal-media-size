@echo off
setlocal EnableDelayedExpansion
rem
rem Archive Analyser -- stop (Windows)
rem
rem Double-click this in Explorer to stop a running analyser, including one
rem left behind by a window that was closed badly, or one started from a
rem different window than the one you are looking at.
rem
rem It stops the SERVER only. Nothing in the archive is affected -- the server
rem never modified it in the first place.

if "%PORT%"=="" set PORT=8787

pushd "%~dp0"

echo Archive Analyser -- stop
echo ========================
echo port : %PORT%
echo.

set FOUNDPID=
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /C:"LISTENING" ^| findstr /C:"127.0.0.1:%PORT% " /C:"0.0.0.0:%PORT% "') do (
  if not defined FOUNDPID set FOUNDPID=%%P
)

if not defined FOUNDPID (
  echo Nothing is listening on port %PORT%. Nothing to stop.
  echo.
  pause
  popd
  exit /b 0
)

rem Refuse to kill a stranger. If some other program has the port, saying so is
rem far better than terminating it because it was in the way.
curl -fsS --max-time 2 "http://127.0.0.1:%PORT%/api/health" >nul 2>&1
if !errorlevel! neq 0 (
  echo Port %PORT% is held by pid !FOUNDPID!, but it does not answer as the analyser:
  echo.
  tasklist /FI "PID eq !FOUNDPID!" 2>nul
  echo.
  echo Left alone. Stop that program yourself if you meant to.
  echo.
  pause
  popd
  exit /b 1
)

echo Stopping the analyser ^(pid !FOUNDPID!^)...

rem Ask politely first: serve.ts handles SIGTERM, closing the HTTP server and
rem the SQLite handle before exiting. taskkill without /F sends the close
rem request; /F is the forced fallback below.
taskkill /PID !FOUNDPID! >nul 2>&1
timeout /t 3 /nobreak >nul

tasklist /FI "PID eq !FOUNDPID!" 2>nul | findstr /C:"!FOUNDPID!" >nul
if !errorlevel! equ 0 (
  echo It did not exit on request. Forcing.
  taskkill /F /PID !FOUNDPID! /T >nul 2>&1
  timeout /t 1 /nobreak >nul
)

set STILL=
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /C:"LISTENING" ^| findstr /C:"127.0.0.1:%PORT% " /C:"0.0.0.0:%PORT% "') do (
  if not defined STILL set STILL=%%P
)

if defined STILL (
  echo.
  echo Port %PORT% is STILL held by pid !STILL!. Something is wrong; check by hand:
  echo     netstat -ano ^| findstr :%PORT%
  echo.
  pause
  popd
  exit /b 1
)

echo Stopped. Port %PORT% is free.
echo.
pause
popd
endlocal
