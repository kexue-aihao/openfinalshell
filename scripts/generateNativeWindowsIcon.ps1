param(
  [string]$InputPath = (Join-Path $PSScriptRoot '..\build\icon.png'),
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\windows\OpenFinalShell.App\Assets\OpenFinalShell.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sourcePath = (Resolve-Path -LiteralPath $InputPath).Path
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
$source = [System.Drawing.Bitmap]::new($sourcePath)
try {
  $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
  $images = [System.Collections.Generic.List[byte[]]]::new()

  foreach ($size in $sizes) {
    $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $size, $size))
      } finally {
        $graphics.Dispose()
      }

      $xor = [IO.MemoryStream]::new()
      $writer = [IO.BinaryWriter]::new($xor)
      try {
        # ICO DIB XOR pixels are bottom-up BGRA rows.
        for ($y = $size - 1; $y -ge 0; $y--) {
          for ($x = 0; $x -lt $size; $x++) {
            $pixel = $bitmap.GetPixel($x, $y)
            $writer.Write($pixel.B)
            $writer.Write($pixel.G)
            $writer.Write($pixel.R)
            $writer.Write($pixel.A)
          }
        }
      } finally {
        $writer.Dispose()
      }

      $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
      $mask = [byte[]]::new($maskStride * $size)
      for ($y = $size - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $size; $x++) {
          if ($bitmap.GetPixel($x, $y).A -eq 0) {
            $rowOffset = ($size - 1 - $y) * $maskStride
            $mask[$rowOffset + [int][Math]::Floor($x / 8.0)] = $mask[$rowOffset + [int][Math]::Floor($x / 8.0)] -bor (0x80 -shr ($x % 8))
          }
        }
      }

      $dib = [IO.MemoryStream]::new()
      $dibWriter = [IO.BinaryWriter]::new($dib)
      try {
        $dibWriter.Write([uint32]40)                 # BITMAPINFOHEADER size
        $dibWriter.Write([int32]$size)              # width
        $dibWriter.Write([int32]($size * 2))        # height includes XOR and AND masks
        $dibWriter.Write([uint16]1)                 # planes
        $dibWriter.Write([uint16]32)                # BGRA
        $dibWriter.Write([uint32]0)                 # BI_RGB
        $dibWriter.Write([uint32]($xor.Length + $mask.Length))
        $dibWriter.Write([int32]0)
        $dibWriter.Write([int32]0)
        $dibWriter.Write([uint32]0)
        $dibWriter.Write([uint32]0)
        $dibWriter.Write($xor.ToArray())
        $dibWriter.Write($mask)
      } finally {
        $dibWriter.Dispose()
      }
      $images.Add($dib.ToArray())
    } finally {
      $bitmap.Dispose()
    }
  }

  $directorySize = 6 + (16 * $sizes.Count)
  $output = [IO.MemoryStream]::new()
  $iconWriter = [IO.BinaryWriter]::new($output)
  try {
    $iconWriter.Write([uint16]0)
    $iconWriter.Write([uint16]1)
    $iconWriter.Write([uint16]$sizes.Count)
    $offset = $directorySize
    for ($index = 0; $index -lt $sizes.Count; $index++) {
      $size = $sizes[$index]
      $iconWriter.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $iconWriter.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
      $iconWriter.Write([byte]0)
      $iconWriter.Write([byte]0)
      $iconWriter.Write([uint16]1)
      $iconWriter.Write([uint16]32)
      $iconWriter.Write([uint32]$images[$index].Length)
      $iconWriter.Write([uint32]$offset)
      $offset += $images[$index].Length
    }
    foreach ($image in $images) { $iconWriter.Write($image) }
  } finally {
    $iconWriter.Dispose()
  }

  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($outputFullPath)) | Out-Null
  [IO.File]::WriteAllBytes($outputFullPath, $output.ToArray())
  $outputBytes = (Get-Item -LiteralPath $outputFullPath).Length
  Write-Output "Wrote $outputFullPath ($($sizes -join ', ') px, $([Math]::Round($outputBytes / 1024.0, 1)) KiB)"
} finally {
  $source.Dispose()
}
