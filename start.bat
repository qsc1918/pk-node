@echo off
rem ============================================================
rem  pk-node launcher for Windows
rem
rem  Usage:
rem    double-click this file, or run  start.bat  in cmd
rem    set PK_PORT=9000     then run  start.bat    to change port
rem    set PK_HOST=0.0.0.0  then run  start.bat    to expose on LAN
rem
rem  All real logic - node version check, free-port picking, banner -
rem  lives in bin\start.js. This file stays tiny, ASCII-only and CRLF
rem  on purpose: cmd.exe requires CRLF, and an LF batch file breaks
rem  multi-line blocks like "if errorlevel 1 ..." without any message.
rem ============================================================

setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto nonode

node "%~dp0bin\start.js"
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" echo [x] pk-node exited with code %EXITCODE%
echo [press any key to close]
pause >nul
exit /b %EXITCODE%

:nonode
echo [x] Node.js not found. Install Node.js 22+ from https://nodejs.org/
echo.
pause
exit /b 1
