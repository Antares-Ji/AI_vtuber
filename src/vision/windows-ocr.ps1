param([Parameter(Mandatory=$true)][string]$ImagePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await-Operation($Operation, [Type]$ResultType) {
  $task = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  if (!$task.Wait(10000)) { throw 'Windows OCR operation timed out' }
  return $task.Result
}
$resolved = (Resolve-Path -LiteralPath $ImagePath).Path
$file = Await-Operation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($resolved)) ([Windows.Storage.StorageFile])
$inputStream = $null
$bitmap = $null
try {
  $inputStream = Await-Operation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await-Operation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($inputStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $limit = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  if ($decoder.PixelWidth -gt $limit -or $decoder.PixelHeight -gt $limit -or [long]$decoder.PixelWidth * $decoder.PixelHeight -gt 12000000) { throw 'Image dimensions exceed OCR limit' }
  $bitmap = Await-Operation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (!$engine) { throw 'No installed Windows OCR language is available' }
  $result = Await-Operation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($result.Lines | ForEach-Object {
    @{ text = $_.Text; words = @($_.Words | ForEach-Object { @{text=$_.Text; x=$_.BoundingRect.X; y=$_.BoundingRect.Y; width=$_.BoundingRect.Width; height=$_.BoundingRect.Height} }) }
  })
  @{ provider='windows-ocr'; language=$engine.RecognizerLanguage.LanguageTag; width=$decoder.PixelWidth; height=$decoder.PixelHeight; text=$result.Text; lines=$lines } | ConvertTo-Json -Depth 7 -Compress
} finally {
  if ($bitmap) { $bitmap.Dispose() }
  if ($inputStream) { $inputStream.Dispose() }
}
