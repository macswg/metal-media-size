@echo off
setlocal EnableDelayedExpansion
rem
rem Media Allocation Analyzer -- start (Windows)
rem
rem Double-click this in Explorer. It checks Node, installs dependencies the
rem first time, starts the read-only server and opens the browser.
rem
rem The server runs IN THIS WINDOW. Close the window, or press Ctrl-C, and it
rem stops. If one is ever left behind, stop-analyser.bat finds it.
rem
rem WHAT IS RUNNING: a read-only analyser bound to 127.0.0.1. It never modifies
rem the archive. See CLAUDE.md for the safety invariants.

if "%PORT%"=="" set PORT=8787
set URL=http://127.0.0.1:%PORT%/

rem Explorer may start us anywhere; work from the folder holding this script.
pushd "%~dp0"

echo Media Allocation Analyzer
echo ================
echo folder : %CD%
echo port   : %PORT%
echo.

rem The port is the source of truth: a pid file can go stale, a listening
rem socket cannot. Only loopback listeners count.
set FOUNDPID=
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /C:"LISTENING" ^| findstr /C:"127.0.0.1:%PORT% " /C:"0.0.0.0:%PORT% "') do (
  if not defined FOUNDPID set FOUNDPID=%%P
)

if defined FOUNDPID (
  rem Is it ours, or just something else on the same port?
  curl -fsS --max-time 2 "http://127.0.0.1:%PORT%/api/health" >nul 2>&1
  if !errorlevel! equ 0 (
    echo Already running ^(pid !FOUNDPID!^). Opening the browser.
    echo To stop it, run stop-analyser.bat.
    start "" "%URL%"
    echo.
    echo Press any key to close this window. The server keeps running.
    pause >nul
    popd
    exit /b 0
  )
  echo.
  echo !! Port %PORT% is held by pid !FOUNDPID!, which is not the analyser.
  echo    Close that program, or start this one on another port:
  echo        set PORT=8788 ^&^& start-analyser.bat
  echo.
  pause
  popd
  exit /b 1
)

where node >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo !! Node is not installed, or is not on PATH.
  echo    Install Node 22.6 or newer from https://nodejs.org and run this again.
  echo.
  pause
  popd
  exit /b 1
)

rem 22.6, not 22. Running TypeScript directly needs --experimental-strip-types,
rem which arrived in a 22.x POINT release -- so a major-only check passes on
rem 22.0 and the server then dies with "bad option", which points nowhere near
rem the real problem. Compared as one number: 22.6 -> 2206, 24.1 -> 2401.
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]*100 + +process.versions.node.split('.')[1]"') do set NODEVER=%%V
if !NODEVER! lss 2206 (
  echo.
  echo !! This Node is too old. It needs Node 22.6 or newer ^(it runs TypeScript
  echo    directly, with no build step, and type stripping arrived in 22.6^).
  echo    Node 24 LTS or later is the easy answer.
  echo.
  node --version
  pause
  popd
  exit /b 1
)
for /f "delims=" %%V in ('node --version') do echo node   : %%V

if not exist node_modules (
  echo.
  echo First run -- installing dependencies. This happens once.
  call npm install
  if !errorlevel! neq 0 (
    echo.
    echo !! npm install failed. The output above says why.
    echo.
    pause
    popd
    exit /b 1
  )
)

rem ------------------------------------------------------------- archive path
rem
rem The scan root is not committed -- it names your storage layout -- so it
rem lives in config\local.json, which is gitignored. If that is missing, or
rem points at a folder that is no longer there (a disconnected drive, a moved
rem archive), ask rather than failing later with a stack trace.
rem
rem A VALID path does not prompt. This runs on every launch, and a confirmation
rem you must dismiss each time is a tax, not a safeguard. To change a working
rem path, run:  start-analyser.bat --set-path

set LOCAL_CONFIG=config\local.json
set ARCHIVEROOT=
if exist "%LOCAL_CONFIG%" (
  for /f "delims=" %%R in ('node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(c&&typeof c.root==='string')process.stdout.write(c.root)}catch{}" "%LOCAL_CONFIG%" 2^>nul') do set ARCHIVEROOT=%%R
)

set NEEDPATH=
if /I "%~1"=="--set-path" (
  if defined ARCHIVEROOT echo current: !ARCHIVEROOT!
  set NEEDPATH=1
) else if not defined ARCHIVEROOT (
  echo.
  echo No archive configured yet.
  set NEEDPATH=1
) else if not exist "!ARCHIVEROOT!\" (
  echo.
  echo !! The configured archive is not there:
  echo      !ARCHIVEROOT!
  echo    If it lives on a network drive, it may simply not be connected.
  set NEEDPATH=1
)

if defined NEEDPATH (
  echo.
  echo Where is your d3 delivery folder?
  echo Drag the folder from Explorer into this window and press Enter.
  echo ^(Or type the path. Press Enter on an empty line to give up.^)
  :askpath
  echo.
  set "INPUTPATH="
  set /p "INPUTPATH=  path: "
  rem Explorer drag-and-drop wraps a path in quotes; strip them.
  if defined INPUTPATH set INPUTPATH=!INPUTPATH:"=!
  if not defined INPUTPATH (
    echo.
    echo !! No archive path set. Nothing to scan.
    echo    Run this again, or create %LOCAL_CONFIG% by hand -- see
    echo    config\local.example.json.
    echo.
    pause
    popd
    exit /b 1
  )
  if not exist "!INPUTPATH!\" (
    echo   !! Not a folder I can see: !INPUTPATH!
    echo      If it is on a network drive, make sure it is connected.
    goto askpath
  )
  rem Written by node so the path is JSON-escaped properly: backslashes and
  rem spaces in a Windows path would otherwise produce a broken config.
  node -e "const fs=require('fs');const[f,root]=process.argv.slice(1);const name=(root.split(/[\\/]/).filter(Boolean).slice(-2,-1)[0]||'archive').toLowerCase().replace(/[^a-z0-9]+/g,'_');fs.writeFileSync(f,JSON.stringify({name,root},null,2)+'\n')" "%LOCAL_CONFIG%" "!INPUTPATH!"
  if !errorlevel! neq 0 (
    echo.
    echo !! Could not write %LOCAL_CONFIG%.
    echo.
    pause
    popd
    exit /b 1
  )
  set ARCHIVEROOT=!INPUTPATH!
  echo.
  echo   Saved to %LOCAL_CONFIG% -- gitignored, it stays on this machine.
)

echo archive: !ARCHIVEROOT!
if /I not "%~1"=="--set-path" echo          ^(to change it: start-analyser.bat --set-path^)

rem Open the browser shortly after the server should be answering. PowerShell
rem rather than nested start/cmd quoting, which is fragile enough to break the
rem launch it is meant to help. Backgrounded so it cannot delay the server.
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process '%URL%'"

echo.
echo Starting. This window keeps the server alive -- close it or press Ctrl-C to stop.
echo   %URL%
echo.

rem Foreground on purpose: the process dies with the window, so closing the
rem window cannot leave an orphan behind.
call npm run serve -- --port %PORT%

echo.
echo Server stopped.
popd
endlocal
