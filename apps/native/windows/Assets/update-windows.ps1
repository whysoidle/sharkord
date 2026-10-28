param([int]$ProcessId, [string]$Source, [string]$Target, [switch]$NoLaunch)
$ErrorActionPreference = 'Stop'
$running = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if ($running) { $running | Wait-Process -Timeout 30 }
$backup = Join-Path (Split-Path $Source) 'previous'
New-Item -ItemType Directory -Path $backup | Out-Null
$installed = @()
try {
    foreach ($item in Get-ChildItem -LiteralPath $Source) {
        $destination = Join-Path $Target $item.Name
        if (Test-Path -LiteralPath $destination) {
            Move-Item -LiteralPath $destination -Destination (Join-Path $backup $item.Name)
        }
        $installed += $item.Name
        Move-Item -LiteralPath $item.FullName -Destination $destination
    }
} catch {
    foreach ($name in $installed) {
        $destination = Join-Path $Target $name
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    }
    foreach ($item in Get-ChildItem -LiteralPath $backup) { Move-Item -LiteralPath $item.FullName -Destination (Join-Path $Target $item.Name) }
    if (!$NoLaunch) { Start-Process -FilePath (Join-Path $Target 'Sharkord.exe') }
    throw
}
if (!$NoLaunch) { Start-Process -FilePath (Join-Path $Target 'Sharkord.exe') }
