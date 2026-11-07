# build-pbo.ps1 — packs addons\arma_mcp into a PBO with HEMTT (local dev, no signing).
#
# Uses the repo-local .tools\hemtt\hemtt.exe (run build\get-hemtt.ps1 once to vendor
# it). `hemtt build` (not release) so no bikeys are needed for local use.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new()
$env:NO_COLOR = '1'

function Write-NativeLine($rec) {
    $text = if ($rec -is [System.Management.Automation.ErrorRecord]) {
        if ($rec.TargetObject) { [string]$rec.TargetObject } else { $rec.Exception.Message }
    } else { [string]$rec }
    ($text -replace "$([char]27)\[[0-9;]*m", '')
}

$root      = Split-Path -Parent $PSScriptRoot
$addonRoot = Join-Path $root 'addon'                # HEMTT root: addon/.hemtt + addon/addons/arma_mcp
$outDir    = Join-Path $root 'build\bin'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$hemtt = $null
$localHemtt = Join-Path $root '.tools\hemtt\hemtt.exe'
if (Test-Path $localHemtt) { $hemtt = $localHemtt }
else { $hemtt = (Get-Command hemtt -ErrorAction SilentlyContinue).Source }
if (-not $hemtt) {
    throw "HEMTT not found. Run build\get-hemtt.ps1 to vendor it, or install from https://hemtt.dev."
}

Write-Host "Packing with HEMTT ($hemtt)..."
Push-Location $addonRoot
try {
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $hemtt build 2>&1 | ForEach-Object { Write-NativeLine $_ }
        $hemttExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEAP }
    if ($hemttExit -ne 0) { throw "hemtt build failed (exit $hemttExit)" }

    # HEMTT outputs under .hemttout\build\addons (possibly nested by prefix). Find
    # the single addon PBO and copy it to the canonical build\bin\arma_mcp.pbo. The
    # PBO's internal $PBOPREFIX$ (ahc\addons\arma_mcp) — not the filename — is what
    # Arma uses to load it, so a canonical filename is safe.
    $builtAddons = Join-Path $addonRoot '.hemttout\build\addons'
    if (-not (Test-Path $builtAddons)) { throw "HEMTT output not found at $builtAddons" }
    $pbo = Get-ChildItem $builtAddons -Recurse -Filter '*.pbo' |
        Where-Object { $_.Name -like '*arma_mcp*' } | Select-Object -First 1
    if (-not $pbo) { throw "No arma_mcp PBO found under $builtAddons" }
    Copy-Item $pbo.FullName (Join-Path $outDir 'arma_mcp.pbo') -Force
} finally { Pop-Location }
Write-Host "PBO in $outDir"
Get-ChildItem (Join-Path $outDir 'arma_mcp.pbo') | ForEach-Object { Write-Host "  - $($_.Name) ($($_.Length) bytes)" }
