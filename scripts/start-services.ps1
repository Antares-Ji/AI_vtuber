$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$logsDir = Join-Path $projectRoot "logs"
$asrScript = Join-Path $PSScriptRoot "start-asr.ps1"
$localLlmScript = Join-Path $PSScriptRoot "start-local-llm.ps1"
$gptSovitsScript = Join-Path $PSScriptRoot "start-gpt-sovits.ps1"
$serverScript = Join-Path $projectRoot "src\server.js"

New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Test-ListeningPort([int]$Port) {
  return [bool](Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq $Port)
}

function Wait-ForEndpoint([string]$Name, [string]$Url, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
      if ($response.StatusCode -eq 200) {
        Write-Host "$Name is ready: $Url"
        return
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  } while ((Get-Date) -lt $deadline)

  throw "$Name did not become ready within $TimeoutSeconds seconds. Check logs in $logsDir."
}

function Wait-ForListeningPort([string]$Name, [int]$Port, [int]$TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    if (Test-ListeningPort $Port) {
      Write-Host "$Name is ready on port $Port."
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "$Name did not listen on port $Port within $TimeoutSeconds seconds. Check logs in $logsDir."
}

Set-Location $projectRoot

if (Test-Path (Join-Path $projectRoot "runtime\local-llm\.venv\Scripts\python.exe")) {
  if (Test-ListeningPort 11435) {
    Write-Host "Local Qwen is already listening on port 11435."
  } else {
    $localLlmProcess = Start-Process `
      -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $localLlmScript) `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logsDir "local-llm.out.log") `
      -RedirectStandardError (Join-Path $logsDir "local-llm.err.log") `
      -PassThru
    Write-Host "Started local Qwen in background (PID $($localLlmProcess.Id))."
  }
}

if (Test-ListeningPort 10095) {
  Write-Host "ASR is already listening on port 10095."
} else {
  $asrProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $asrScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "asr.out.log") `
    -RedirectStandardError (Join-Path $logsDir "asr.err.log") `
    -PassThru
  Write-Host "Started ASR in background (PID $($asrProcess.Id))."
}

if (Test-ListeningPort 9880) {
  Write-Host "GPT-SoVITS is already listening on port 9880."
} else {
  $gptSovitsProcess = Start-Process `
    -FilePath "powershell.exe" `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $gptSovitsScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "gpt-sovits.out.log") `
    -RedirectStandardError (Join-Path $logsDir "gpt-sovits.err.log") `
    -PassThru
  Write-Host "Started GPT-SoVITS in background (PID $($gptSovitsProcess.Id))."
}

if (Test-ListeningPort 3000) {
  Write-Host "Main server is already listening on port 3000."
} else {
  $node = (Get-Command node -ErrorAction Stop).Source
  $serverProcess = Start-Process `
    -FilePath $node `
    -ArgumentList @($serverScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logsDir "server.out.log") `
    -RedirectStandardError (Join-Path $logsDir "server.err.log") `
    -PassThru
  Write-Host "Started main server in background (PID $($serverProcess.Id))."
}

Wait-ForEndpoint "Main server" "http://127.0.0.1:3000/api/health" 30
Wait-ForEndpoint "ASR" "http://127.0.0.1:10095/health" 120
Wait-ForEndpoint "Local Qwen" "http://127.0.0.1:11435/health" 240
Wait-ForListeningPort "GPT-SoVITS" 9880 180
Write-Host "All services are running in the background."
