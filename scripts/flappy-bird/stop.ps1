$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$stopPath = Join-Path $projectRoot 'runtime/flappy-bird/stop-demo'
New-Item -ItemType File -Path $stopPath -Force | Out-Null
Write-Output 'Stop requested. The AI window will close within one second.'
