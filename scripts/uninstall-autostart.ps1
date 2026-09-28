$ErrorActionPreference = "Stop"

$taskNames = @(
  "AI_vtuber Main Server",
  "AI_vtuber Speech Recognition"
)

foreach ($taskName in $taskNames) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed: $taskName"
  }
}
