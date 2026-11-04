# Prints ONE line: the PyTorch backend to install for this computer, followed by '|' and a description.
#   cu128    NVIDIA RTX 20xx..50xx (Turing..Blackwell) with driver >= 570  (RTX 50xx requires it)
#   cu126    NVIDIA GTX 900/1000, Titan V, RTX 20xx..40xx with driver >= 560 (or compute capability unknown)
#   cu118    older NVIDIA drivers (>= 520)
#   xpu      Intel Arc / Core Ultra graphics
#   directml AMD Radeon, Intel Iris/UHD and any other DirectX 12 GPU
#   cpu      no usable GPU
$ErrorActionPreference = 'SilentlyContinue'
$names = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }) -join '; '

$smi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
if (-not $smi) {
  foreach ($p in @("$env:SystemRoot\System32\nvidia-smi.exe", "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe")) {
    if (Test-Path $p) { $smi = $p; break }
  }
}
if ($smi) {
  $q = & $smi --query-gpu=name,compute_cap,driver_version --format=csv,noheader 2>$null | Select-Object -First 1
  if ($q -and $q -notmatch 'not a valid|Field') {
    $parts = $q -split ',\s*'
    $name = $parts[0]; $cc = 0.0; $drv = 0.0
    [void][double]::TryParse($parts[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cc)
    [void][double]::TryParse(($parts[2] -split '\.')[0], [ref]$drv)
    if ($cc -ge 12.0) {
      if ($drv -ge 570) { "cu128|$($name) (sm $cc, driver $($parts[2]))" } else { "cpu|$($name) - update NVIDIA driver to 570+ to use this GPU" }
    } elseif ($cc -ge 7.5 -and $drv -ge 570) { "cu128|$($name) (sm $cc, driver $($parts[2]))" }
    elseif ($cc -ge 5.0 -and $drv -ge 560) { "cu126|$($name) (sm $cc, driver $($parts[2]))" }
    elseif ($cc -ge 3.7 -and $drv -ge 520) { "cu118|$($name) (sm $cc, driver $($parts[2]))" }
    elseif ($cc -gt 0) { "directml|$($name) (old NVIDIA GPU/driver - using DirectML)" }
    else { "directml|$($name)" }
    exit 0
  }
  # very old nvidia-smi without compute_cap field: decide by driver version only
  $q = & $smi --query-gpu=name,driver_version --format=csv,noheader 2>$null | Select-Object -First 1
  if ($q) {
    $parts = $q -split ',\s*'; $drv = 0.0
    [void][double]::TryParse(($parts[1] -split '\.')[0], [ref]$drv)
    if ($drv -ge 560) { "cu126|$($parts[0]) (driver $($parts[1]))" }
    elseif ($drv -ge 520) { "cu118|$($parts[0]) (driver $($parts[1]))" }
    else { "directml|$($parts[0]) (old driver $($parts[1]))" }
    exit 0
  }
}
if ($names -match 'Intel.*\bArc\b') { "xpu|$names"; exit 0 }
if ($names -match 'Radeon|AMD|Intel|NVIDIA|GeForce|Quadro') { "directml|$names"; exit 0 }
"cpu|$names"
