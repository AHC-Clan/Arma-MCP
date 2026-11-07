// HostConnect.hpp — connects the local MCP clients to Arma-MCP for the main menu
// "Connect AI Agent" window.
//
// This file and HostConnect.cpp are the DLL's host adapter: the only C++ that
// names a host CLI or its plugin commands. The mod carries no Node program, so
// the menu cannot reuse server/src/selfupdate/hosts.ts.
//
// CONTRACT:
//   * Every public call returns near-instantly. CLI calls run on one worker
//     thread; SQF polls StateArray().
//   * All command arguments are constants. Nothing from SQF reaches a command
//     line: host ids select from a fixed table.
//   * A mission or a server must not be able to run these commands, so the DLL
//     checks the engine call context itself (AllowedFromMenu). An SQF check would
//     not be a boundary because any SQF can call the extension directly.
//   * It never edits a marketplace registration that already exists, and it never
//     starts a daemon or touches the game pipe.

#pragma once

#include <atomic>
#include <mutex>
#include <string>
#include <vector>

namespace ahc::connect {

constexpr const char* kPluginId = "arma-mcp@ahc";
constexpr const char* kMarketplaceName = "ahc";
constexpr const char* kMarketplaceUrl = "https://github.com/AHC-Clan/Arma-MCP.git";

struct RunResult {
    bool started = false;
    bool timedOut = false;
    int exitCode = -1;
    std::string output;  // stdout + stderr, UTF-8, ANSI escapes removed
};

// OS access, injected so the flow can be tested without real host CLIs.
class Platform {
public:
    virtual ~Platform() = default;
    // Returns the full path, or "" when not found. extraDirs may hold %VAR%.
    virtual std::string FindExe(const std::string& name, const std::vector<std::string>& extraDirs) = 0;
    virtual RunResult Run(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs) = 0;
    virtual void ReportModPath() = 0;
    virtual void Log(const std::string& line) = 0;
};

// What the engine told us about the SQF that is calling (RVExtensionContext).
struct CallContext {
    bool valid = false;
    std::string file;
    std::string mission;
    std::string server;
    std::string remoteOwner;
};

// True only for our own function on the main menu. A false result fills `why`.
bool AllowedFromMenu(const CallContext& ctx, std::string& why);

// Readers for host CLI output. Pure, exposed for unit tests.
bool ClaudeHasPlugin(const std::string& listJson);
bool ClaudeHasMarketplace(const std::string& listJson);
bool CodexHasPlugin(const std::string& listText);
bool CodexHasMarketplace(const std::string& listText);
std::string StripAnsi(const std::string& s);

class Connector {
public:
    explicit Connector(Platform& platform);

    // False means the worker is busy and nothing was started.
    bool Probe();
    bool Connect(const std::vector<std::string>& hostIds);
    bool Remove(const std::string& hostId);
    bool IsBusy() const { return busy_.load(); }

    // A flat parseSimpleArray-safe array of strings:
    //   [phase, nodeFound, gitFound,
    //    <for each host> id, found, connected, activity, percent, failed, failText]
    // phase: idle | probing | ready | working. activity: "" | marketplace | install
    // | verify | remove. failText has "|" where it had line breaks.
    std::string StateArray() const;

private:
    struct HostState {
        std::string id;
        bool found = false;
        bool connected = false;
        std::string activity;
        int percent = 0;
        bool failed = false;
        std::string failText;
        std::string exe;
    };

    bool Begin(const char* phase);
    void Finish();
    void DoProbe();
    void DoConnect(const std::vector<std::string>& hostIds);
    void DoRemove(const std::string& hostId);
    void ConnectOne(std::size_t index, const std::string& exe);
    void SetActivity(std::size_t index, const char* activity, int percent);
    void Fail(std::size_t index, const std::string& text);
    RunResult RunLogged(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs);

    Platform& platform_;
    mutable std::mutex mtx_;
    std::atomic<bool> busy_{false};
    std::string phase_{"idle"};
    bool nodeFound_ = false;
    bool gitFound_ = false;
    std::vector<HostState> hosts_;
};

// The process-wide connector on the real OS. Never destroyed, so a worker that
// outlives the game's shutdown never touches a dead object.
Connector& Instance();

// Appends one line to %LOCALAPPDATA%\Arma-MCP\connect.log.
void LogLine(const std::string& line);

// Puts UTF-8 text on the Windows clipboard on a detached thread. SQF's
// copyToClipboard does not change the clipboard on current Arma builds.
void CopyTextAsync(const std::string& text);

// Test seam for the real process runner. Same behaviour as the Platform::Run
// used by Instance().
RunResult RunProcessForTest(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs);

}  // namespace ahc::connect
