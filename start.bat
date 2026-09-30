@echo off
rem ============================================================
rem  pk-node 启动脚本（Windows）
rem
rem  用法：双击，或在 cmd 里执行 start.bat
rem       set PK_PORT=9000 & start.bat     换端口
rem       set PK_HOST=0.0.0.0 & start.bat  局域网可访问
rem
rem  ------------------------------------------------------------
rem  ✅ Windows 上可以**完整刷局**（含 PK 出题 + 提交）
rem
rem  原因：两个原本依赖 arm64 原生库的环节都已解决
rem    1) 内容编码器 —— 已拆解为「固定密钥流 XOR」，纯 JS 实现
rem       （bin/keystream.bin + src/keystream.js）
rem    2) sign —— 实测 PK 的 home / match / submit 三个端点**不需要**它
rem       （不带 sign 时均 200）。但 **switch（切子账号）/ batchGet（子账号名字）
rem       需要 sign**，而 sign 依赖 arm64 原生库 → 这两个功能在 Windows 上不可用
rem       （默认 PK_SIGN_MODE=auto：算得出就带，算不出就跳过）
rem
rem  所以不需要 bin\native\ 里的 arm64 库，也不需要 WSL/qemu。
rem  bin\native\ 可以整个删掉，只保留 bin\keystream.bin。
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
if not defined PK_PORT set PK_PORT=8792

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

if not exist "bin\keystream.bin" (
  echo [!] 缺少 bin\keystream.bin —— 内容编码器需要它（纯 JS 密钥流）。
  echo     在 arm64 设备上运行: node tools\keystream-extract.js
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
