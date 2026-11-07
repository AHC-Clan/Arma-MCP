// loopback_driver.cpp — drives the real Bridge (DLL client) against a Node peer
// acting as the MCP server, over a real named pipe. Proves the C++ IpcClient +
// FrameCodec + WrapBody interoperate with the TS gateway on the wire.
//
// Usage: loopback_driver <pipeName>
//   1. Configure + Start the Bridge (connects to the peer as a client).
//   2. Push a sessionInfo + execResult (envelope stamped by WrapBody).
//   3. Drain inbound until the peer's "exec" frame is dispatched to our callback.
//   4. Print PASS/FAIL by whether the exec payload matched.
#include "../src/Bridge.hpp"
#include "../src/SafeArray.hpp"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

using namespace ahc;

static std::string g_execPayload;
static bool g_gotExec = false;

static int DriverCallback(const char* name, const char* function, const char* data) {
    if (std::strcmp(name, "AHC_ArmaMCP") == 0 && std::strcmp(function, "exec") == 0) {
        g_execPayload = data ? data : "";
        g_gotExec = true;
    }
    return 90;
}

int main(int argc, char** argv) {
    const std::string pipe = argc > 1 ? argv[1] : R"(\\.\pipe\arma_mcp_loopback)";

    Bridge b;
    b.SetCallback(&DriverCallback);
    b.Configure(pipe, false, "", 0);
    b.Start();

    // Wait for the worker to connect (backoff up to ~1s per attempt).
    for (int i = 0; i < 100 && !b.GetStatus().connected; ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    if (!b.GetStatus().connected) {
        std::printf("loopback: FAIL (never connected to peer)\n");
        b.Stop();
        return 1;
    }

    // Push a sessionInfo + an execResult. The peer verifies the envelope.
    b.EnqueueOutbound(OutboundMsg{"sessionInfo", R"({"world":"Altis","mission":"co40_loop"})"});
    b.EnqueueOutbound(OutboundMsg{"execResult", R"({"reqId":"r1","machine":"server","result":"SCALAR: 2"})"});

    // Drain inbound until the peer's exec frame arrives (or timeout).
    for (int i = 0; i < 100 && !g_gotExec; ++i) {
        b.DispatchInbound();
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }

    b.Stop();

    const std::string expected = BuildSafeArray({"e1", "server", "", "1+1", "loop"});
    if (g_gotExec && g_execPayload == expected) {
        std::printf("loopback: PASS (exec payload = %s)\n", g_execPayload.c_str());
        return 0;
    }
    std::printf("loopback: FAIL (gotExec=%d payload=%s expected=%s)\n",
                g_gotExec ? 1 : 0, g_execPayload.c_str(), expected.c_str());
    return 1;
}
