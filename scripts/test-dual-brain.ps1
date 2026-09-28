$ErrorActionPreference = "Stop"
$baseUrl = $env:AI_VTUBER_BASE_URL
if (-not $baseUrl) { $baseUrl = "http://127.0.0.1:3000" }

function Invoke-JsonPost([string]$Path, [hashtable]$Data) {
  $json = $Data | ConvertTo-Json -Depth 8
  Invoke-RestMethod ($baseUrl + $Path) -Method Post -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 40
}

$result = Invoke-JsonPost "/api/diagnostics/dual-brain" @{}
if (-not $result.ok) { throw "Dual-brain diagnostics failed" }
[pscustomobject]@{ Case = "local"; Passed = $result.local.ok; LatencyMs = $result.local.latencyMs; Route = $result.local.route; Model = $result.local.model }
[pscustomobject]@{ Case = "cloud-ack"; Passed = $result.cloudAcknowledgement.ok; LatencyMs = $result.cloudAcknowledgement.latencyMs; Route = $result.cloudAcknowledgement.route; Model = "router" }
[pscustomobject]@{ Case = "cloud"; Passed = $result.cloud.ok; LatencyMs = $result.cloud.latencyMs; Route = "cloud"; Model = $result.cloud.model }
