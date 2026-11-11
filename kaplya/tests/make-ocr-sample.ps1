# Draws a small picture with known text for the text-recognition check.
param([Parameter(Mandatory = $true)][string]$Path)

Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(640, 160)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$font = New-Object System.Drawing.Font('Arial', 44)
$g.DrawString('Kaplya 12345', $font, [System.Drawing.Brushes]::Black, 30, 40)
$g.Dispose()
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $Path"
