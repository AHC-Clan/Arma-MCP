// test_queue.cpp — Bridge queue behavior: concurrency, ordering, the outbound
// drop-oldest cap, and the inbound 90/frame backpressure with NO message loss.
#include "../src/Bridge.hpp"
#include "../src/SafeArray.hpp"

#include <cstdio>
#include <string>
#include <thread>
#include <vector>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

static std::vector<std::string> g_received;
static int g_slotsThisFrame = 0;
static int g_frameCapacity = 5;

static int FakeCallback(const char* name, const char* function, const char* data) {
    (void)name; (void)function;
    if (g_slotsThisFrame >= g_frameCapacity) {
        return -1;
    }
    g_received.emplace_back(data);
    ++g_slotsThisFrame;
    return g_frameCapacity - g_slotsThisFrame;
}

int main() {
    // 1) Outbound ordering + concurrent producers, drained by WaitOutbound.
    {
        Bridge b;
        constexpr int kProducers = 4;
        constexpr int kPer = 250;
        std::vector<std::thread> producers;
        for (int p = 0; p < kProducers; ++p) {
            producers.emplace_back([&b, p, kPer] {
                for (int i = 0; i < kPer; ++i) {
                    b.EnqueueOutbound(OutboundMsg{"execResult",
                        std::string("{\"reqId\":\"") + std::to_string(p) + "-" + std::to_string(i) + "\"}"});
                }
            });
        }
        for (auto& t : producers) t.join();

        std::size_t drained = 0;
        for (;;) {
            auto batch = b.WaitOutbound(64, std::chrono::milliseconds(20));
            if (batch.empty()) break;
            drained += batch.size();
        }
        CHECK(drained == static_cast<std::size_t>(kProducers * kPer));
    }

    // 2) Inbound 90/frame backpressure: enqueue 23 exec frames, dispatch frame by
    //    frame with a fake 5/frame engine cap; ALL 23 must arrive, in order.
    {
        Bridge b;
        b.SetCallback(&FakeCallback);
        g_received.clear();

        constexpr int kTotal = 23;
        for (int i = 0; i < kTotal; ++i) {
            const std::string frame =
                std::string("{\"v\":1,\"type\":\"exec\",\"reqId\":\"") + std::to_string(i) +
                "\",\"mode\":\"server\",\"target\":\"\",\"code\":\"1+1\",\"label\":\"l\"}";
            b.OnInboundFrame(frame);
        }

        int frames = 0;
        int totalDispatched = 0;
        while (totalDispatched < kTotal && frames < 100) {
            g_slotsThisFrame = 0;
            const int n = b.DispatchInbound();
            totalDispatched += n;
            ++frames;
            CHECK(n <= g_frameCapacity);
        }
        CHECK(totalDispatched == kTotal);
        CHECK(g_received.size() == static_cast<std::size_t>(kTotal));
        CHECK(frames >= 5);

        bool ordered = true;
        for (int i = 0; i < kTotal; ++i) {
            const std::string expect = BuildSafeArray({std::to_string(i), "server", "", "1+1", "l"});
            if (g_received[i] != expect) { ordered = false; break; }
        }
        CHECK(ordered);
    }

    // 3) Outbound cap drops OLDEST and counts drops (cap is 10000).
    {
        Bridge b;
        for (int i = 0; i < 10000 + 50; ++i) {
            b.EnqueueOutbound(OutboundMsg{"telemetry", "{}"});
        }
        const auto st = b.GetStatus();
        CHECK(st.outboundDepth == 10000);
        CHECK(st.outboundDropped == 50);
    }

    if (g_failures == 0) std::printf("test_queue: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
