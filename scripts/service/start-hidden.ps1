# 隐式启动判题服务：无窗口启动 node，就绪后弹 Windows 通知
$ErrorActionPreference = 'SilentlyContinue'
$serviceDir = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent (Split-Path -Parent $serviceDir)
Set-Location $root
$toast = Join-Path $serviceDir 'toast.ps1'
$failMsg = '判题服务启动失败，请检查 Node 环境或端口占用'

# 定位 Node（fnm 默认别名兜底）
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $fnm = Join-Path $env:APPDATA 'fnm\aliases\default\node.exe'
  if (Test-Path $fnm) { $node = $fnm }
}
if (-not $node) { & $toast $failMsg; exit 1 }

# 已在运行则直接通知
$busy = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($busy) { & $toast '判题服务已在运行中'; exit 0 }

# 首次运行安装依赖
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Push-Location $root
  cmd /c "npm install --no-audit --no-fund" | Out-Null
  Pop-Location
}

# 尽力拉起 WSL 判题沙箱（离线只影响代码/指令类判分，不阻塞启动）
wsl -d Ubuntu -u root -e bash -lc "systemctl start llmtest-judge-proxy >/dev/null 2>&1; docker start llm-test-judge >/dev/null 2>&1; true" 2>$null | Out-Null

# 隐藏窗口启动 node 并记录 PID（供停止脚本使用）
$p = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $root 'data\service.pid') -Value $p.Id -Encoding Ascii

# 等待服务就绪（最长 20s）
$up = $false
foreach ($i in 1..20) {
  Start-Sleep -Seconds 1
  try { Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/preflight' -TimeoutSec 2 | Out-Null; $up = $true; break } catch { }
}
if ($up) { & $toast '判题服务启动成功' } else { & $toast $failMsg }
