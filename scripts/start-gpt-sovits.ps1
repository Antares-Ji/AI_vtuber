param([switch]$CheckOnly)
$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$launchJson = & node (Join-Path $PSScriptRoot 'voice-launch-config.js')
if ($LASTEXITCODE -ne 0) { throw 'Could not read GPT-SoVITS launcher configuration.' }
$launch = $launchJson | ConvertFrom-Json
$serviceRoot = $launch.root
$python = $launch.python
$config = $launch.config
$port = 0
if (-not [int]::TryParse([string]$launch.port, [ref]$port) -or $port -lt 1024 -or $port -gt 65535) { throw 'Invalid GPT_SOVITS_PORT.' }
foreach ($required in @($python, $config, (Join-Path $serviceRoot 'api_v2.py'))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing $required. Configure a voice with scripts/configure-voice.js first." }
}
$bundledFfmpeg = Join-Path $serviceRoot 'runtime/ffmpeg.exe'
$ffmpeg = if (Test-Path -LiteralPath $bundledFfmpeg) { Get-Item -LiteralPath $bundledFfmpeg } else {
  $command = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
  if ($command) { Get-Item -LiteralPath $command.Source } else {
    Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg.Shared*" -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  }
}
if (!$ffmpeg) { throw 'FFmpeg is missing. Install it or use a bundle containing runtime/ffmpeg.exe.' }
if ($CheckOnly) {
  Write-Host "Launcher files ready; port $port. No service started. Weight compatibility and speech still require a live test."
  exit 0
}
$env:Path = "$(Split-Path -Parent $ffmpeg.FullName);$env:Path"
$env:HF_HOME = Join-Path $projectRoot 'runtime/huggingface'
$env:TRANSFORMERS_CACHE = $env:HF_HOME
$env:MPLCONFIGDIR = Join-Path $projectRoot 'runtime/matplotlib'
Push-Location -LiteralPath $serviceRoot
try {
  & $python api_v2.py -a 127.0.0.1 -p $port -c $config
  $serviceExitCode = $LASTEXITCODE
} finally { Pop-Location }
exit $serviceExitCode
