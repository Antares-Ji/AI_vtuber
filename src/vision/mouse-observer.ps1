param([ValidateSet('list','watch','selftest')][string]$Mode='list', [long]$WindowHandle=0, [int]$ParentProcessId=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'mouse-observer.cs') -ReferencedAssemblies System.Windows.Forms
if ($Mode -eq 'list') { [VisionMouseObserver]::List() } elseif ($Mode -eq 'selftest') { [VisionMouseObserver]::SelfTest() } else { [VisionMouseObserver]::Run($WindowHandle,$ParentProcessId) }
