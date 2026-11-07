cmake_minimum_required(VERSION 3.15)
project(arma_mcp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---- shared core sources (no exports) -------------------------------------
set(CORE_SOURCES
    src/Utf8.cpp
    src/SafeArray.cpp
    src/Json.cpp
    src/FrameCodec.cpp
    src/IpcClient.cpp
    src/Bridge.cpp
    src/OpenUrl.cpp
    src/HostConnect.cpp
)

# ---- the extension DLL ----------------------------------------------------
add_library(arma_mcp SHARED ${CORE_SOURCES} src/dllmain.cpp)

# Arma loads "<name>_x64.dll" (64-bit exe) and "<name>.dll" (32-bit exe). Name the
# output per the configured architecture so `cmake -A Win32` yields arma_mcp.dll.
# NOTE: the canonical dual-bitness build is build/build-extension.ps1 (cl.exe direct);
# CMake here is primarily for the unit tests below and single-arch DLL builds.
if(CMAKE_SIZEOF_VOID_P EQUAL 8)
    set(MCP_DLL_NAME "arma_mcp_x64")
else()
    set(MCP_DLL_NAME "arma_mcp")
endif()
set_target_properties(arma_mcp PROPERTIES OUTPUT_NAME "${MCP_DLL_NAME}" PREFIX "")

if(MSVC)
    # /utf-8: source + execution charset UTF-8 so string literals are UTF-8 bytes.
    target_compile_options(arma_mcp PRIVATE /utf-8 /W4 /permissive-)
    # Static CRT (/MT) so bare servers need no VC++ redistributable.
    set_property(TARGET arma_mcp PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()
if(WIN32)
    # shell32: ShellExecuteW (OpenUrl.cpp). advapi32 and user32: HostConnect.cpp.
    target_link_libraries(arma_mcp PRIVATE shell32 advapi32 user32)
endif()

# ---- unit tests (console exes; build on any platform) ---------------------
enable_testing()

foreach(t test_utf8 test_safearray test_json test_queue test_wrapbody test_openurl test_pipeoverride test_connect)
    add_executable(${t} tests/${t}.cpp ${CORE_SOURCES})
    if(MSVC)
        target_compile_options(${t} PRIVATE /utf-8)
        set_property(TARGET ${t} PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
    endif()
    find_package(Threads REQUIRED)
    target_link_libraries(${t} PRIVATE Threads::Threads)
    if(WIN32)
        target_link_libraries(${t} PRIVATE shell32 advapi32 user32)
    endif()
    add_test(NAME ${t} COMMAND ${t})
endforeach()

# loopback_driver is NOT a CTest test — it needs the Node peer running (a real
# named pipe). Built here for the manual interop test; see docs/testing.md:
#   node extension/tests/run_loopback.mjs <build>/loopback_driver.exe
add_executable(loopback_driver tests/loopback_driver.cpp ${CORE_SOURCES})
if(MSVC)
    target_compile_options(loopback_driver PRIVATE /utf-8)
    set_property(TARGET loopback_driver PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()
if(WIN32)
    target_link_libraries(loopback_driver PRIVATE ws2_32 shell32 advapi32 user32)
endif()
find_package(Threads REQUIRED)
target_link_libraries(loopback_driver PRIVATE Threads::Threads)
