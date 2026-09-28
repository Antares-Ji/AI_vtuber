$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$officialBundle = "D:\GPT-SoVITS-v2pro-20250604-nvidia50"
$localClone = Join-Path $projectRoot "third_party\GPT-SoVITS"

# Prefer the official Windows bundle when it is present. The clone remains a fallback.
if (Test-Path (Join-Path $officialBundle "runtime\python.exe")) {
  $serviceRoot = $officialBundle
  $python = Join-Path $serviceRoot "runtime\python.exe"
} else {
  $serviceRoot = $localClone
  $python = Join-Path $serviceRoot ".venv\Scripts\python.exe"
}
$sourceConfig = Join-Path $serviceRoot "GPT_SoVITS\configs\tts_infer.yaml"
$configDir = Join-Path $projectRoot "runtime\gpt-sovits"
$config = Join-Path $configDir "tts_infer.yaml"
$bundledFfmpeg = Join-Path $serviceRoot "runtime\ffmpeg.exe"
$ffmpeg = if (Test-Path $bundledFfmpeg) {
  Get-Item $bundledFfmpeg
} else {
  Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
}
$gptModel = Get-ChildItem -LiteralPath (Join-Path $serviceRoot "GPT_weights_v4") -Filter "*-e10.ckpt" -ErrorAction SilentlyContinue | Select-Object -First 1
$requiredModels = @(
  $gptModel.FullName,
  (Join-Path $serviceRoot "SoVITS_weights_v4\seele_5s_test_e10_s1000_l32.pth")
)

if (!(Test-Path $python)) { throw "GPT-SoVITS Python environment is missing." }
if (!$ffmpeg) { throw "FFmpeg is missing." }
if (!$gptModel -or ($requiredModels | Where-Object { !$_ -or !(Test-Path -LiteralPath $_) })) {
  throw "GPT-SoVITS base weights are missing. See docs/gpt-sovits-setup.md."
}
if (!(Test-Path $config)) {
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  Copy-Item -LiteralPath $sourceConfig -Destination $config
}

$env:Path = "$(Split-Path -Parent $ffmpeg.FullName);$env:Path"
$env:HF_HOME = Join-Path $projectRoot "runtime\huggingface"
$env:TRANSFORMERS_CACHE = Join-Path $projectRoot "runtime\huggingface"
$env:MPLCONFIGDIR = Join-Path $projectRoot "runtime\matplotlib"
Set-Location $serviceRoot
& $python api_v2.py -a 127.0.0.1 -p 9880 -c $config
