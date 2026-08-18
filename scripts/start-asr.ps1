$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$officialBundle = "E:\GPT-SoVITS-v2pro-20250604-nvidia50\GPT-SoVITS-v2pro-20250604-nvidia50"
$python = Join-Path $officialBundle "runtime\python.exe"

if (!(Test-Path $python)) { throw "GPT-SoVITS Python environment is missing." }
$env:NUMBA_DISABLE_JIT = "1"
$env:HF_HOME = Join-Path $projectRoot "runtime\huggingface"
$env:TRANSFORMERS_CACHE = Join-Path $projectRoot "runtime\huggingface"
$env:MPLCONFIGDIR = Join-Path $projectRoot "runtime\matplotlib"
$env:ASR_MODEL = if ($env:ASR_MODEL) { $env:ASR_MODEL } else { Join-Path $projectRoot "runtime\sensevoice-small" }
$env:ASR_VAD_MODEL = if ($env:ASR_VAD_MODEL) { $env:ASR_VAD_MODEL } else { "" }
$env:ASR_PUNC_MODEL = if ($env:ASR_PUNC_MODEL) { $env:ASR_PUNC_MODEL } else { "" }
$env:ASR_DEVICE = if ($env:ASR_DEVICE) { $env:ASR_DEVICE } else { "cuda:0" }

Set-Location $projectRoot
& $python -m uvicorn src.asr.server:app --host 127.0.0.1 --port 10095
