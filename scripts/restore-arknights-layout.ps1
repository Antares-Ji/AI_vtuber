$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../src/bot/win-control.ps1') 'library'
$before = Get-ArknightsInfo
if (-not $before.handle) { throw 'Game window unavailable' }
$outerWidth = 1600 + $before.window.width - $before.client.width
$outerHeight = 1024 + $before.window.height - $before.client.height
Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::FromHandle([IntPtr]$before.handle).WorkingArea
$left = [Math]::Max($area.Left,[Math]::Min($before.window.x,$area.Right-$outerWidth))
$top = [Math]::Max($area.Top,[Math]::Min($before.window.y,$area.Bottom-$outerHeight))
if (-not [WinInput]::SetWindowPos([IntPtr]$before.handle,[IntPtr]::Zero,$left,$top,$outerWidth,$outerHeight,4)) { throw 'Game resize failed' }
Start-Sleep -Milliseconds 500
$after = Get-ArknightsInfo
@{before=$before;after=$after;requestedClient=@{width=1600;height=1024}} | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $PSScriptRoot '../runtime/vlm/controller/loop-20260926-layout.json')
if ($after.client.width -ne 1600 -or $after.client.height -ne 1024) { throw 'Layout verification failed' }
