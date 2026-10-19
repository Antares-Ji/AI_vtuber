param([switch]$Evaluate)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$runtimePath = Join-Path $projectRoot 'runtime/flappy-bird'
$pythonPath = Join-Path $runtimePath '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $pythonPath)) { & (Join-Path $PSScriptRoot 'setup.ps1') }
if ($Evaluate) {
    & $pythonPath (Join-Path $PSScriptRoot 'run.py') --episodes 100 --target 1000 --seed 30000 --output (Join-Path $runtimePath 'acceptance.json')
    exit $LASTEXITCODE
}
$pidPath = Join-Path $runtimePath 'demo-process.json'
if (Test-Path -LiteralPath $pidPath) {
    $previous = Get-Content -LiteralPath $pidPath -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($previous.pid)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.CommandLine -like '*flappy-bird*run.py*') {
        Write-Output "Flappy Bird AI is already running (PID $($previous.pid)). Close the game window or press Esc to stop."
        exit 0
    }
}
$runPath = Join-Path $PSScriptRoot 'run.py'
$stopPath = Join-Path $runtimePath 'stop-demo'
if (Test-Path -LiteralPath $stopPath) { Remove-Item -LiteralPath $stopPath }
$reportPath = Join-Path $runtimePath 'demo.json'
$arguments = '"{0}" --render --episodes 0 --target 10000 --max-steps 1000000 --seed 50000 --output "{1}"' -f $runPath, $reportPath
# pythonw has no console. Normal is required for the interactive pygame window;
# Hidden would also hide SDL's first window and leave the game invisible.
$guiPythonPath = Join-Path $runtimePath '.venv/Scripts/pythonw.exe'
$gameProcess = Start-Process -FilePath $guiPythonPath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Normal -RedirectStandardOutput (Join-Path $runtimePath 'demo.stdout.log') -RedirectStandardError (Join-Path $runtimePath 'demo.stderr.log') -PassThru
@{ pid = $gameProcess.Id; started_at = (Get-Date).ToString('o'); script = $runPath } | ConvertTo-Json | Set-Content -LiteralPath $pidPath -Encoding utf8
Write-Output "Flappy Bird AI started (PID $($gameProcess.Id)). Close the game window or press Esc to stop."
