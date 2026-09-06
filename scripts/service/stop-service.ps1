# 停止判题服务：结束 3000 端口上的 node 进程并弹 Windows 通知
$ErrorActionPreference = 'SilentlyContinue'
$serviceDir = Split-Path -Parent $PSCommandPath
$root = Split-Path -Parent (Split-Path -Parent $serviceDir)
Set-Location $root
$toast = Join-Path $serviceDir 'toast.ps1'

$target = $null
$pidFile = Join-Path $root 'data\service.pid'
$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (Test-Path $pidFile) {
  $candidate = [int](Get-Content $pidFile -First 1).Trim()
  # pidfile 里的进程必须仍是 3000 的监听者，失效则回退端口探测
  if ($listener -and $listener.OwningProcess -eq $candidate) { $target = $candidate }
}
if (-not $target -and $listener) { $target = $listener.OwningProcess }

if (-not $target) { & $toast '判题服务未在运行'; exit 1 }

Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
Remove-Item $pidFile -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) {
  & $toast '判题服务停止失败，请手动结束 node 进程'
  exit 1
}
& $toast '判题服务已停止'
