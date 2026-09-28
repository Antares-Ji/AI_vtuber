$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $projectRoot "src\server.js"
$logsDir = Join-Path $projectRoot "logs"
function Get-MainListener {
  Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq 3000 | Select-Object -First 1
}
$connection = Get-MainListener

if ($connection) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction Stop
  $commandMatches = $process -and ($process.CommandLine -like "*$serverScript*")
  if (!$process -or $process.Name -notmatch '^node(\.exe)?$' -or !$commandMatches) {
    throw "Refusing to stop port 3000 because it is not this project's src/server.js process."
  }
  Stop-Process -Id $connection.OwningProcess -Force
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-MainListener) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if (Get-MainListener) { throw "Old main server still owns port 3000; restart aborted." }
}

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$expectedInstance = [guid]::NewGuid().ToString()
$previousInstance = $env:AI_VTUBER_INSTANCE_ID
$env:AI_VTUBER_INSTANCE_ID = $expectedInstance
try {
$started = Start-Process `
  -FilePath $node `
  -ArgumentList @($serverScript) `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logsDir "server.out.log") `
  -RedirectStandardError (Join-Path $logsDir "server.err.log") `
  -PassThru
} finally { $env:AI_VTUBER_INSTANCE_ID = $previousInstance }

$deadline = (Get-Date).AddSeconds(30)
do {
  $started.Refresh()
  if ($started.HasExited) { throw "New main server exited before verified readiness. Check logs/server.err.log." }
  try {
    $response = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 2
    if ($response.ok -and $response.instance.id -eq $expectedInstance -and $response.instance.pid -eq $started.Id) {
      Write-Host "Main server restarted and identity verified (PID $($started.Id), instance $expectedInstance)."
      exit 0
    }
  } catch {
  }
  Start-Sleep -Milliseconds 400
} while ((Get-Date) -lt $deadline)

throw "Main server did not become healthy after restart. Check logs/server.err.log."
