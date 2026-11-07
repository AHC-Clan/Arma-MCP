# test-cpp.ps1 — builds and runs the C++ unit tests (no CMake needed), then the
# DLL<->server loopback interop test. Uses MSVC via the same VS auto-detect as
# build-extension.ps1.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Find-VcVars {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $p = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($p) {
            $vc = Join-Path $p 'VC\Auxiliary\Build\vcvars64.bat'
            if (Test-Path $vc) { return $vc }
        }
    }
    foreach ($r in @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community",
        "$env:ProgramFiles\Microsoft Visual Studio\2022\Community",
        "$env:ProgramFiles\Microsoft Visual Studio\18\Community")) {
        $vc = Join-Path $r 'VC\Auxiliary\Build\vcvars64.bat'
        $tools = Join-Path $r 'VC\Tools\MSVC'
        if ((Test-Path $vc) -and (Test-Path $tools) -and (Get-ChildItem $tools -ErrorAction SilentlyContinue)) { return $vc }
    }
    throw "No Visual Studio C++ toolset found."
}

$vcvars = Find-VcVars
$ext = Join-Path $root 'extension'
$out = Join-Path $env:TEMP 'arma_mcp_cpptests'
New-Item -ItemType Directory -Force -Path $out | Out-Null
$core = 'src\Utf8.cpp src\SafeArray.cpp src\Json.cpp src\FrameCodec.cpp src\IpcClient.cpp src\Bridge.cpp src\OpenUrl.cpp src\HostConnect.cpp'

$fail = 0
foreach ($t in @('test_utf8','test_safearray','test_json','test_queue','test_wrapbody','test_openurl','test_pipeoverride','test_connect')) {
    Write-Host "=== $t ===" -ForegroundColor Cyan
    $cmd = "call `"$vcvars`" >nul 2>nul && cl /nologo /utf-8 /W4 /std:c++17 /EHsc /MT tests\$t.cpp $core ws2_32.lib shell32.lib advapi32.lib user32.lib /Fe`"$out\$t.exe`" /Fo`"$out\\`" >`"$out\$t.log`" 2>&1"
    Push-Location $ext
    try { cmd /c $cmd } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED $t"; Get-Content "$out\$t.log" | Select-Object -Last 15; $fail = 1; continue }
    & "$out\$t.exe"
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
}

# Loopback interop (needs the Node peer). Build the driver, then run the JS runner.
Write-Host "=== loopback_driver ===" -ForegroundColor Cyan
$cmd = "call `"$vcvars`" >nul 2>nul && cl /nologo /utf-8 /W4 /std:c++17 /EHsc /MT tests\loopback_driver.cpp $core ws2_32.lib shell32.lib advapi32.lib user32.lib /Fe`"$out\loopback_driver.exe`" /Fo`"$out\\`" >`"$out\loopback.log`" 2>&1"
Push-Location $ext
try { cmd /c $cmd } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED loopback_driver"; Get-Content "$out\loopback.log" | Select-Object -Last 15; $fail = 1 }
else {
    & node (Join-Path $ext 'tests\run_loopback.mjs') "$out\loopback_driver.exe"
    if ($LASTEXITCODE -ne 0) { $fail = 1 }
}

if ($fail -eq 0) { Write-Host "`nC++ tests: ALL PASS" -ForegroundColor Green } else { Write-Host "`nC++ tests: FAILURES" -ForegroundColor Red; exit 1 }
