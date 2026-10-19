function Write-ProcessLifecycle {
  param([string]$Path, [string]$Event, [string]$RunId, $ExitCode = $null, [string]$ErrorType = '')
  # Deliberately omit native args, environment, exception message and stack.
  $safeErrorType = if ($ErrorType -match '^[A-Za-z0-9_.`]{1,160}$') { $ErrorType } else { $null }
  $entry = [ordered]@{
    at = [DateTime]::UtcNow.ToString('o'); event = $Event
    pid = $PID; runId = $RunId; exitCode = $ExitCode; errorType = $safeErrorType
  }
  try {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    [System.IO.File]::AppendAllText($Path, (($entry | ConvertTo-Json -Compress) + [Environment]::NewLine), [System.Text.UTF8Encoding]::new($false))
  } catch { } # Logging failure must not replace the actual launcher exception.
}
