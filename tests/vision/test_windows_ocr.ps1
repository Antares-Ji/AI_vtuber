param([switch]$Http)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$fixture = Join-Path ([System.IO.Path]::GetTempPath()) ('vtuber-ocr-' + [guid]::NewGuid().ToString() + '.png')
$bitmap = New-Object System.Drawing.Bitmap(800,200)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$font = New-Object System.Drawing.Font('Arial',36)
$chineseFont = New-Object System.Drawing.Font('Microsoft YaHei',28)
$chineseText = -join @([char]0x7EC8,[char]0x7AEF,[char]0x20,[char]0x5E72,[char]0x5458,[char]0x20,[char]0x57FA,[char]0x5EFA)
try {
  $graphics.Clear([System.Drawing.Color]::White)
  $graphics.DrawString('ARKNIGHTS 123', $font, [System.Drawing.Brushes]::Black, 20, 50)
  $graphics.DrawString($chineseText, $chineseFont, [System.Drawing.Brushes]::Black, 20, 120)
  $bitmap.Save($fixture, [System.Drawing.Imaging.ImageFormat]::Png)
  $raw = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\..\src\vision\windows-ocr.ps1') -ImagePath $fixture
  if ($LASTEXITCODE -ne 0) { throw 'OCR process failed' }
  $result = $raw | ConvertFrom-Json
  if ($result.text -notmatch '123' -or $result.width -ne 800 -or !$result.lines.Count) { throw "OCR fixture failed: $raw" }
  if (($result.text -replace '\s','') -notlike ('*' + (-join @([char]0x7EC8,[char]0x7AEF)) + '*')) { throw 'Chinese OCR fixture failed' }
  Write-Output ('Windows OCR fixture passed: ' + $result.text)
  if ($Http) {
    $httpResult = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/api/vision/arknights' -Method Post -ContentType 'image/png' -InFile $fixture -TimeoutSec 30
    if ($httpResult.text -notmatch '123' -or $httpResult.scene -ne 'home' -or $httpResult.verified -ne $false) { throw 'HTTP OCR fixture failed' }
    Write-Output ('HTTP OCR fixture passed: ' + $httpResult.text + ' / ' + $httpResult.latencyMs + 'ms')
  }
} finally {
  $font.Dispose(); $chineseFont.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture }
}
