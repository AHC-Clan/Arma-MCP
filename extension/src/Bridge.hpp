// Bridge.hpp — the core engine of the arma_mcp extension.
//
// Responsibilities:
//   * Hold the outbound queue (game -> MCP server). The sim thread pushes here
//     and returns instantly; a worker thread drains it to the server.
//   * Hold the inbound queue (server -> game). The worker pushes received
//     messages here; a dispatcher drains it into SQF via the registered
//     callback, honoring the engine's ~90-callbacks-per-frame budget.
//   * Own the worker thread and the IPC client connection lifecycle.
//
// Threading model:
//   - Sim thread:    Enqueue*/Dispatch* (called from RVExtension* exports).
//   - Worker thread: connects/reconnects IPC, drains outbound, reads inbound.
// All queues are mutex-guarded. The sim thread NEVER blocks on I/O.

#pragma once

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "IpcClient.hpp"

namespace ahc {

using CallbackFn = int (*)(char const* name, char const* function, char const* data);

// One message going out to the MCP server. `type` is the frame type
// ("sessionInfo" | "execResult" | "telemetry" | "heartbeat" | "log"); `body` is
// the raw inner JSON object built by SQF, e.g. {"reqId":"..","result":".."}.
// The worker stamps the {"v":1,"type":..} envelope via WrapBody.
struct OutboundMsg {
    std::string type;
    std::string body;
};

// One message from the server, dispatched into SQF via the engine callback.
// `function` is the ExtensionCallback function name ("exec" | "telemetryReq");
// `payload` is an already-built parseSimpleArray-safe string.
struct InboundMsg {
    std::string function;
    std::string payload;
};

class Bridge {
public:
    Bridge();
    ~Bridge();

    Bridge(const Bridge&) = delete;
    Bridge& operator=(const Bridge&) = delete;

    // pipeName is what SQF passes. When the process environment carries a valid
    // ARMA_MCP_GAME_PIPE (set by the daemon for the games it launches), that pipe
    // wins, so each test stack's games reach that stack's own pipe.
    void Configure(std::string pipeName, bool useTcp, std::string tcpHost, std::uint16_t tcpPort);
    void SetCallback(CallbackFn cb);
    void Start();
    void Stop();

    // --- sim thread (RVExtension* exports) ---
    void EnqueueOutbound(OutboundMsg msg);
    int DispatchInbound();

    struct Status {
        bool connected;
        std::size_t outboundDepth;
        std::size_t inboundDepth;
        std::uint64_t outboundDropped;
    };
    Status GetStatus() const;

    // --- worker thread ---
    std::vector<OutboundMsg> WaitOutbound(std::size_t maxItems, std::chrono::milliseconds timeout);
    void OnInboundFrame(const std::string& jsonPayload);

    // Stamps the {"v":1,"type":<type>, <inner-of-body>} envelope around an
    // SQF-built body. Exposed for unit testing.
    static std::string WrapBody(const std::string& type, const std::string& body);

    // Environment variable the daemon sets on the games it launches.
    static constexpr const char* kGamePipeEnv = "ARMA_MCP_GAME_PIPE";

    // Returns envValue when it is a usable local pipe name (\\.\pipe\<name>, at
    // most kMaxPipeNameLen bytes, no control characters), otherwise sqfName.
    // Pure function, exposed for unit testing.
    static std::string ResolvePipeName(const std::string& sqfName, const char* envValue);
    static constexpr std::size_t kMaxPipeNameLen = 256;

    // The hello frame. pid identifies the game process in daemon diagnostics.
    static std::string BuildHello(const std::string& version, unsigned long pid);

private:
    void WorkerLoop();

    mutable std::mutex outMtx_;
    std::condition_variable outCv_;
    std::deque<OutboundMsg> outQ_;
    static constexpr std::size_t kOutboundCap = 10000;
    std::atomic<std::uint64_t> outboundDropped_{0};

    mutable std::mutex inMtx_;
    std::deque<InboundMsg> inQ_;

    static constexpr int kPerFrameBudget = 90;

    // Worker loop cadence when the outbound queue is idle. PumpReads() runs only
    // after WaitOutbound() returns, so this bounds how long an inbound exec frame
    // can sit unread on the pipe (avg = half). Outbound is unaffected — Enqueue
    // notifies the cv immediately. cv wait + PeekNamedPipe are µs-scale, so a
    // 5 ms cadence (~200 wakes/s when idle) has negligible CPU cost.
    static constexpr std::chrono::milliseconds kIdlePollInterval{5};

    std::atomic<CallbackFn> callback_{nullptr};

    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<bool> connected_{false};
    IpcClient ipc_;

    std::string pipeName_{R"(\\.\pipe\arma_mcp)"};
    bool useTcp_{false};
    std::string tcpHost_{"127.0.0.1"};
    std::uint16_t tcpPort_{0};
};

} // namespace ahc
