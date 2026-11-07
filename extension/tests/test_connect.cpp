// test_connect.cpp — host CLI readers, the menu call gate, the connect flow against
// a fake platform, and the real process runner against a .cmd in a spaced path.
#include "../src/HostConnect.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <string>
#include <thread>
#include <vector>

#if defined(_WIN32)
#  include <filesystem>
#endif

using namespace ahc::connect;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

namespace {

const char* const kClaudeListOn = R"([
  {
    "id": "other@x",
    "version": "1.0.0",
    "enabled": true,
    "mcpServers": { "a": { "command": "node" } }
  },
  {
    "id": "arma-mcp@ahc",
    "version": "0.5.10",
    "scope": "user",
    "enabled": true
  }
])";

const char* const kClaudeListOff = R"([
  { "id": "arma-mcp@ahc", "version": "0.5.10", "scope": "user", "enabled": false },
  { "id": "other@x", "version": "1.0.0", "enabled": true }
])";

const char* const kClaudeMarketOn =
    R"([{"name":"humanizer","source":"github"},{"name":"ahc","source":"git","url":"http://example/x.git"}])";
const char* const kCodexListOn =
    "Marketplace `ahc`\n\nPLUGIN        STATUS              VERSION  SOURCE\n"
    "arma-mcp@ahc  installed, enabled  0.5.10   E:\\x\r\n";
const char* const kCodexListNot =
    "PLUGIN        STATUS         VERSION  SOURCE\narma-mcp@ahc  not installed  0.5.10   E:\\x\n";
const char* const kCodexMarketOn = "MARKETPLACE  ROOT\nph-sidecar   C:\\a\nahc          E:\\x\n";
const char* const kCodexMarketNot = "MARKETPLACE  ROOT\nahc-two      C:\\a\n";

void TestReaders() {
    CHECK(ClaudeHasPlugin(kClaudeListOn));
    CHECK(!ClaudeHasPlugin(kClaudeListOff));
    CHECK(!ClaudeHasPlugin("[]"));
    CHECK(!ClaudeHasPlugin(""));

    CHECK(ClaudeHasMarketplace(kClaudeMarketOn));
    CHECK(!ClaudeHasMarketplace(R"([{"name":"ahc-two"}])"));

    CHECK(CodexHasPlugin(kCodexListOn));
    CHECK(!CodexHasPlugin(kCodexListNot));
    CHECK(!CodexHasPlugin("arma-mcp@ahc-two  installed, enabled\n"));

    CHECK(CodexHasMarketplace(kCodexMarketOn));
    CHECK(!CodexHasMarketplace(kCodexMarketNot));

    CHECK(StripAnsi("\x1b[31mred\x1b[0m ok") == "red ok");
}

void TestGate() {
    // The form Arma 2.22 reports on the main menu.
    const std::string ours = "/ahc/addons/arma_mcp/functions/fn_connectAction.sqf";
    std::string why;

    CallContext menu;
    menu.valid = true;
    menu.file = ours;
    CHECK(AllowedFromMenu(menu, why));
    CHECK(why.empty());

    CallContext noContext;
    noContext.file = ours;
    CHECK(!AllowedFromMenu(noContext, why));

    CallContext mission = menu;
    mission.mission = "co40_op";
    CHECK(!AllowedFromMenu(mission, why));

    CallContext server = menu;
    server.server = "AHC";
    CHECK(!AllowedFromMenu(server, why));

    CallContext remote = menu;
    remote.remoteOwner = "3";
    CHECK(!AllowedFromMenu(remote, why));

    CallContext remoteZero = menu;
    remoteZero.remoteOwner = "0";
    CHECK(AllowedFromMenu(remoteZero, why));

    // Another addon's file, and our own addon's non-connect code.
    CallContext other = menu;
    other.file = "x\\evil\\fn_connect.sqf";
    CHECK(!AllowedFromMenu(other, why));
    CallContext notConnect = menu;
    notConnect.file = "/ahc/addons/arma_mcp/functions/fn_execRun.sqf";
    CHECK(!AllowedFromMenu(notConnect, why));
    // A mission folder that copies our path is not our addon.
    CallContext nested = menu;
    nested.file = "/mpmissions/x/ahc/addons/arma_mcp/functions/fn_connectAction.sqf";
    CHECK(!AllowedFromMenu(nested, why));
    // Backslashes and case do not matter.
    CallContext backslash = menu;
    backslash.file = "AHC\\addons\\arma_mcp\\functions\\fn_connectAction.sqf";
    CHECK(AllowedFromMenu(backslash, why));

    // compile from a string has no source file.
    CallContext compiled = menu;
    compiled.file.clear();
    CHECK(!AllowedFromMenu(compiled, why));
}

class FakePlatform final : public Platform {
public:
    std::map<std::string, std::string> exes;
    std::vector<std::string> calls;
    bool claudeInstalled = false;
    bool claudeMarket = false;
    int installExit = 0;

    std::string FindExe(const std::string& name, const std::vector<std::string>&) override {
        const auto it = exes.find(name);
        return it == exes.end() ? std::string() : it->second;
    }

    RunResult Run(const std::string& exe, const std::vector<std::string>& args, unsigned) override {
        std::string line = exe;
        for (const std::string& a : args) line += " " + a;
        calls.push_back(line);

        RunResult r;
        r.started = true;
        r.exitCode = 0;
        if (line == "claude plugin list --json") {
            r.output = claudeInstalled ? kClaudeListOn : "[]";
        } else if (line == "claude plugin marketplace list --json") {
            r.output = claudeMarket ? kClaudeMarketOn : "[]";
        } else if (line.rfind("claude plugin marketplace add", 0) == 0) {
            claudeMarket = true;
        } else if (line.rfind("claude plugin install", 0) == 0) {
            r.exitCode = installExit;
            r.output = installExit == 0 ? "" : "install broke \xEA\xB0\x80";
            if (installExit == 0) claudeInstalled = true;
        } else if (line.rfind("claude plugin uninstall", 0) == 0) {
            claudeInstalled = false;
        }
        return r;
    }

    void ReportModPath() override { ++reports; }
    void Log(const std::string&) override {}
    int reports = 0;
};

void WaitIdle(const Connector& c) {
    for (int i = 0; i < 500 && c.IsBusy(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    CHECK(!c.IsBusy());
}

bool Contains(const std::string& s, const std::string& what) {
    return s.find(what) != std::string::npos;
}

int CountCalls(const FakePlatform& p, const std::string& prefix) {
    int n = 0;
    for (const std::string& c : p.calls) {
        if (c.rfind(prefix, 0) == 0) ++n;
    }
    return n;
}

void TestProbe() {
    FakePlatform p;
    p.exes = {{"node", "node"}, {"claude", "claude"}};
    Connector c(p);
    CHECK(Contains(c.StateArray(), "\"idle\""));

    CHECK(c.Probe());
    WaitIdle(c);
    const std::string state = c.StateArray();
    // phase, node found, git missing, claude found and not connected, codex missing.
    CHECK(state.rfind("[\"ready\",\"1\",\"0\",\"claude\",\"1\",\"0\",\"\",\"0\",\"0\",\"\",\"codex\",\"0\",\"0\"", 0) == 0);
    CHECK(p.reports == 1);
}

void TestConnectAddsMissingMarketplace() {
    FakePlatform p;
    p.exes = {{"node", "node"}, {"git", "git"}, {"claude", "claude"}};
    Connector c(p);
    c.Probe();
    WaitIdle(c);

    CHECK(c.Connect({"claude", "codex", "unknown"}));
    WaitIdle(c);
    CHECK(Contains(c.StateArray(), "\"claude\",\"1\",\"1\""));
    CHECK(CountCalls(p, std::string("claude plugin marketplace add ") + kMarketplaceUrl) == 1);
    CHECK(CountCalls(p, "claude plugin install arma-mcp@ahc --scope user") == 1);
    // Not found on this PC and not in the table: nothing runs.
    CHECK(CountCalls(p, "codex") == 0);
    CHECK(CountCalls(p, "unknown") == 0);
}

void TestConnectKeepsExistingMarketplace() {
    FakePlatform p;
    p.exes = {{"node", "node"}, {"git", "git"}, {"claude", "claude"}};
    p.claudeMarket = true;
    Connector c(p);
    c.Probe();
    WaitIdle(c);

    CHECK(c.Connect({"claude"}));
    WaitIdle(c);
    CHECK(Contains(c.StateArray(), "\"claude\",\"1\",\"1\""));
    CHECK(CountCalls(p, "claude plugin marketplace add") == 0);
}

void TestFailureKeepsReason() {
    FakePlatform p;
    p.exes = {{"node", "node"}, {"git", "git"}, {"claude", "claude"}};
    p.installExit = 7;
    Connector c(p);
    c.Probe();
    WaitIdle(c);

    CHECK(c.Connect({"claude"}));
    WaitIdle(c);
    const std::string state = c.StateArray();
    CHECK(Contains(state, "\"claude\",\"1\",\"0\",\"\",\"0\",\"1\""));
    CHECK(Contains(state, "exit 7"));
    CHECK(Contains(state, "install broke \xEA\xB0\x80"));
    // Line breaks travel as | because BuildSafeArray flattens control characters.
    CHECK(Contains(state, "|exit 7|"));
    CHECK(Contains(state, "claude plugin install"));

    // A later probe clears it.
    p.installExit = 0;
    c.Probe();
    WaitIdle(c);
    CHECK(!Contains(c.StateArray(), "exit 7"));
}

void TestRemove() {
    FakePlatform p;
    p.exes = {{"node", "node"}, {"git", "git"}, {"claude", "claude"}};
    p.claudeInstalled = true;
    p.claudeMarket = true;
    Connector c(p);
    c.Probe();
    WaitIdle(c);
    CHECK(Contains(c.StateArray(), "\"claude\",\"1\",\"1\""));

    CHECK(c.Remove("claude"));
    WaitIdle(c);
    CHECK(Contains(c.StateArray(), "\"claude\",\"1\",\"0\",\"\",\"0\",\"0\""));
    CHECK(CountCalls(p, "claude plugin uninstall arma-mcp@ahc --scope user") == 1);
    // The marketplace registration stays.
    CHECK(CountCalls(p, "claude plugin marketplace remove") == 0);
}

#if defined(_WIN32)
void TestRealProcess() {
    namespace fs = std::filesystem;
    const fs::path dir = fs::temp_directory_path() / "arma mcp (x86) test";
    fs::create_directories(dir);
    const fs::path shim = dir / "fake host.cmd";
    {
        std::ofstream f(shim, std::ios::binary);
        f << "@echo off\r\necho got %1 %2\r\necho on stderr 1>&2\r\nexit /b 3\r\n";
    }
    RunResult r = RunProcessForTest(shim.string(), {"plugin", "--json"}, 15000);
    CHECK(r.started);
    CHECK(!r.timedOut);
    CHECK(r.exitCode == 3);
    CHECK(Contains(r.output, "got \"plugin\" \"--json\""));
    CHECK(Contains(r.output, "on stderr"));

    const fs::path slow = dir / "slow.cmd";
    {
        std::ofstream f(slow, std::ios::binary);
        f << "@echo off\r\nping -n 30 127.0.0.1 >nul\r\n";
    }
    r = RunProcessForTest(slow.string(), {}, 400);
    CHECK(r.started);
    CHECK(r.timedOut);

    r = RunProcessForTest((dir / "missing.exe").string(), {}, 1000);
    CHECK(!r.started);

    std::error_code ignored;
    fs::remove_all(dir, ignored);
}
#endif

}  // namespace

int main() {
    TestReaders();
    TestGate();
    TestProbe();
    TestConnectAddsMissingMarketplace();
    TestConnectKeepsExistingMarketplace();
    TestFailureKeepsReason();
    TestRemove();
#if defined(_WIN32)
    TestRealProcess();
#endif

    if (g_failures == 0) std::printf("test_connect: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
