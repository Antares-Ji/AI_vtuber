$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path $projectRoot "runtime\local-llm\.venv\Scripts\python.exe"
if (-not (Test-Path $python)) { throw "Local LLM runtime is missing. Run scripts\setup-local-llm.ps1 first." }
$env:QWEN_MODEL_PATH = "E:\Qwen3.5-4B"
$env:QWEN_MODEL_NAME = "qwen3.5-4b"
Set-Location $projectRoot
& $python -m uvicorn src.local_llm.server:app --host 127.0.0.1 --port 11435
