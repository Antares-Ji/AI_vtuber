param(
  [string]$AdapterPath,
  [switch]$BaseOnly
)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "runtime\local-llm\.venv\Scripts\python.exe"
if ($BaseOnly) {
  $AdapterPath = ''
} elseif (-not $AdapterPath) {
  $AdapterPath = $env:QWEN_ADAPTER_PATH
  $activeAdapterConfig = Join-Path $projectRoot 'runtime\minecraft-training\active-adapter.json'
  if (-not $AdapterPath -and (Test-Path -LiteralPath $activeAdapterConfig)) {
    $AdapterPath = (Get-Content -LiteralPath $activeAdapterConfig -Raw | ConvertFrom-Json).adapterPath
  }
}
if ($AdapterPath) {
  $resolvedAdapter = (Resolve-Path -LiteralPath $AdapterPath -ErrorAction Stop).Path
  foreach ($requiredFile in @('adapter_config.json', 'adapter_model.safetensors')) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedAdapter $requiredFile) -PathType Leaf)) { throw "Adapter is incomplete: $requiredFile" }
  }
  $python = Join-Path $projectRoot 'runtime\minecraft-training\.venv\Scripts\python.exe'
  $env:QWEN_ADAPTER_PATH = $resolvedAdapter
} else {
  Remove-Item Env:QWEN_ADAPTER_PATH -ErrorAction SilentlyContinue
}
if (-not (Test-Path $python)) { throw "Local LLM runtime is missing. Run scripts\setup-local-llm.ps1 first." }
$env:QWEN_MODEL_PATH = "E:\Qwen3.5-4B"
$env:QWEN_MODEL_NAME = "qwen3.5-4b"
Set-Location $projectRoot
. (Join-Path $PSScriptRoot 'lib\process-lifecycle.ps1')
$lifecyclePath = Join-Path $projectRoot 'logs\llm-launcher-lifecycle.jsonl'
$lifecycleRunId = [guid]::NewGuid().ToString()
$nativeExitCode = $null
$launcherErrorType = ''
Write-ProcessLifecycle -Path $lifecyclePath -Event 'native_start_requested' -RunId $lifecycleRunId
try {
  & $python -m uvicorn src.local_llm.server:app --host 127.0.0.1 --port 11435
  $nativeExitCode = $LASTEXITCODE
} catch {
  $launcherErrorType = $_.Exception.GetType().FullName
  throw
} finally {
  # Abrupt termination of this wrapper cannot execute finally; a missing finish
  # event is evidence of an unobserved exit, not a specific crash/kill cause.
  Write-ProcessLifecycle -Path $lifecyclePath -Event 'native_wait_finished' -RunId $lifecycleRunId -ExitCode $nativeExitCode -ErrorType $launcherErrorType
}
if ($null -ne $nativeExitCode) { exit $nativeExitCode }
