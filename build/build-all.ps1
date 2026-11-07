# build-all.ps1 - extension DLL -> PBO -> dist package, in sequence.
#
# The result, dist\release\@AHC_ArmaMCP, is a mod folder inside the repo and is
# gitignored. Nothing here writes outside the repo.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot

Write-Host "=== [1/3] build extension DLL ===" -ForegroundColor Cyan
& (Join-Path $here 'build-extension.ps1')

Write-Host "`n=== [2/3] build PBO ===" -ForegroundColor Cyan
& (Join-Path $here 'build-pbo.ps1')

Write-Host "`n=== [3/3] package dist ===" -ForegroundColor Cyan
& (Join-Path $here 'package-release.ps1')

Write-Host "`nAll done." -ForegroundColor Green
