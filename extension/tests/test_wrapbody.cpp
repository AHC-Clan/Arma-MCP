// test_wrapbody.cpp — Bridge::WrapBody stamps a trustworthy envelope around an
// SQF-built body, and the inbound router builds the right parseSimpleArray payload.
#include "../src/Bridge.hpp"
#include "../src/SafeArray.hpp"

#include <cstdio>
#include <string>
#include <vector>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

// A fake engine callback recording dispatched (function, payload) pairs.
static std::vector<std::string> g_fn;
static std::vector<std::string> g_payload;
static int FakeCallback(const char* name, const char* function, const char* data) {
    (void)name;
    g_fn.emplace_back(function);
    g_payload.emplace_back(data);
    return 90;
}

int main() {
    // 1) Normal object body: inner fields preserved, envelope prepended.
    {
        const std::string out = Bridge::WrapBody("execResult", R"({"reqId":"a1","machine":"server","result":"SCALAR: 2"})");
        CHECK(out == R"({"v":1,"type":"execResult","reqId":"a1","machine":"server","result":"SCALAR: 2"})");
    }
    // 2) Empty object body: envelope only.
    {
        const std::string out = Bridge::WrapBody("heartbeat", "{}");
        CHECK(out == R"({"v":1,"type":"heartbeat"})");
    }
    // 3) Whitespace around body and inner tolerated.
    {
        const std::string out = Bridge::WrapBody("telemetry", "  {  \"fps\":50  }  ");
        CHECK(out == R"({"v":1,"type":"telemetry","fps":50})");
    }
    // 4) Malformed body (no braces): envelope only, no injection.
    {
        const std::string out = Bridge::WrapBody("log", "not json");
        CHECK(out == R"({"v":1,"type":"log"})");
    }

    // 5) Inbound routing: exec frame -> function "exec", 5-field payload.
    {
        Bridge b;
        b.SetCallback(&FakeCallback);
        g_fn.clear(); g_payload.clear();
        b.OnInboundFrame(R"({"v":1,"type":"exec","reqId":"r1","mode":"server","target":"","code":"1+1","label":"mission-author"})");
        const int n = b.DispatchInbound();
        CHECK(n == 1);
        CHECK(g_fn.size() == 1 && g_fn[0] == "exec");
        CHECK(g_payload[0] == BuildSafeArray({"r1", "server", "", "1+1", "mission-author"}));
    }
    // 6) Missing label remains an empty field for older protocol-v1 senders.
    {
        Bridge b;
        b.SetCallback(&FakeCallback);
        g_fn.clear(); g_payload.clear();
        b.OnInboundFrame(R"({"v":1,"type":"exec","reqId":"r2","mode":"server","target":"","code":"1+1"})");
        const int n = b.DispatchInbound();
        CHECK(n == 1);
        CHECK(g_payload[0] == BuildSafeArray({"r2", "server", "", "1+1", ""}));
    }
    // 7) Inbound routing: telemetryRequest -> function "telemetryReq", [reqId].
    {
        Bridge b;
        b.SetCallback(&FakeCallback);
        g_fn.clear(); g_payload.clear();
        b.OnInboundFrame(R"({"v":1,"type":"telemetryRequest","reqId":"r3"})");
        const int n = b.DispatchInbound();
        CHECK(n == 1);
        CHECK(g_fn[0] == "telemetryReq");
        CHECK(g_payload[0] == BuildSafeArray({"r3"}));
    }
    // 8) ping is liveness only — nothing dispatched.
    {
        Bridge b;
        b.SetCallback(&FakeCallback);
        g_fn.clear(); g_payload.clear();
        b.OnInboundFrame(R"({"v":1,"type":"ping"})");
        CHECK(b.DispatchInbound() == 0);
    }

    if (g_failures == 0) std::printf("test_wrapbody: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
