param([Parameter(Mandatory=$true)][string]$OutDir, [string]$NodePath = '', [string]$ElectronDist = '')
$ErrorActionPreference = 'Stop'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not [IO.Path]::IsPathRooted($NodePath)) { throw 'An absolute Node path is required.' }
if ($ElectronDist) { $env:ISLAND_HUD_ELECTRON_DIST = [IO.Path]::GetFullPath($ElectronDist) }
& $NodePath (Join-Path $PSScriptRoot 'tools/package-dsh.cjs') ([IO.Path]::GetFullPath($OutDir))
exit $LASTEXITCODE
