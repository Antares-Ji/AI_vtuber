$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$python = Join-Path $projectRoot 'runtime\minecraft-training\.venv\Scripts\python.exe'
$adapter = Join-Path $projectRoot 'runtime\minecraft-training\adapters\minecraft-survival-v1'
$logs = Join-Path $projectRoot 'output\minecraft-training'
$port = 11435

if (-not (Test-Path -LiteralPath $python)) { throw "Training Python not found: $python" }
if (-not (Test-Path -LiteralPath (Join-Path $adapter 'adapter_model.safetensors'))) { throw "Adapter weights not found: $adapter" }
if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
  throw "Port $port already has a listener; refusing to start another model server."
}
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$savedModelPath = $env:QWEN_MODEL_PATH
$savedModelName = $env:QWEN_MODEL_NAME
$savedAdapterPath = $env:QWEN_ADAPTER_PATH
$env:QWEN_MODEL_PATH = 'E:\Qwen3.5-4B'
$env:QWEN_MODEL_NAME = 'qwen3.5-4b'
$env:QWEN_ADAPTER_PATH = $adapter
try {
  $process = Start-Process -FilePath $python `
    -ArgumentList @('-m', 'uvicorn', 'src.local_llm.server:app', '--host', '127.0.0.1', '--port', "$port") `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logs 'adapter-server.out.log') `
    -RedirectStandardError (Join-Path $logs 'adapter-server.err.log')
} finally {
  $env:QWEN_MODEL_PATH = $savedModelPath
  $env:QWEN_MODEL_NAME = $savedModelName
  $env:QWEN_ADAPTER_PATH = $savedAdapterPath
}

$deadline = (Get-Date).AddMinutes(2)
$health = $null
do {
  $process.Refresh()
  if ($process.HasExited) {
    Get-Content (Join-Path $logs 'adapter-server.err.log') -Tail 80 -ErrorAction SilentlyContinue
    throw "Adapter server exited during startup (PID $($process.Id))."
  }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    if ($health.ok) { break }
  } catch {}
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if (-not $health -or -not $health.ok) {
  Get-Content (Join-Path $logs 'adapter-server.err.log') -Tail 80 -ErrorAction SilentlyContinue
  throw "Adapter server health timeout (PID $($process.Id))."
}
if (-not $health.adapter_loaded -or -not $health.adapter -or $health.adapter_scope -ne 'minecraft-survival') {
  throw "Adapter server loaded with unexpected scope: $($health | ConvertTo-Json -Compress)"
}
[PSCustomObject]@{
  PID = $process.Id
  Health = ($health | ConvertTo-Json -Compress)
  Stdout = Join-Path $logs 'adapter-server.out.log'
  Stderr = Join-Path $logs 'adapter-server.err.log'
} | Format-List
