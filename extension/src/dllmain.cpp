// dllmain.cpp — Arma 3 extension entry points for the Arma-MCP bridge.
//
// CONTRACT:
//   * Every RVExtension* export returns near-instantly. No socket/pipe I/O, no
//     blocking, no locks held across I/O on the sim thread. Real work happens on
//     the Bridge worker thread.
//   * server -> game data is delivered to SQF via the engine callback, driven by
//     a per-frame "poll" command (DispatchInbound) so the 90/frame budget is
//     honored deterministically on a thread the engine is servicing.
//
// Commands (function string):
//   RVExtension       "version"|"poll"|"status"|"ping"|"shutdown"|"start"
//   RVExtensionArgs   "config"        [pipeName, useTcp("0"/"1"), tcpHost, tcpPort]
//                     "pushSession"   [bodyJson]
//                     "pushResult"    [bodyJson]
//                     "pushTelemetry" [bodyJson]
//                     "pushHeartbeat" [bodyJson]
//                     "pushLog"       [bodyJson]
//                     "openUrl"       [url] — local-only (no IPC): validates the
//                                     scheme (http/https) and opens the default
//                                     browser on a detached thread. Works on
//                                     player machines with no MCP server.
//
// Main menu connect window (see HostConnect.hpp). Everything but connectState is
// refused unless the engine says the caller is our function on the main menu:
//   RVExtension       "connectProbe"|"connectState"
//   RVExtensionArgs   "connectRun"    [hostId, hostId, ...]
//                     "connectRemove" [hostId]
//                     "copyText"      [text]
//
// The push* commands take ONE argument: a JSON object string built in SQF. The
// DLL stamps the {"v":1,"type":..} envelope (Bridge::WrapBody) so the server can
// trust `type`. See docs/protocol.md.

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  define AHC_EXPORT extern "C" __declspec(dllexport)
#  define AHC_CALL __stdcall
#else
#  define AHC_EXPORT extern "C"
#  define AHC_CALL
#endif

#include <cstring>
#include <string>
#include <vector>

#include "Bridge.hpp"
#include "HostConnect.hpp"
#include "Json.hpp"
#include "OpenUrl.hpp"

namespace {

ahc::Bridge g_bridge;

// Set by the engine on the calling thread right before each RVExtension* call.
thread_local ahc::connect::CallContext t_callContext;
const char* const kVersion = "ArmaMCP 0.5.14";

void WriteOutput(char* output, int outputSize, const std::string& s) {
    if (output == nullptr || outputSize <= 0) return;
#if defined(_WIN32)
    strncpy_s(output, static_cast<size_t>(outputSize), s.c_str(), _TRUNCATE);
#else
    const size_t cap = static_cast<size_t>(outputSize) - 1;
    const size_t n = s.size() < cap ? s.size() : cap;
    std::memcpy(output, s.data(), n);
    output[n] = '\0';
#endif
}

std::string StatusJson() {
    const ahc::Bridge::Status st = g_bridge.GetStatus();
    ahc::json::Object o{
        {"connected", st.connected ? "1" : "0"},
        {"out", std::to_string(st.outboundDepth)},
        {"in", std::to_string(st.inboundDepth)},
        {"dropped", std::to_string(st.outboundDropped)},
    };
    return ahc::json::Serialize(o);
}

// Strips the outer quotes Arma adds around string args, then decodes SQF's
// doubled-quote escape ("" -> ") so an embedded " survives intact.
std::string Unquote(const char* raw) {
    std::string v = raw ? raw : "";
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"') {
        v = v.substr(1, v.size() - 2);
    }
    std::string out;
    out.reserve(v.size());
    for (std::size_t i = 0; i < v.size(); ++i) {
        if (v[i] == '"' && i + 1 < v.size() && v[i + 1] == '"') {
            out += '"';
            ++i;
        } else {
            out += v[i];
        }
    }
    return out;
}

// Parses a port safely; never throws across the C ABI. false on bad input.
bool ParsePort(const std::string& s, std::uint16_t& out) {
    if (s.empty()) return false;
    unsigned long val = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        val = val * 10 + static_cast<unsigned long>(c - '0');
        if (val > 65535UL) return false;
    }
    out = static_cast<std::uint16_t>(val);
    return true;
}

// Shared handler for the push* commands (type = frame type; argv[0] = body).
int PushBody(char* output, int outputSize, const char* type, const char** argv, int argc) {
    if (argc < 1) {
        WriteOutput(output, outputSize, "err:argc");
        return 1;
    }
    ahc::OutboundMsg msg;
    msg.type = type;
    msg.body = Unquote(argv[0]);
    g_bridge.EnqueueOutbound(std::move(msg));
    WriteOutput(output, outputSize, "ok");
    return 0;
}

// Runs before each main menu command. A refusal goes to connect.log with what the
// engine reported, because that is the only record of who tried.
bool GateMenuCommand(const char* command) {
    std::string why;
    if (ahc::connect::AllowedFromMenu(t_callContext, why)) return true;
    ahc::connect::LogLine(std::string("refused ") + command + ": " + why);
    return false;
}

} // namespace

// Argument order is the engine's: steamID, fileSource, missionName, serverName,
// remoteExecutedOwner.
AHC_EXPORT void AHC_CALL RVExtensionContext(const char** argv, int argc) {
    ahc::connect::CallContext ctx;
    ctx.valid = argc >= 4;
    if (argc > 1) ctx.file = Unquote(argv[1]);
    if (argc > 2) ctx.mission = Unquote(argv[2]);
    if (argc > 3) ctx.server = Unquote(argv[3]);
    if (argc > 4) ctx.remoteOwner = Unquote(argv[4]);
    t_callContext = std::move(ctx);
}

AHC_EXPORT void AHC_CALL RVExtensionVersion(char* output, int outputSize) {
    WriteOutput(output, outputSize, kVersion);
}

AHC_EXPORT void AHC_CALL RVExtensionRegisterCallback(
        int (*callbackProc)(char const* name, char const* function, char const* data)) {
    g_bridge.SetCallback(callbackProc);
}

AHC_EXPORT void AHC_CALL RVExtension(char* output, int outputSize, const char* function) {
    const std::string fn = function ? function : "";

    if (fn == "poll") {
        const int n = g_bridge.DispatchInbound();
        WriteOutput(output, outputSize, std::to_string(n));
        return;
    }
    if (fn == "start") {
        g_bridge.Start();
        WriteOutput(output, outputSize, "ok");
        return;
    }
    if (fn == "status") {
        WriteOutput(output, outputSize, StatusJson());
        return;
    }
    if (fn == "version") {
        WriteOutput(output, outputSize, kVersion);
        return;
    }
    if (fn == "ping") {
        WriteOutput(output, outputSize, "pong");
        return;
    }
    if (fn == "shutdown") {
        g_bridge.Stop();
        WriteOutput(output, outputSize, "ok");
        return;
    }
    if (fn == "connectState") {
        WriteOutput(output, outputSize, ahc::connect::Instance().StateArray());
        return;
    }
    if (fn == "connectProbe") {
        if (!GateMenuCommand("connectProbe")) {
            WriteOutput(output, outputSize, "err:denied");
            return;
        }
        WriteOutput(output, outputSize, ahc::connect::Instance().Probe() ? "ok" : "err:busy");
        return;
    }
    WriteOutput(output, outputSize, "unknown");
}

AHC_EXPORT int AHC_CALL RVExtensionArgs(char* output, int outputSize, const char* function,
                                        const char** argv, int argc) {
    const std::string fn = function ? function : "";

    if (fn == "config") {
        const std::string pipeName = argc > 0 ? Unquote(argv[0]) : R"(\\.\pipe\arma_mcp)";
        const bool useTcp = argc > 1 && Unquote(argv[1]) == "1";
        const std::string host = argc > 2 ? Unquote(argv[2]) : "127.0.0.1";
        std::uint16_t port = 0;
        if (argc > 3) {
            const std::string portStr = Unquote(argv[3]);
            if (!portStr.empty() && !ParsePort(portStr, port)) {
                WriteOutput(output, outputSize, "err:port");
                return 1;
            }
        }
        g_bridge.Configure(pipeName, useTcp, host, port);
        WriteOutput(output, outputSize, "ok");
        return 0;
    }

    if (fn == "openUrl") {
        if (argc < 1) {
            WriteOutput(output, outputSize, "err:argc");
            return 1;
        }
        const std::string url = Unquote(argv[0]);
        if (!ahc::IsSafeHttpUrl(url)) {
            WriteOutput(output, outputSize, "err:scheme");
            return 1;
        }
        ahc::OpenUrlAsync(url);
        WriteOutput(output, outputSize, "ok");
        return 0;
    }

    if (fn == "connectRun" || fn == "connectRemove" || fn == "copyText") {
        if (!GateMenuCommand(fn.c_str())) {
            WriteOutput(output, outputSize, "err:denied");
            return 1;
        }
        if (argc < 1) {
            WriteOutput(output, outputSize, "err:argc");
            return 1;
        }
        bool started = true;
        if (fn == "copyText") {
            ahc::connect::CopyTextAsync(Unquote(argv[0]));
        } else if (fn == "connectRemove") {
            started = ahc::connect::Instance().Remove(Unquote(argv[0]));
        } else {
            std::vector<std::string> hostIds;
            for (int i = 0; i < argc; ++i) hostIds.push_back(Unquote(argv[i]));
            started = ahc::connect::Instance().Connect(hostIds);
        }
        WriteOutput(output, outputSize, started ? "ok" : "err:busy");
        return started ? 0 : 1;
    }

    if (fn == "pushSession")   return PushBody(output, outputSize, "sessionInfo", argv, argc);
    if (fn == "pushResult")    return PushBody(output, outputSize, "execResult", argv, argc);
    if (fn == "pushTelemetry") return PushBody(output, outputSize, "telemetry", argv, argc);
    if (fn == "pushHeartbeat") return PushBody(output, outputSize, "heartbeat", argv, argc);
    if (fn == "pushLog")       return PushBody(output, outputSize, "log", argv, argc);

    WriteOutput(output, outputSize, "unknown");
    return 1;
}

#if defined(_WIN32)
BOOL APIENTRY DllMain(HMODULE, DWORD reason, LPVOID) {
    // Do NOT touch the Bridge worker thread here — joining a thread inside
    // DllMain can deadlock the loader. Shutdown is driven explicitly via the
    // "shutdown" command from SQF at mission end.
    (void)reason;
    return TRUE;
}
#endif
