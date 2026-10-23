param([switch]$Demo, [string]$NodePath = '', [string]$ElectronPath = '', [string]$TestRoot = '')
$ErrorActionPreference = 'Stop'
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
if (-not [IO.Path]::IsPathRooted($NodePath)) { throw 'An absolute Node path is required.' }
if ($ElectronPath) { $env:ISLAND_HUD_ELECTRON = [IO.Path]::GetFullPath($ElectronPath) }
if ($TestRoot) { $env:ISLAND_HUD_TEST_ROOT = [IO.Path]::GetFullPath($TestRoot) }
$appArgs = @((Join-Path $PSScriptRoot 'tools/run-application.cjs'))
if ($Demo) { $appArgs += '--demo' }
& $NodePath @appArgs
exit $LASTEXITCODE
