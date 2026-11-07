# package-release.ps1 - assembles dist\release\@AHC_ArmaMCP from build\bin.
#
# Layout Arma requires (DLLs at the mod ROOT - callExtension searches mod roots):
#   @AHC_ArmaMCP\arma_mcp_x64.dll   (64-bit, for arma3_x64.exe and arma3server_x64.exe)
#   @AHC_ArmaMCP\arma_mcp.dll       (32-bit, Steam Workshop publish requires the pair)
#   @AHC_ArmaMCP\addons\arma_mcp.pbo
#
# dist\ is inside the repo and gitignored, so this is not an external deployment.
#
# It also writes dist\release\arma-mcp-mod-<version>.zip, the mod for a GitHub release,
# with a single @arma_mcp folder inside.
#
# Run after build-extension.ps1 and build-pbo.ps1 (build-all.ps1 does all three).

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root   = Split-Path -Parent $PSScriptRoot
$binDir = Join-Path $root 'build\bin'
$rel    = Join-Path $root 'dist\release\@AHC_ArmaMCP'

$dll   = Join-Path $binDir 'arma_mcp_x64.dll'
$dll32 = Join-Path $binDir 'arma_mcp.dll'
$pbo   = Join-Path $binDir 'arma_mcp.pbo'

foreach ($req in @($dll, $dll32, $pbo)) {
    if (-not (Test-Path $req)) {
        throw "Build artifact missing: $req (run build-extension.ps1 and build-pbo.ps1, or build-all.ps1)"
    }
}

# Freshness sentinel: the DLL must contain the "sessionInfo" frame-type string,
# which only the MCP DLL produces (passed as a const char* to WrapBody, so it lives
# contiguously in .rdata). A stale or wrong DLL is caught here before it ships.
$dllText = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($dll))
if (-not $dllText.Contains('sessionInfo')) {
    throw "'sessionInfo' string not found in $dll - stale or wrong build. Rebuild with build-extension.ps1."
}

# Only this release folder is cleared, never anything outside dist\release.
if (Test-Path $rel) { Remove-Item -Recurse -Force $rel }
New-Item -ItemType Directory -Force -Path (Join-Path $rel 'addons') | Out-Null

Copy-Item $dll   (Join-Path $rel 'arma_mcp_x64.dll')
Copy-Item $dll32 (Join-Path $rel 'arma_mcp.dll')
Copy-Item $pbo   (Join-Path $rel 'addons\arma_mcp.pbo')

# Each file is staged and zipped from a temp folder so the zip's top folder has the
# public name, whatever the local folder is called.
$version = (Get-Content (Join-Path $root '.claude-plugin\marketplace.json') -Raw | ConvertFrom-Json).plugins[0].version
$zip = Join-Path $root "dist\release\arma-mcp-mod-$version.zip"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ("arma-mcp-zip-" + [System.Guid]::NewGuid().ToString('N'))
try {
    $staged = Join-Path $stage '@arma_mcp'
    New-Item -ItemType Directory -Force -Path $staged | Out-Null
    Copy-Item -Recurse -Path (Join-Path $rel '*') -Destination $staged
    if (Test-Path $zip) { Remove-Item -Force $zip }
    Compress-Archive -Path $staged -DestinationPath $zip
} finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
Write-Host "Packaged $zip"

Write-Host "Packaged $rel"
Get-ChildItem -Recurse -File $rel | ForEach-Object {
    Write-Host ("  {0} ({1} bytes)" -f $_.FullName.Substring($rel.Length + 1), $_.Length)
}
