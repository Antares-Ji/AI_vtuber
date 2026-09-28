$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runDir = Join-Path $projectRoot 'runtime/vlm/controller'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
[ordered]@{startedAt=(Get-Date).ToString('o');processId=$PID;isAdministrator=$admin;stage='starting'} |
 ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDir 'status.json') -Encoding UTF8
if (-not $admin) { throw 'Controller did not receive administrator rights' }
$env:ARKNIGHTS_CONTROL_TOKEN_FILE = Join-Path $runDir 'token.txt'
Set-Location -LiteralPath $projectRoot
& 'D:\nodejs\node.exe' (Join-Path $PSScriptRoot 'arknights-control-server.js') 17643 *> (Join-Path $runDir 'server.log')
