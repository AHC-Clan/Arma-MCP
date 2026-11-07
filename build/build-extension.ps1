# build-extension.ps1 — builds the Arma 3 extension DLLs with MSVC.
# Produces BOTH:
#   arma_mcp_x64.dll  (64-bit, for arma3_x64.exe / arma3server_x64.exe)
#   arma_mcp.dll      (32-bit, for arma3.exe / arma3server.exe)
# Steam Workshop(창작마당) publish 는 두 비트니스가 모두 있어야 허용된다.
# x86.x64 C++ 툴셋은 64/32비트 컴파일러를 모두 포함하므로 한 설치로 둘 다 빌드된다.
# VS 2019/2022/2026 C++ 툴셋을 자동 탐지한다.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Find-VcVars([string]$vcvarsName) {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $p = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
        if ($p) {
            $vc = Join-Path $p "VC\Auxiliary\Build\$vcvarsName"
            if (Test-Path $vc) { return $vc }
        }
    }
    $roots = @(
        "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community",
        "$env:ProgramFiles\Microsoft Visual Studio\2022\Community",
        "$env:ProgramFiles\Microsoft Visual Studio\18\Community"
    )
    foreach ($r in $roots) {
        $vc = Join-Path $r "VC\Auxiliary\Build\$vcvarsName"
        $tools = Join-Path $r 'VC\Tools\MSVC'
        if ((Test-Path $vc) -and (Test-Path $tools) -and (Get-ChildItem $tools -ErrorAction SilentlyContinue)) {
            return $vc
        }
    }
    throw "No Visual Studio C++ toolset ($vcvarsName + VC\Tools\MSVC) found. Install 'Desktop development with C++'."
}

$src = Join-Path $root 'extension\src'
$out = Join-Path $root 'build\bin'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$sources = @(
    "$src\Utf8.cpp","$src\SafeArray.cpp","$src\Json.cpp",
    "$src\FrameCodec.cpp","$src\IpcClient.cpp","$src\Bridge.cpp","$src\OpenUrl.cpp","$src\HostConnect.cpp","$src\dllmain.cpp"
) -join ' '

function Build-Dll([string]$vcvarsName, [string]$dllName, [string]$objSubdir) {
    $vcvars = Find-VcVars $vcvarsName
    Write-Host "Using: $vcvars  ->  $dllName"
    $objDir = Join-Path $out $objSubdir
    New-Item -ItemType Directory -Force -Path $objDir | Out-Null
    $cmd = "call `"$vcvars`" >nul 2>nul && cl /nologo /std:c++17 /EHsc /utf-8 /MT /W4 /O2 /LD $sources /Fo`"$objDir\\`" /Fe`"$out\$dllName`" /link ws2_32.lib shell32.lib advapi32.lib user32.lib"
    cmd /c $cmd
    if ($LASTEXITCODE -ne 0) { throw "Build failed for $dllName (exit $LASTEXITCODE)" }
    Write-Host "Built: $out\$dllName"
}

Build-Dll 'vcvars64.bat' 'arma_mcp_x64.dll' 'obj-x64'
Build-Dll 'vcvars32.bat' 'arma_mcp.dll'     'obj-x86'

Write-Host ""
Write-Host "Done. DLLs in $out :"
Write-Host "  arma_mcp_x64.dll  (64-bit)"
Write-Host "  arma_mcp.dll      (32-bit - for Steam Workshop publish)"
