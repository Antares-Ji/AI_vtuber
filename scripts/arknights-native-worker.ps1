# Persistent controller: compiles native bindings once and executes/captures in one process.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/bot/win-control.ps1') 'library'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeDir = Join-Path $projectRoot 'runtime/vlm/controller'
$nativeToken = (Get-Content -LiteralPath (Join-Path $nativeDir 'token.txt') -Raw).Trim()
if ($nativeToken.Length -lt 16) { throw 'Controller token is missing or too short' }
$capturePath = Join-Path $nativeDir 'native-live.png'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add('http://127.0.0.1:17644/')
$listener.Start()
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
@{ processId=$PID; isAdministrator=$admin; port=17644; readyAt=(Get-Date).ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $nativeDir 'native-status.json') -Encoding UTF8
[Console]::WriteLine('Native controller ready on 127.0.0.1:17644')

function Get-Ratio($value) {
  if ($null -eq $value -or $value -is [bool]) { throw 'Missing or invalid normalized coordinate' }
  $number = [double]$value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0 -or $number -gt 1) { throw 'Coordinate outside 0..1' }
  return $number
}

try {
  $running = $true
  while ($running) {
    $context = $listener.GetContext()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $statusCode = 200
    try {
      if ($context.Request.Headers['Authorization'] -cne ('Bearer ' + $nativeToken)) {
        $statusCode = 403
        throw 'forbidden'
      }
      $route = $context.Request.Url.AbsolutePath
      if ($route -eq '/status' -and $context.Request.HttpMethod -eq 'GET') {
        $payload = @{ ok=$true; info=(Get-ArknightsInfo); isAdministrator=$admin; persistent=$true }
      } elseif ($context.Request.HttpMethod -eq 'POST' -and $route -in @('/capture','/click','/move','/drag','/shutdown','/deploy-local','/economy-local','/stage07-local')) {
        if ($context.Request.ContentLength64 -gt 16384 -or $context.Request.ContentLength64 -lt 0) { throw 'Invalid request length' }
        $reader = New-Object IO.StreamReader($context.Request.InputStream, [Text.Encoding]::UTF8)
        try { $rawBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $body = if ($rawBody) { $rawBody | ConvertFrom-Json } else { [pscustomobject]@{} }
        if ($route -eq '/stage07-local') {
          if ([string]$body.stage -notmatch '^(0|[1-9][0-9]?)-[1-9][0-9]?$') { throw 'Only numbered mainline stages are authorized; TR tutorials excluded' }
          if ($activeRealtime -and -not $activeRealtime.HasExited) { throw 'A local game experiment is already active' }
          if (-not (Set-ArknightsForeground)) { throw 'Game is not foreground' }
          $battleScript = Join-Path $PSScriptRoot 'local-stage07-battle.py'
          $battlePython = Join-Path $projectRoot 'runtime/vlm-env/Scripts/python.exe'
          $stageRoot = Join-Path $projectRoot ('runtime/vision/campaign-20260926/' + $body.stage)
          $planPath = Join-Path $stageRoot 'plan.json'
          if (-not (Test-Path -LiteralPath $planPath)) { throw 'Current stage plan missing' }
          $jobDir = Join-Path $stageRoot ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString())
          New-Item -ItemType Directory -Path $jobDir -Force | Out-Null
          $battleArgs = @('-u',('"' + $battleScript + '"'),'--stage',$body.stage,'--plan',('"'+$planPath+'"'),'--out',('"'+$jobDir+'"'))
          if ($body.resumeSummary) {
            $resumePath = [IO.Path]::GetFullPath([string]$body.resumeSummary)
            $allowedRoot = [IO.Path]::GetFullPath($stageRoot).TrimEnd('\') + '\'
            if (-not $resumePath.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resumePath)) { throw 'Resume summary must belong to the same stage' }
            $battleArgs += @('--resume-summary',('"'+$resumePath+'"'))
          }
          $activeRealtime = Start-Process -FilePath $battlePython -ArgumentList $battleArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $jobDir 'worker.log') -RedirectStandardError (Join-Path $jobDir 'worker-error.log') -PassThru
          $payload = @{ok=$true; processId=$activeRealtime.Id; jobDirectory=$jobDir}
        } elseif ($route -eq '/economy-local') {
          if ($body.stage -ne '0-1') { throw 'Only the reviewed 0-1 economy experiment is available' }
          if ($activeRealtime -and -not $activeRealtime.HasExited) { throw 'A local game experiment is already active' }
          $economyScript = Join-Path $PSScriptRoot 'local-economy-trial.py'
          $economyPython = Join-Path $projectRoot 'runtime/vlm-env/Scripts/python.exe'
          $activeRealtime = Start-Process -FilePath $economyPython -ArgumentList @('-u',('"' + $economyScript + '"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $nativeDir 'economy-trial.log') -RedirectStandardError (Join-Path $nativeDir 'economy-trial-error.log') -PassThru
          $payload = @{ok=$true; processId=$activeRealtime.Id}
        } elseif ($route -eq '/deploy-local') {
          if ($body.stage -ne '0-1') { throw 'Only the validated 0-1 deployment is available' }
          $operators = if ($null -eq $body.operators) { 1 } else { $body.operators }
          $speed = if ($null -eq $body.speed) { 1 } else { $body.speed }
          if ($operators -is [bool] -or $operators -notin @(1,3) -or $speed -is [bool] -or $speed -notin @(1,2)) { throw 'Unsupported operator count or speed' }
          if ($null -ne $body.skill -and $body.skill -isnot [bool]) { throw 'skill must be boolean' }
          if ($null -ne $body.resumeDeployed -and ($body.resumeDeployed -is [bool] -or $body.resumeDeployed -ne 3)) { throw 'Only the reviewed three-operator state can be resumed' }
          if ($activeRealtime -and -not $activeRealtime.HasExited) { throw 'A local deployment is already active' }
          $info = Get-ArknightsInfo
          $jobDir = Join-Path $projectRoot ('runtime/vision/realtime-deployment/' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
          New-Item -ItemType Directory -Path $jobDir -Force | Out-Null
          $realtimeScript = Join-Path $PSScriptRoot 'realtime-deployment.py'
          $realtimePython = Join-Path $projectRoot 'runtime/vlm-env/Scripts/python.exe'
          $jobArguments = @('-u',('"' + $realtimeScript + '"'),'--hwnd',[string]$info.handle,'--out',('"' + $jobDir + '"'),'--seconds','90','--operators',[string]$operators,'--speed',[string]$speed)
          if ($body.skill -eq $true) { $jobArguments += '--skill' }
          if ($body.resumeDeployed -eq 3) { $jobArguments += @('--resume-deployed','3') }
          $activeRealtime = Start-Process -FilePath $realtimePython -ArgumentList $jobArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $jobDir 'worker.log') -RedirectStandardError (Join-Path $jobDir 'worker-error.log') -PassThru
          $payload = @{ok=$true; jobDirectory=$jobDir; processId=$activeRealtime.Id}
        } elseif ($route -eq '/shutdown') {
          $payload = @{ok=$true; shuttingDown=$true}; $running = $false
        } else {
          $timing = [ordered]@{}
          $inputResult = $null
          # Validate the complete request before changing focus or sending input.
          $ratios = @()
          if ($route -in @('/click','/move')) { $ratios = @((Get-Ratio $body.xRatio), (Get-Ratio $body.yRatio)) }
          if ($route -eq '/drag') { $ratios = @((Get-Ratio $body.startXRatio), (Get-Ratio $body.startYRatio), (Get-Ratio $body.endXRatio), (Get-Ratio $body.endYRatio)) }
          $profile = if ($null -eq $body.profile) { 'reliable' } else { [string]$body.profile }
          if ($profile -notin @('reliable','responsive')) { throw 'Unknown timing profile' }
          $settle = if ($null -eq $body.waitMs) { 200 } else { [int]$body.waitMs }
          if ($settle -lt 0 -or $settle -gt 3000) { throw 'waitMs must be 0..3000' }
          if (-not (Set-ArknightsForeground)) { throw 'Game is not foreground' }
          $info = Get-ArknightsInfo
          $timing.prepare_ms = $timer.Elapsed.TotalMilliseconds
          $beforeAction = $timer.Elapsed.TotalMilliseconds
          if ($route -eq '/move') {
            $px = $info.client.x + [int][Math]::Round(($info.client.width - 1) * $ratios[0])
            $py = $info.client.y + [int][Math]::Round(($info.client.height - 1) * $ratios[1])
            if (-not [WinInput]::SetCursorPos($px,$py)) { throw 'Game cursor move failed' }
          } elseif ($route -eq '/click') {
            $px = [int][Math]::Round(($info.client.width - 1) * $ratios[0])
            $py = [int][Math]::Round(($info.client.height - 1) * $ratios[1])
            $inputResult = Invoke-ArknightsAction 'clientclick' $px $py | ConvertFrom-Json
          } elseif ($route -eq '/drag') {
            $sx = [int][Math]::Round(($info.client.width - 1) * $ratios[0])
            $sy = [int][Math]::Round(($info.client.height - 1) * $ratios[1])
            $ex = [int][Math]::Round(($info.client.width - 1) * $ratios[2])
            $ey = [int][Math]::Round(($info.client.height - 1) * $ratios[3])
            $inputResult = Invoke-ArknightsAction 'clientdrag' $sx $sy $ex $ey '' $profile | ConvertFrom-Json
          }
          $timing.input_ms = $timer.Elapsed.TotalMilliseconds - $beforeAction
          if ($route -ne '/capture') { Start-Sleep -Milliseconds $settle }
          $beforeCapture = $timer.Elapsed.TotalMilliseconds
          $timing.settle_ms = $beforeCapture - $beforeAction - $timing.input_ms
          $info = Get-ArknightsInfo
          if (-not $info.appForeground) { throw 'Game lost foreground before capture' }
          Invoke-ArknightsAction 'capture' $info.client.x $info.client.y $info.client.width $info.client.height $capturePath | Out-Null
          $timing.capture_ms = $timer.Elapsed.TotalMilliseconds - $beforeCapture
          $timing.total_ms = $timer.Elapsed.TotalMilliseconds
          $payload = @{ok=$true; info=$info; path=$capturePath; capturedAt=(Get-Date).ToString('o'); timing=$timing; persistent=$true}
          if ($route -eq '/click') { $payload.click = $inputResult }
          if ($route -eq '/drag') { $payload.drag = $inputResult }
        }
      } else { $statusCode = 404; throw 'Unsupported route' }
    } catch {
      if ($statusCode -eq 200) { $statusCode = 400 }
      $payload = @{ok=$false; error=$_.Exception.Message}
    }
    try {
      $bytes = [Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 8 -Compress))
      $context.Response.StatusCode = $statusCode
      $context.Response.ContentType = 'application/json; charset=utf-8'
      $context.Response.ContentLength64 = $bytes.Length
      $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } finally { $context.Response.Close() }
  }
} finally { $listener.Stop(); $listener.Close() }
