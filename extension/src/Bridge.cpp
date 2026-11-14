#include "Bridge.hpp"

#include <chrono>
#include <cstdlib>
#include <utility>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#else
#  include <unistd.h>
#endif

#include "Json.hpp"
#include "Protocol.hpp"
#include "SafeArray.hpp"

namespace ahc {

Bridge::Bridge() = default;

Bridge::~Bridge() {
    Stop();
}

namespace {

// Reads one environment variable. Empty when unset or unreadable.
std::string ReadEnv(const char* name) {
#if defined(_WIN32)
    char buf[Bridge::kMaxPipeNameLen + 2] = {};
    const DWORD n = GetEnvironmentVariableA(name, buf, static_cast<DWORD>(sizeof(buf)));
    // n >= sizeof(buf) means the value did not fit; treat it as unusable.
    if (n == 0 || n >= sizeof(buf)) return std::string();
    return std::string(buf, n);
#else
    const char* v = std::getenv(name);
    return v ? std::string(v) : std::string();
#endif
}

unsigned long CurrentPid() {
#if defined(_WIN32)
    return static_cast<unsigned long>(GetCurrentProcessId());
#else
    return static_cast<unsigned long>(getpid());
#endif
}

} // namespace

std::string Bridge::ResolvePipeName(const std::string& sqfName, const char* envValue) {
    if (envValue == nullptr) return sqfName;
    const std::string v(envValue);
    static const std::string kPrefix = R"(\\.\pipe\)";
    if (v.size() <= kPrefix.size() || v.size() > kMaxPipeNameLen) return sqfName;
    for (std::size_t i = 0; i < kPrefix.size(); ++i) {
        char a = v[i];
        char e = kPrefix[i];
        if (a >= 'A' && a <= 'Z') a = static_cast<char>(a - 'A' + 'a');
        if (a != e) return sqfName;
    }
    for (const char ch : v) {
        if (static_cast<unsigned char>(ch) < 0x20) return sqfName;
    }
    return v;
}

std::string Bridge::BuildHello(const std::string& version, unsigned long pid) {
    return std::string("{\"v\":1,\"type\":\"hello\",\"role\":\"arma-ext\",\"ver\":\"") + version +
           "\",\"pid\":" + std::to_string(pid) + "}";
}

void Bridge::Configure(std::string pipeName, bool useTcp, std::string tcpHost, std::uint16_t tcpPort) {
    const std::string env = ReadEnv(kGamePipeEnv);
    pipeName_ = ResolvePipeName(pipeName, env.empty() ? nullptr : env.c_str());
    useTcp_ = useTcp;
    tcpHost_ = std::move(tcpHost);
    tcpPort_ = tcpPort;
}

void Bridge::SetCallback(CallbackFn cb) {
    callback_.store(cb, std::memory_order_release);
}

void Bridge::Start() {
    bool expected = false;
    if (!running_.compare_exchange_strong(expected, true)) return;
    worker_ = std::thread([this] { WorkerLoop(); });
}

void Bridge::Stop() {
    bool expected = true;
    if (!running_.compare_exchange_strong(expected, false)) return;
    // The worker exclusively owns the IpcClient and closes it on exit, so there
    // is no concurrent handle access. The worker only polls (short timeouts), so
    // join returns within ~1s. Never call this from DllMain.
    outCv_.notify_all();
    if (worker_.joinable()) worker_.join();
    connected_.store(false, std::memory_order_release);
}

void Bridge::EnqueueOutbound(OutboundMsg msg) {
    {
        std::lock_guard<std::mutex> lock(outMtx_);
        if (outQ_.size() >= kOutboundCap) {
            outQ_.pop_front();
            outboundDropped_.fetch_add(1, std::memory_order_relaxed);
        }
        outQ_.push_back(std::move(msg));
    }
    outCv_.notify_one();
}

std::vector<OutboundMsg> Bridge::WaitOutbound(std::size_t maxItems, std::chrono::milliseconds timeout) {
    std::vector<OutboundMsg> batch;
    std::unique_lock<std::mutex> lock(outMtx_);
    outCv_.wait_for(lock, timeout, [this] { return !outQ_.empty() || !running_.load(); });
    while (!outQ_.empty() && batch.size() < maxItems) {
        batch.push_back(std::move(outQ_.front()));
        outQ_.pop_front();
    }
    return batch;
}

std::string Bridge::WrapBody(const std::string& type, const std::string& body) {
    // Trim body.
    std::size_t a = 0, b = body.size();
    while (a < b && (body[a] == ' ' || body[a] == '\t' || body[a] == '\r' || body[a] == '\n')) ++a;
    while (b > a && (body[b - 1] == ' ' || body[b - 1] == '\t' || body[b - 1] == '\r' || body[b - 1] == '\n')) --b;

    std::string inner;
    if (b - a >= 2 && body[a] == '{' && body[b - 1] == '}') {
        // Take everything between the outer braces, then trim it too.
        std::size_t ia = a + 1, ib = b - 1;
        while (ia < ib && (body[ia] == ' ' || body[ia] == '\t' || body[ia] == '\r' || body[ia] == '\n')) ++ia;
        while (ib > ia && (body[ib - 1] == ' ' || body[ib - 1] == '\t' || body[ib - 1] == '\r' || body[ib - 1] == '\n')) --ib;
        inner = body.substr(ia, ib - ia);
    }
    // else: malformed body -> emit just the envelope (inner empty).

    std::string out = "{\"v\":1,\"type\":\"";
    out += type;
    out += "\"";
    if (!inner.empty()) {
        out += ",";
        out += inner;
    }
    out += "}";
    return out;
}

void Bridge::OnInboundFrame(const std::string& jsonPayload) {
    json::Object obj;
    if (!json::Parse(jsonPayload, obj)) return;

    const auto typeIt = obj.find("type");
    if (typeIt == obj.end()) return;
    const std::string& type = typeIt->second;

    auto get = [&obj](const char* k) -> std::string {
        auto it = obj.find(k);
        return it == obj.end() ? std::string() : it->second;
    };

    if (type == "exec") {
        // Server -> game SQF exec. payload = [reqId, mode, target, code, label]
        InboundMsg m;
        m.function = "exec";
        m.payload = BuildSafeArray({get("reqId"), get("mode"), get("target"), get("code"), get("label")});
        std::lock_guard<std::mutex> lock(inMtx_);
        inQ_.push_back(std::move(m));
    } else if (type == "telemetryRequest") {
        // Immediate telemetry + sessionInfo push. payload = [reqId]
        InboundMsg m;
        m.function = "telemetryReq";
        m.payload = BuildSafeArray({get("reqId")});
        std::lock_guard<std::mutex> lock(inMtx_);
        inQ_.push_back(std::move(m));
    }
    // "ping" is liveness only; no dispatch.
}

int Bridge::DispatchInbound() {
    CallbackFn cb = callback_.load(std::memory_order_acquire);
    if (cb == nullptr) return 0;

    int dispatched = 0;
    for (int i = 0; i < kPerFrameBudget; ++i) {
        InboundMsg msg;
        {
            std::lock_guard<std::mutex> lock(inMtx_);
            if (inQ_.empty()) break;
            msg = inQ_.front();   // peek — do NOT pop until the engine accepts it
        }

        // Negative result = the engine's per-frame input buffer is full: stop and
        // retry next frame WITHOUT popping. `function` routes SQF to the handler.
        const int remaining = cb("AHC_ArmaMCP", msg.function.c_str(), msg.payload.c_str());
        if (remaining < 0) break;

        {
            std::lock_guard<std::mutex> lock(inMtx_);
            if (!inQ_.empty()) inQ_.pop_front();
        }
        ++dispatched;
    }
    return dispatched;
}

Bridge::Status Bridge::GetStatus() const {
    Status s{};
    s.connected = connected_.load(std::memory_order_acquire);
    {
        std::lock_guard<std::mutex> lock(outMtx_);
        s.outboundDepth = outQ_.size();
    }
    {
        std::lock_guard<std::mutex> lock(inMtx_);
        s.inboundDepth = inQ_.size();
    }
    s.outboundDropped = outboundDropped_.load(std::memory_order_relaxed);
    return s;
}

void Bridge::WorkerLoop() {
    using namespace std::chrono_literals;
    auto backoff = 250ms;
    constexpr auto kMaxBackoff = 5000ms;

    while (running_.load()) {
        bool ok = useTcp_ ? ipc_.ConnectTcp(tcpHost_, tcpPort_)
                          : ipc_.ConnectPipe(pipeName_);
        if (!ok) {
            connected_.store(false, std::memory_order_release);
            for (auto waited = 0ms; waited < backoff && running_.load(); waited += 50ms) {
                std::this_thread::sleep_for(50ms);
            }
            backoff = (backoff * 2 > kMaxBackoff) ? kMaxBackoff : backoff * 2;
            continue;
        }
        connected_.store(true, std::memory_order_release);
        backoff = 250ms;

        // Greet the server so it can log/validate the peer.
        ipc_.SendFrame(BuildHello("ArmaMCP 0.5.14", CurrentPid()));

        ipc_.SetFrameHandler([this](const std::string& payload) { OnInboundFrame(payload); });

        while (running_.load() && ipc_.IsConnected()) {
            auto batch = WaitOutbound(64, kIdlePollInterval);
            for (std::size_t i = 0; i < batch.size(); ++i) {
                const OutboundMsg& m = batch[i];
                const std::string frame = WrapBody(m.type, m.body);
                if (!ipc_.SendFrame(frame)) {
                    // Re-queue the failed message and everything after it, at the
                    // front and in order, then reconnect. Nothing is lost.
                    std::lock_guard<std::mutex> lock(outMtx_);
                    for (std::size_t j = batch.size(); j-- > i;) {
                        outQ_.push_front(std::move(batch[j]));
                    }
                    goto reconnect;
                }
            }
            if (!ipc_.PumpReads()) {
                goto reconnect;
            }
        }

    reconnect:
        connected_.store(false, std::memory_order_release);
        ipc_.Disconnect();
    }
}

} // namespace ahc
