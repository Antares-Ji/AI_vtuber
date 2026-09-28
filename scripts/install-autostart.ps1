$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$asrScript = Join-Path $PSScriptRoot "start-asr.ps1"
$serverScript = Join-Path $projectRoot "src\server.js"
$node = (Get-Command node -ErrorAction Stop).Source
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal `
  -UserId $currentUser `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

$mainAction = New-ScheduledTaskAction `
  -Execute $node `
  -Argument ('"' + $serverScript + '"') `
  -WorkingDirectory $projectRoot
$asrAction = New-ScheduledTaskAction `
  -Execute $powershell `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $asrScript + '"') `
  -WorkingDirectory $projectRoot

Register-ScheduledTask `
  -TaskName "AI_vtuber Main Server" `
  -Description "Keep the local AI VTuber website available on port 3000." `
  -Action $mainAction `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Register-ScheduledTask `
  -TaskName "AI_vtuber Speech Recognition" `
  -Description "Keep the local SenseVoice ASR service available on port 10095." `
  -Action $asrAction `
  -Trigger $trigger `
  -Principal $principal `
  -Settings $settings `
  -Force | Out-Null

Start-ScheduledTask -TaskName "AI_vtuber Main Server"
Start-ScheduledTask -TaskName "AI_vtuber Speech Recognition"

Write-Host "Installed and started Windows logon tasks:"
Write-Host "  AI_vtuber Main Server"
Write-Host "  AI_vtuber Speech Recognition"
