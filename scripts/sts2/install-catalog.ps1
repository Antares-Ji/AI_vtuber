param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$manifest = Get-Content -LiteralPath (Join-Path $root 'runtime/sts2/install.json') -Raw | ConvertFrom-Json
$upstream = Join-Path $root 'integrations/sts2-mcp/upstream'
$build = Join-Path $root 'runtime/sts2/catalog-build'
New-Item -ItemType Directory -Path $build -Force | Out-Null
Get-ChildItem -LiteralPath $upstream -File | Where-Object { $_.Extension -in '.cs','.csproj' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $build }
Copy-Item -LiteralPath (Join-Path $root 'integrations/sts2-learning/McpMod.Catalog.cs') -Destination $build
$main = Join-Path $build 'McpMod.cs'
$source = [IO.File]::ReadAllText($main)
$anchor = 'else if (path == "/api/v1/wiki")'
if (-not $source.Contains($anchor)) { throw 'Pinned upstream router changed; review required.' }
$source = $source.Replace($anchor, 'else if (path == "/api/v1/learning/catalog") { HandleLearningCatalog(request, response); }' + [Environment]::NewLine + '            ' + $anchor)
[IO.File]::WriteAllText($main, $source)
$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $dotnet) { $dotnet = 'C:/Program Files/dotnet/dotnet.exe' }
& $dotnet build (Join-Path $build 'STS2_MCP.csproj') -c Release -o (Join-Path $build 'out') "-p:STS2GameDir=$($manifest.gameDir)"
if ($LASTEXITCODE) { throw 'Catalog build failed' }
if ($Install) {
    if (Get-Process SlayTheSpire2 -ErrorAction SilentlyContinue) { throw 'Close the game before installing. Saves are not modified.' }
    $backup = Join-Path $root ('runtime/sts2/backups/catalog-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    $target = Join-Path $manifest.gameDir 'mods/STS2_MCP.dll'
    Copy-Item -LiteralPath $target -Destination $backup
    Copy-Item -LiteralPath (Join-Path $build 'out/STS2_MCP.dll') -Destination $target
    Write-Output "Installed read-only catalog. Original mod: $backup"
}
