@echo off
title llm-test 判题服务（Ctrl+C 退出）
cd /d "%~dp0"

rem ===== 定位 Node（含 fnm 默认别名兜底） =====
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do (if not defined NODE_EXE set "NODE_EXE=%%i")
if not defined NODE_EXE if exist "%APPDATA%\fnm\aliases\default\node.exe" set "NODE_EXE=%APPDATA%\fnm\aliases\default\node.exe"
if not defined NODE_EXE (
  echo [错误] 未检测到 Node.js，请先安装 Node 或配置 fnm 后重试。
  pause
  exit /b 1
)

rem ===== 首次运行自动安装依赖 =====
if not exist node_modules (
  echo [初始化] 首次运行，安装依赖中……
  call npm install --no-audit --no-fund || (echo [错误] 依赖安装失败。 & pause & exit /b 1)
)

rem ===== 端口占用检查 =====
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 端口 3000 已被占用——判题服务可能已在运行（可先执行 停止判题服务.bat）。
  pause
  exit /b 1
)

rem ===== 判题沙箱（WSL Docker；离线只影响代码/指令类判分） =====
echo [判题沙箱] 检查 WSL 判题容器……
wsl -d Ubuntu -u root -e bash -lc "systemctl start llmtest-judge-proxy >/dev/null 2>&1; docker start llm-test-judge >/dev/null 2>&1; true" >nul 2>nul
curl -sf --max-time 3 http://127.0.0.1:8901/health >nul 2>nul
if errorlevel 1 (
  echo [判题沙箱] 离线 —— 选择题/长文类评测可用，代码与指令遵循判分不可用。
) else (
  echo [判题沙箱] 在线。
)

echo.
echo [判题服务] http://127.0.0.1:3000 启动中……（按 Ctrl+C 退出服务）
echo ==============================================
rem 服务日志是 UTF-8 输出，切码页保证中文正常显示
chcp 65001 >nul
"%NODE_EXE%" server.js
chcp 936 >nul
echo.
echo [判题服务] 已退出。
pause
