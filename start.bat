@echo off
rem ============================================================
rem  pk-node 启动脚本（Windows）
rem
rem  用法：双击，或在 cmd 里执行 start.bat
rem       set PK_PORT=9000 & start.bat     换端口
rem       set PK_HOST=0.0.0.0 & start.bat  局域网可访问
rem
rem  ------------------------------------------------------------
rem  ⚠️ 重要：Windows 上只有「网页 + 数据库 + 登录」能用
rem
rem  PK 刷局需要 bin\native\ 里的 arm64 Android 原生库（linker64 / *.so），
rem  它们只能在 Linux arm64 / Android(proot|Termux) 里跑，Windows 跑不了；
rem  另外内容编码依赖系统 gzip（Windows 10 1803+ 自带，老版本没有）。
rem
rem  想完整体验 PK 刷局，请用：
rem    - Android + Termux/proot（推荐，就是本项目的开发环境）
rem    - 或 WSL2 (Ubuntu arm64) / 树莓派等 arm64 Linux
rem  在 Windows 上本脚本主要用于：跑 web 界面、看代码、跑纯 JS 自检。
rem ============================================================

setlocal
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo == pk-node ==

where node >nul 2>&1
if errorlevel 1 (
  echo [x] 未找到 node，请先安装 Node.js 22+（推荐 24）: https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODE_VER=%%v
for /f "delims=" %%m in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%m

echo node      : v%NODE_VER%
if %NODE_MAJOR% LSS 22 (
  echo [x] Node 版本过低，需要 ^>= 22（用到 node:sqlite）
  pause
  exit /b 1
)

if not defined PK_HOST set PK_HOST=127.0.0.1

rem ---- 端口：被占就往后找一个空的（用 node 自己试最准）----
if not defined PK_PORT set PK_PORT=8787

set PORT=
for /f "delims=" %%p in ('node bin\pick-port.js %PK_PORT% 8820 2^>nul') do set PORT=%%p
if not defined PORT (
  echo [x] %PK_PORT%~8819 都被占用了，请先 set PK_PORT=空闲端口
  pause
  exit /b 1
)
if not "%PORT%"=="%PK_PORT%" echo 提示：%PK_PORT% 被占用，自动改用 %PORT%

echo 监听      : http://%PK_HOST%:%PORT%
echo native    : %cd%\bin\native

if not exist "bin\native\linker64" (
  echo.
  echo [!] 缺少 bin\native 原生资产：网页/登录/数据库可用，
  echo     PK 刷局会失败（需要 arm64 Linux / Android）。
)

echo.
echo 正在启动…… 浏览器打开 http://%PK_HOST%:%PORT%   （默认账号 admin / admin）
echo 停止服务：在本窗口按 Ctrl+C
echo.

set PK_PORT=%PORT%
node server.js

echo.
echo 服务已退出。
pause
