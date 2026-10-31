param([string]$ModelDir = $env:AI_VTUBER_VISION_MODEL_DIR, [switch]$OcrCheck)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskPython = Join-Path $taskRoot 'runtime/vlm-env/Scripts/python.exe'
$taskArgs = @((Join-Path $PSScriptRoot 'restart-native-vision.py'))
if ($ModelDir) { $taskArgs += @('--model-dir', $ModelDir) }
if ($OcrCheck) { $taskArgs += '--ocr-check' }
& $taskPython @taskArgs
if ($LASTEXITCODE -ne 0) { throw 'Native vision launch failed; inspect the reported checkpoint or process error.' }
