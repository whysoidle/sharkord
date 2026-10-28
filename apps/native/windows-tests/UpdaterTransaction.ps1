$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('Sharkord update test ' + [Guid]::NewGuid())
$source = Join-Path $root 'new app'
$target = Join-Path $root 'installed app'
New-Item -ItemType Directory -Path $source, $target | Out-Null
Set-Content -LiteralPath (Join-Path $source 'Sharkord.exe') -Value 'new version'
Set-Content -LiteralPath (Join-Path $target 'Sharkord.exe') -Value 'old version'
Set-Content -LiteralPath (Join-Path $target 'unrelated.txt') -Value 'keep'
$helper = Join-Path $PSScriptRoot '../windows/Assets/update-windows.ps1'
& $helper -ProcessId 2147483647 -Source $source -Target $target -NoLaunch
if ((Get-Content -LiteralPath (Join-Path $target 'Sharkord.exe')) -ne 'new version') { throw 'Update did not install' }
if ((Get-Content -LiteralPath (Join-Path $root 'previous/Sharkord.exe')) -ne 'old version') { throw 'Backup missing' }
if (!(Test-Path -LiteralPath (Join-Path $target 'unrelated.txt'))) { throw 'Unrelated file changed' }
Remove-Item -LiteralPath $root -Recurse -Force
Write-Host 'Passed: updater replaces files, preserves backup and unrelated files, and handles spaces in paths.'
