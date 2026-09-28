param(
  [string]$Python = "python",
  [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$environmentPath = Join-Path $projectRoot "runtime\asr-env"
$environmentPython = Join-Path $environmentPath "Scripts\python.exe"

if (!(Test-Path $environmentPython)) {
  & $Python -m venv $environmentPath
}

& $environmentPython -m pip install --upgrade pip
if ($CpuOnly) {
  & $environmentPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
} else {
  & $environmentPython -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
}
& $environmentPython -m pip install funasr fastapi "uvicorn[standard]" imageio-ffmpeg

$ffmpeg = & $environmentPython -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())"
Write-Host "ASR environment ready."
Write-Host "FFmpeg: $ffmpeg"
Write-Host "Run scripts/start-asr.ps1; the model downloads on first startup."
