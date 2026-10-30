param([string]$GameDir = $env:STS2_GAME_DIR)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$integrationDir = Join-Path $projectRoot 'integrations/sts2-mcp'
$upstreamDir = Join-Path $integrationDir 'upstream'
if (-not $GameDir) {
    $steamRoot = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
    if ($steamRoot) {
        $libraryFile = Join-Path $steamRoot 'steamapps/libraryfolders.vdf'
        $libraries = @($steamRoot)
        if (Test-Path -LiteralPath $libraryFile) {
            $libraries += [regex]::Matches((Get-Content -LiteralPath $libraryFile -Raw), '"path"\s+"([^"]+)"') | ForEach-Object { $_.Groups[1].Value.Replace('\\', '\') }
        }
        $GameDir = $libraries | Select-Object -Unique | ForEach-Object { Join-Path $_ 'steamapps/common/Slay the Spire 2' } | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'data_sts2_windows_x86_64/sts2.dll') } | Select-Object -First 1
    }
}
if (-not $GameDir -or -not (Test-Path -LiteralPath (Join-Path $GameDir 'data_sts2_windows_x86_64/sts2.dll'))) { throw 'Set STS2_GAME_DIR to your Slay the Spire 2 installation directory.' }
$GameDir = (Resolve-Path -LiteralPath $GameDir).Path
if (-not (Test-Path -LiteralPath $upstreamDir)) {
    git clone https://github.com/Gennadiyev/STS2MCP.git $upstreamDir
    if ($LASTEXITCODE) { throw 'STS2MCP download failed' }
    $upstreamLock = Get-Content -LiteralPath (Join-Path $integrationDir 'upstream.lock.json') -Raw | ConvertFrom-Json
    git -C $upstreamDir checkout --detach $upstreamLock.commit
    if ($LASTEXITCODE) { throw 'Pinned STS2MCP revision is unavailable' }
}
Push-Location $integrationDir
try { npm ci --ignore-scripts --no-audit --no-fund; if ($LASTEXITCODE) { throw 'Node dependencies failed' } } finally { Pop-Location }
Push-Location (Join-Path $upstreamDir 'mcp')
try { uv sync --locked; if ($LASTEXITCODE) { throw 'MCP Python dependencies failed' } } finally { Pop-Location }
dotnet build (Join-Path $upstreamDir 'STS2_MCP.csproj') -c Release -o (Join-Path $upstreamDir 'out/STS2_MCP') "-p:STS2GameDir=$GameDir"
if ($LASTEXITCODE) { throw 'Mod build failed; game version may require adaptation' }
$backupDir = Join-Path $projectRoot ('runtime/sts2/backups/' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$saveRoot = Join-Path $env:APPDATA 'SlayTheSpire2'
if (Test-Path -LiteralPath (Join-Path $saveRoot 'steam')) { Copy-Item -LiteralPath (Join-Path $saveRoot 'steam') -Destination (Join-Path $backupDir 'steam') -Recurse }
$modsDir = Join-Path $GameDir 'mods'
New-Item -ItemType Directory -Path $modsDir -Force | Out-Null
foreach ($name in @('STS2_MCP.dll', 'STS2_MCP.json')) {
    $target = Join-Path $modsDir $name
    if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $backupDir $name) }
}
Copy-Item -LiteralPath (Join-Path $upstreamDir 'out/STS2_MCP/STS2_MCP.dll') -Destination (Join-Path $modsDir 'STS2_MCP.dll')
Copy-Item -LiteralPath (Join-Path $upstreamDir 'mod_manifest.json') -Destination (Join-Path $modsDir 'STS2_MCP.json')
$commit = git -C $upstreamDir rev-parse HEAD
$release = Get-Content -LiteralPath (Join-Path $GameDir 'release_info.json') -Raw | ConvertFrom-Json
@{ gameDir = $GameDir; gameVersion = $release.version; upstreamCommit = $commit; backupDir = $backupDir; installedAt = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot 'runtime/sts2/install.json') -Encoding utf8
Write-Output "STS2MCP installed: $modsDir"
Write-Output "Game version: $($release.version)"
Write-Output "Existing saves backed up: $backupDir"
Write-Output 'Launch the game with mods enabled, then run npm run sts2:doctor -- --probe'
