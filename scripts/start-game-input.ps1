param([ValidateSet('YuanShen.exe','GenshinImpact.exe','SlayTheSpire2.exe','javaw.exe')][string]$Game = 'YuanShen.exe')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$run = Join-Path $project 'runtime/game-input'
New-Item -ItemType Directory -Path $run -Force | Out-Null
$python = Join-Path $project 'runtime/vlm-env/Scripts/python.exe'
$service = Join-Path $PSScriptRoot 'game-input-service.py'
& $python $service --exe $Game *> (Join-Path $run 'service.log')
