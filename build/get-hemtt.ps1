# get-hemtt.ps1 — vendors hemtt.exe into .tools\hemtt.
#
# The .tools directory is gitignored (binary), so run this once after cloning.
# Copies the hemtt found on PATH.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root '.tools\hemtt\hemtt.exe'
New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null

$candidates = @(
    @(
        (Get-Command hemtt -ErrorAction SilentlyContinue).Source
    ) | Where-Object { $_ -and (Test-Path $_) }
)

if ($candidates.Count -eq 0) {
    throw "No hemtt.exe found. Download from https://hemtt.dev and place it at $dest."
}
$srcHemtt = $candidates[0]
Copy-Item $srcHemtt $dest -Force
Write-Host "Vendored HEMTT: $srcHemtt -> $dest"
& $dest --version
