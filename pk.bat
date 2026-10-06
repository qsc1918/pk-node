@echo off
rem ============================================================================
rem  pk-node - one-click launcher and GitHub uploader for Windows
rem
rem  Usage:
rem    pk.bat                start the server (same as: pk.bat start)
rem    pk.bat start          start in background (auto-avoids a busy port)
rem    pk.bat stop           stop
rem    pk.bat restart        restart
rem    pk.bat status         show status
rem    pk.bat log            follow the log (Ctrl-C to exit)
rem    pk.bat open           open the admin page in a browser
rem    pk.bat push [msg]     commit and push to GitHub
rem    pk.bat tag v1.2.3     selftest, tag, push (CI builds the Release)
rem    pk.bat all [msg]      start + wait ready + push
rem    pk.bat test           run selftest only
rem    pk.bat help           this help
rem
rem  Env vars:
rem    set PK_PORT=9000      preferred port (auto-increments if busy)
rem    set PK_HOST=127.0.0.1 listen on localhost only
rem    set PK_YES=1          skip the release confirmation prompt
rem    set PK_NO_OPEN=1      do not open a browser after start
rem
rem  Requires: node >= 22, git. No npm install needed.
rem
rem  NOTE: this file must stay CRLF - cmd.exe breaks on LF line endings.
rem        Real startup logic (version check, free port, banner) lives in
rem        bin\start.js, shared with start.bat. This script only orchestrates.
rem
rem  NOTE: deliberately avoids EnableDelayedExpansion. Variables are never
rem        set and read inside the same parenthesised block; that pattern
rem        silently expands to the OLD value and is a classic cmd.exe trap.
rem ============================================================================

setlocal EnableExtensions
chcp 65001 >nul 2>&1
cd /d "%~dp0"

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "RUNDIR=%ROOT%\run"
set "LOG=%RUNDIR%\pk-node.log"
set "PIDFILE=%RUNDIR%\pk-node.pid"
if not defined PK_PORT set "PK_PORT=8792"

set "CMD=%~1"
if "%CMD%"=="" set "CMD=start"
shift

if /i "%CMD%"=="start"    goto :cmd_start
if /i "%CMD%"=="stop"     goto :cmd_stop
if /i "%CMD%"=="restart"  goto :cmd_restart
if /i "%CMD%"=="status"   goto :cmd_status
if /i "%CMD%"=="st"       goto :cmd_status
if /i "%CMD%"=="log"      goto :cmd_log
if /i "%CMD%"=="open"     goto :cmd_open
if /i "%CMD%"=="push"     goto :cmd_push
if /i "%CMD%"=="upload"   goto :cmd_push
if /i "%CMD%"=="tag"      goto :cmd_tag
if /i "%CMD%"=="release"  goto :cmd_tag
if /i "%CMD%"=="test"     goto :cmd_test
if /i "%CMD%"=="all"      goto :cmd_all
if /i "%CMD%"=="help"     goto :cmd_help
if /i "%CMD%"=="-h"       goto :cmd_help
if /i "%CMD%"=="--help"   goto :cmd_help

echo [x] unknown command: %CMD%
echo.
goto :cmd_help

rem ============================================================================
rem  helpers
rem ============================================================================

:need_node
where node >nul 2>&1
if errorlevel 1 (
  echo [x] Node.js not found. Install Node.js 22+ from https://nodejs.org/
  exit /b 1
)
set "NODEMAJOR=0"
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODEMAJOR=%%v"
if %NODEMAJOR% LSS 22 (
  echo [x] Node.js too old, need 22 or newer ^(uses built-in node:sqlite^)
  node -v
  exit /b 1
)
exit /b 0

rem Read the ACTUAL listening port from the log. bin\start.js may bump the port
rem when the preferred one is busy, so we must never assume PK_PORT is in use.
rem Writes result to PORT; returns 1 when nothing found.
:detect_port
set "PORT="
if not exist "%LOG%" exit /b 1
for /f "delims=" %%p in ('node -e "const fs=require('fs');try{const s=fs.readFileSync(process.argv[1],'utf8');const m=s.match(/http:\/\/[0-9.]+:(\d+)/g);if(m)process.stdout.write(m[m.length-1].replace(/.*:/,''))}catch(e){}" "%LOG%" 2^>nul') do set "PORT=%%p"
if not defined PORT exit /b 1
exit /b 0

rem Sets PKPID from the pid file when that process is still alive.
:is_running
set "PKPID="
if not exist "%PIDFILE%" exit /b 1
set /p PKPID=<"%PIDFILE%"
if not defined PKPID exit /b 1
tasklist /FI "PID eq %PKPID%" 2>nul | find "%PKPID%" >nul
if errorlevel 1 exit /b 1
exit /b 0

rem Finds the PID listening on %PORT% via netstat. Sets PKPID.
:pid_by_port
set "PKPID="
if not defined PORT exit /b 1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%PORT% " ^| findstr LISTENING') do set "PKPID=%%a"
if not defined PKPID exit /b 1
exit /b 0

rem HTTP probe against 127.0.0.1:%PORT%
:probe
if not defined PORT exit /b 1
node -e "require('http').get({host:'127.0.0.1',port:+process.argv[1],path:'/'},r=>{r.destroy();process.exit(0)}).on('error',()=>process.exit(1))" %PORT% >nul 2>&1
exit /b %ERRORLEVEL%

rem ============================================================================
rem  start
rem ============================================================================

:cmd_start
call :need_node
if errorlevel 1 exit /b 1

call :is_running
if not errorlevel 1 goto :start_already

if not exist "%RUNDIR%" mkdir "%RUNDIR%"
if exist "%LOG%" move /y "%LOG%" "%LOG%.prev" >nul 2>&1
type nul > "%LOG%"

echo ==^> starting pk-node
echo     dir : %ROOT%
echo     log : %LOG%

start "pk-node" /min /d "%ROOT%" cmd /c "node bin\start.js >> run\pk-node.log 2>&1"

echo     waiting for ready ...
set "WR_TRY=0"
:wait_ready
set /a WR_TRY+=1
if %WR_TRY% GTR 80 goto :start_timeout
call :detect_port
if not defined PORT goto :wait_sleep
call :probe
if not errorlevel 1 goto :start_ok
:wait_sleep
ping -n 2 127.0.0.1 >nul 2>&1
goto :wait_ready

:start_ok
call :pid_by_port
if not defined PKPID set "PKPID=?"
if "%PKPID%"=="?" goto :start_report
>"%PIDFILE%" echo %PKPID%

:start_report
echo [ok] running on http://127.0.0.1:%PORT%/
echo.
echo       admin : http://127.0.0.1:%PORT%/
echo       stop  : pk.bat stop
echo       log   : pk.bat log
if "%PK_NO_OPEN%"=="1" exit /b 0
start "" "http://127.0.0.1:%PORT%/"
exit /b 0

:start_already
call :detect_port
if not defined PORT set "PORT=%PK_PORT%"
echo [!] already running ^(pid %PKPID%, port %PORT%^)
echo     to restart: pk.bat restart
exit /b 0

:start_timeout
echo [x] not ready after 40s
echo --- log tail ---
if exist "%LOG%" powershell -NoProfile -Command "Get-Content -Path '%LOG%' -Tail 25" 2>nul
exit /b 1

rem ============================================================================
rem  stop / restart / status / log / open
rem ============================================================================

:cmd_stop
set "DIDSTOP=0"
set "PKPID="
if exist "%PIDFILE%" set /p PKPID=<"%PIDFILE%"
if not defined PKPID goto :stop_by_port

echo     stopping pid %PKPID% ...
taskkill /PID %PKPID% /T /F >nul 2>&1
set "DIDSTOP=1"
del /f /q "%PIDFILE%" >nul 2>&1

:stop_by_port
call :detect_port
if not defined PORT goto :stop_done
set "PKPID="
call :pid_by_port
if not defined PKPID goto :stop_done
echo [!] port %PORT% still held by pid %PKPID%, killing it too
taskkill /PID %PKPID% /T /F >nul 2>&1
if exist "%PIDFILE%" del /f /q "%PIDFILE%" >nul 2>&1
set "DIDSTOP=1"

:stop_done
if "%DIDSTOP%"=="1" echo [ok] stopped
if not "%DIDSTOP%"=="1" echo [!] not running
exit /b 0

:cmd_restart
call :cmd_stop
ping -n 2 127.0.0.1 >nul 2>&1
goto :cmd_start

:cmd_status
echo pk-node status
echo     dir      : %ROOT%
set "VER=?"
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "VER=%%v"
echo     version  : %VER%
call :is_running
if errorlevel 1 goto :status_down

call :detect_port
if not defined PORT set "PORT=%PK_PORT%"
echo     process  : running ^(pid %PKPID%^)
echo     port     : %PORT%
call :probe
if errorlevel 1 echo     health   : no response
if not errorlevel 1 echo     health   : ok  http://127.0.0.1:%PORT%/
goto :status_git

:status_down
echo     process  : not running
echo     start    : pk.bat start

:status_git
echo.
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do echo     branch   : %%b
for /f %%n in ('git status --porcelain 2^>nul ^| find /c /v ""') do echo     unstaged : %%n files
for /f %%n in ('git rev-list --count "@{u}..HEAD" 2^>nul') do echo     unpushed : %%n commits
exit /b 0

:cmd_log
if not exist "%LOG%" (
  echo [x] no log yet: %LOG%  - run "pk.bat start" first
  exit /b 1
)
echo following %LOG% - Ctrl-C to exit
powershell -NoProfile -Command "Get-Content -Path '%LOG%' -Tail 60 -Wait"
exit /b 0

:cmd_open
call :detect_port
if not defined PORT set "PORT=%PK_PORT%"
start "" "http://127.0.0.1:%PORT%/"
echo [ok] opening http://127.0.0.1:%PORT%/
exit /b 0

rem ============================================================================
rem  push / tag  - upload to GitHub
rem ============================================================================

:ensure_git
where git >nul 2>&1
if errorlevel 1 (
  echo [x] git not found
  exit /b 1
)
git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo [x] %ROOT% is not a git repository
  exit /b 1
)
git remote get-url origin >nul 2>&1
if errorlevel 1 (
  echo [x] origin remote is not configured
  exit /b 1
)
exit /b 0

:cmd_push
call :ensure_git
if errorlevel 1 exit /b 1

set "MSG=%~1"
if "%MSG%"=="" set "MSG=chore: sync update"

echo ==^> commit and upload to GitHub

rem safety: never let runtime data (holds plaintext cookies) get committed
if not exist "%ROOT%\data" goto :push_stage
git check-ignore -q "data" >nul 2>&1
if not errorlevel 1 goto :push_stage
echo [!] data\ is NOT gitignored and holds plaintext login state. Aborting.
echo     add "data/" to .gitignore and retry.
exit /b 1

:push_stage
git add -A
git diff --cached --quiet >nul 2>&1
if errorlevel 1 goto :push_commit
echo     nothing to commit
goto :push_send

:push_commit
set "STAGED=0"
for /f %%n in ('git diff --cached --name-only ^| find /c /v ""') do set "STAGED=%%n"
echo     files staged: %STAGED%
git commit -q -m "%MSG%"
if errorlevel 1 (
  echo [x] commit failed
  exit /b 1
)
echo [ok] committed: %MSG%

:push_send
set "BRANCH=main"
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
echo     pushing to origin/%BRANCH% ...
git push origin %BRANCH%
if errorlevel 1 (
  echo [x] push failed ^(network / credentials / out of date^)
  exit /b 1
)
echo [ok] uploaded
git log -1 --format="      %%h %%s"
exit /b 0

:cmd_tag
call :ensure_git
if errorlevel 1 exit /b 1

set "TAG=%~1"
if "%TAG%"=="" (
  echo usage: pk.bat tag v1.10.5
  exit /b 1
)

echo ==^> release %TAG%
echo     flow: selftest, tag, push, then GitHub Actions builds the Release
if "%PK_YES%"=="1" goto :tag_selftest
set "ANS="
set /p ANS=    continue? [y/N] 
if /i "%ANS%"=="y" goto :tag_selftest
echo [!] cancelled
exit /b 1

:tag_selftest
echo     running selftest ...
node bin\selftest.js
if errorlevel 1 (
  echo [x] selftest failed, aborting release
  exit /b 1
)

set "DIRTY=0"
for /f %%n in ('git status --porcelain ^| find /c /v ""') do set "DIRTY=%%n"
if "%DIRTY%"=="0" goto :tag_apply
echo [!] working tree dirty, committing first
call :cmd_push "chore: release %TAG%"
if errorlevel 1 exit /b 1

:tag_apply
git tag -f %TAG%
if errorlevel 1 (
  echo [x] tag failed
  exit /b 1
)
git push origin %TAG% -f
if errorlevel 1 (
  echo [x] push tag failed
  exit /b 1
)
echo [ok] pushed %TAG% - CI is building the Release
echo     check the Actions tab of your repo
exit /b 0

rem ============================================================================
rem  test / all / help
rem ============================================================================

:cmd_test
call :need_node
if errorlevel 1 exit /b 1
echo ==^> selftest
node bin\selftest.js
exit /b %ERRORLEVEL%

:cmd_all
call :cmd_start
if errorlevel 1 exit /b 1
echo.
call :cmd_push "%~1"
exit /b %ERRORLEVEL%

:cmd_help
echo pk-node - one-click launcher and GitHub uploader
echo.
echo   pk.bat                start the server
echo   pk.bat start          start in background
echo   pk.bat stop           stop
echo   pk.bat restart        restart
echo   pk.bat status         show status
echo   pk.bat log            follow the log
echo   pk.bat open           open the admin page
echo   pk.bat push [msg]     commit and push to GitHub
echo   pk.bat tag v1.2.3     selftest, tag, push (CI builds Release)
echo   pk.bat all [msg]      start + wait ready + push
echo   pk.bat test           run selftest only
echo   pk.bat help           this help
echo.
echo   default port %PK_PORT% (auto-increments if busy); set PK_PORT to change.
echo   PK_YES=1 skips the release prompt; PK_NO_OPEN=1 skips opening a browser.
exit /b 0