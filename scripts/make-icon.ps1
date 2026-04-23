param(
  [string]$Source = ".\assets\lcr-8bit.png",
  [string]$Out = ".\assets\lcr-8bit.ico"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
$outDir = Split-Path -Parent $outPath
if ($outDir) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngImages = New-Object System.Collections.Generic.List[byte[]]
$sourceBitmap = [System.Drawing.Bitmap]::FromFile($sourcePath)

try {
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap $size, $size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawImage($sourceBitmap, 0, 0, $size, $size)

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngImages.Add($stream.ToArray())

    $stream.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
} finally {
  $sourceBitmap.Dispose()
}

$writer = New-Object System.IO.BinaryWriter([System.IO.File]::Open($outPath, [System.IO.FileMode]::Create))
try {
  $writer.Write([UInt16]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]$pngImages.Count)

  $directorySize = 6 + (16 * $pngImages.Count)
  $offset = $directorySize

  for ($i = 0; $i -lt $pngImages.Count; $i++) {
    $size = $sizes[$i]
    $image = $pngImages[$i]
    $iconSizeByte = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$iconSizeByte)
    $writer.Write([byte]$iconSizeByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$image.Length)
    $writer.Write([UInt32]$offset)
    $offset += $image.Length
  }

  foreach ($image in $pngImages) {
    $writer.Write($image)
  }
} finally {
  $writer.Dispose()
}

Write-Host "[lcr] Wrote icon: $outPath"
