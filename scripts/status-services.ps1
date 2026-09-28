$ErrorActionPreference = "Stop"

$services = @(
  @{ name = "main"; port = 3000; health = "http://127.0.0.1:3000/api/health" },
  @{ name = "qwen"; port = 11435; health = "http://127.0.0.1:11435/health" },
  @{ name = "asr"; port = 10095; health = "http://127.0.0.1:10095/health" },
  @{ name = "gpt-sovits"; port = 9880; health = $null }
)

$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
$status = foreach ($service in $services) {
  $connection = $listeners | Where-Object LocalPort -eq $service.port | Select-Object -First 1
  $process = if ($connection) { Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue } else { $null }
  $healthReady = $false
  $healthError = $null
  if ($connection -and $service.health) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $service.health -TimeoutSec 2
      $healthReady = $response.StatusCode -eq 200
    } catch {
      $healthError = $_.Exception.Message
    }
  } elseif ($connection) {
    $healthReady = $true
  }
  [pscustomobject]@{
    name = $service.name
    port = $service.port
    ready = [bool]($connection -and $healthReady)
    pid = if ($process) { $process.Id } else { $null }
    process = if ($process) { $process.ProcessName } else { $null }
    startedAt = if ($process) { $process.StartTime.ToString("o") } else { $null }
    health = $service.health
    error = $healthError
  }
}

$status | ConvertTo-Json -Depth 4
