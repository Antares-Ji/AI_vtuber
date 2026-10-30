param([switch]$Play)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$nodePath = (Get-Command node -ErrorAction Stop).Source
$logsDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
function Test-StsPort([int]$Port) {
    $socket = New-Object System.Net.Sockets.TcpClient
    try { $socket.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $socket.Dispose() }
}
function Start-StsNode([string]$Script, [string]$LogName, [string[]]$ExtraArgs = @()) {
    Start-Process -FilePath $nodePath -ArgumentList (@((Join-Path $projectRoot $Script)) + $ExtraArgs) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir "$LogName.out.log") -RedirectStandardError (Join-Path $logsDir "$LogName.err.log") | Out-Null
}
# Read non-secret ports through the project's existing environment loader.
$ports = & $nodePath -e "require('./src/config/env').loadEnv();console.log(JSON.stringify({main:Number(process.env.PORT||3000),control:Number(process.env.STS2_CONTROL_PORT||15527),game:Number(process.env.STS2_GAME_PORT||15526)}))"
if ($LASTEXITCODE) { throw 'Could not read project configuration' }
$ports = $ports | ConvertFrom-Json
if (-not (Test-StsPort $ports.control)) { Start-StsNode 'integrations/sts2-mcp/service.cjs' 'sts2-service' }
if (-not (Test-StsPort $ports.main)) { Start-StsNode 'src/server.js' 'server' }
$voice = & $nodePath (Join-Path $PSScriptRoot 'voice-launch-config.js') | ConvertFrom-Json
if (-not (Test-StsPort ([int]$voice.port))) {
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'start-gpt-sovits.ps1')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logsDir 'sts2-tts.out.log') -RedirectStandardError (Join-Path $logsDir 'sts2-tts.err.log') | Out-Null
}
if (-not (Get-Process SlayTheSpire2 -ErrorAction SilentlyContinue)) {
    $steamRoot = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction Stop).SteamPath
    Start-Process -FilePath (Join-Path $steamRoot 'steam.exe') -ArgumentList @('-applaunch','2868840') -WindowStyle Hidden
}
$deadline = (Get-Date).AddSeconds(60)
while (-not ((Test-StsPort $ports.main) -and (Test-StsPort $ports.control) -and (Test-StsPort $ports.game) -and (Test-StsPort ([int]$voice.port)))) {
    if ((Get-Date) -gt $deadline) { throw 'A required service did not start. Check logs and enable the game mod if prompted.' }
    Start-Sleep -Milliseconds 500
}
$base = "http://127.0.0.1:$($ports.main)/api/sts2"
Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.main)/api/games/active" -Method Post -ContentType 'application/json' -Body '{"game":"sts2"}' | Out-Null
Invoke-RestMethod -Uri "$base/obs/setup" -Method Post -ContentType 'application/json' -Body '{}' | Out-Null
Invoke-RestMethod -Uri "$base/streamer" -Method Post -ContentType 'application/json' -Body '{"enabled":true}' | Out-Null
$tactics = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match '(?:[\\/]|\s)scripts[\\/]sts2[\\/]summarize\.cjs.*--watch' }
if (-not $tactics) { Start-StsNode 'scripts/sts2/summarize.cjs' 'sts2-tactics' @('--watch') }
if ($Play) { Invoke-RestMethod -Uri "$base/start" -Method Post -ContentType 'application/json' -Body '{"steps":100}' | Out-Null }
Write-Output "Streamer ready: http://127.0.0.1:$($ports.main)/games.html?game=sts2"
Write-Output 'OBS scene: AI VTuber - Slay the Spire 2 (recording and streaming remain under your control)'
