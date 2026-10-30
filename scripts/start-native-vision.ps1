$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskWorkers = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.CommandLine -match 'scripts[/\\]sts2[/\\]native_vision\.py' }
foreach ($taskWorker in $taskWorkers) { Stop-Process -Id $taskWorker.ProcessId -Force -ErrorAction SilentlyContinue }
$taskProcess = Start-Process -FilePath (Join-Path $taskRoot 'runtime/vlm-env/Scripts/python.exe') -ArgumentList 'scripts/sts2/native_vision.py --four-bit' -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskRoot 'logs/native-vision-nf4.out.log') -RedirectStandardError (Join-Path $taskRoot 'logs/native-vision-nf4.err.log') -PassThru
Write-Output "Native Qwen worker launched: PID $($taskProcess.Id)"
