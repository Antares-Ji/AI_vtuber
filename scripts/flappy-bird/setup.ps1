$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$pythonPath = Join-Path $projectRoot 'runtime/flappy-bird/.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) {
    & uv venv --python 3.11 (Join-Path $projectRoot 'runtime/flappy-bird/.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the Flappy Bird environment.' }
}
& uv pip install --python $pythonPath -r (Join-Path $PSScriptRoot 'requirements-lock.txt')
if ($LASTEXITCODE -ne 0) { throw 'Could not install Flappy Bird dependencies.' }
