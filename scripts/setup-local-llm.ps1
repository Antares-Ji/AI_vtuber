$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot "runtime\local-llm"
$venvPython = Join-Path $runtimeRoot ".venv\Scripts\python.exe"
$uv = (Get-Command uv.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (-not (Test-Path $venvPython)) {
  & $uv venv (Join-Path $runtimeRoot ".venv") --python 3.12
}
& $uv pip install --python $venvPython torch torchvision --index-url https://download.pytorch.org/whl/cu128
& $uv pip install --python $venvPython "transformers>=4.57" accelerate bitsandbytes fastapi "uvicorn[standard]" pillow safetensors
Write-Host "Local LLM runtime is ready at $runtimeRoot"
