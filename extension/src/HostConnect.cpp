#include "HostConnect.hpp"

#include <algorithm>
#include <cctype>
#include <cstddef>
#include <thread>

#include "Json.hpp"
#include "SafeArray.hpp"
#include "Utf8.hpp"

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  include <windows.h>
#endif

namespace ahc::connect {

namespace {

constexpr unsigned kListTimeoutMs = 30000;
constexpr unsigned kInstallTimeoutMs = 180000;
constexpr std::size_t kMaxFailBytes = 1200;
constexpr std::size_t kMaxOutputBytes = 256 * 1024;

struct HostSpec {
    const char* id;
    const char* exe;
    std::vector<std::string> extraDirs;
    std::vector<std::string> listArgs;
    std::vector<std::string> marketListArgs;
    std::vector<std::string> marketAddArgs;
    std::vector<std::string> installArgs;
    std::vector<std::string> removeArgs;
    bool (*hasPlugin)(const std::string&);
    bool (*hasMarket)(const std::string&);
};

const std::vector<HostSpec>& Hosts() {
    static const std::vector<HostSpec> hosts = {
        {"claude",
         "claude",
         {R"(%USERPROFILE%\.local\bin)", R"(%APPDATA%\npm)"},
         {"plugin", "list", "--json"},
         {"plugin", "marketplace", "list", "--json"},
         {"plugin", "marketplace", "add", kMarketplaceUrl, "--json"},
         {"plugin", "install", kPluginId, "--scope", "user", "--json"},
         {"plugin", "uninstall", kPluginId, "--scope", "user", "--json"},
         ClaudeHasPlugin,
         ClaudeHasMarketplace},
        {"codex",
         "codex",
         {R"(%LOCALAPPDATA%\Programs\OpenAI\Codex\bin)", R"(%APPDATA%\npm)"},
         {"plugin", "list"},
         {"plugin", "marketplace", "list"},
         {"plugin", "marketplace", "add", kMarketplaceUrl},
         {"plugin", "add", kPluginId},
         {"plugin", "remove", kPluginId},
         CodexHasPlugin,
         CodexHasMarketplace},
    };
    return hosts;
}

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::string Join(const std::vector<std::string>& parts) {
    std::string out;
    for (const std::string& p : parts) {
        if (!out.empty()) out += ' ';
        out += p;
    }
    return out;
}

std::size_t SkipSpace(const std::string& s, std::size_t i) {
    while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i])) != 0) ++i;
    return i;
}

// Finds `"key"` then `:` from `from`. Returns the index right after the colon and
// any spaces, or npos.
std::size_t FindKeyValue(const std::string& s, const std::string& key, std::size_t from) {
    const std::string quoted = "\"" + key + "\"";
    std::size_t at = from;
    while ((at = s.find(quoted, at)) != std::string::npos) {
        std::size_t i = SkipSpace(s, at + quoted.size());
        if (i < s.size() && s[i] == ':') return SkipSpace(s, i + 1);
        at += quoted.size();
    }
    return std::string::npos;
}

bool ValueIs(const std::string& s, std::size_t at, const std::string& value) {
    return s.compare(at, value.size() + 2, "\"" + value + "\"") == 0;
}

std::vector<std::string> SplitLines(const std::string& s) {
    std::vector<std::string> lines;
    std::size_t start = 0;
    while (start <= s.size()) {
        std::size_t end = s.find('\n', start);
        if (end == std::string::npos) end = s.size();
        std::string line = s.substr(start, end - start);
        if (!line.empty() && line.back() == '\r') line.pop_back();
        lines.push_back(line);
        start = end + 1;
    }
    return lines;
}

// The first word of a table row, when the row starts with it.
bool FirstWordIs(const std::string& line, const std::string& word) {
    const std::size_t i = SkipSpace(line, 0);
    if (line.compare(i, word.size(), word) != 0) return false;
    const std::size_t after = i + word.size();
    return after == line.size() || std::isspace(static_cast<unsigned char>(line[after])) != 0;
}

// The file name only: the full path holds the Windows user name, and people paste
// this text to whoever helps them.
std::string ExeName(const std::string& exe) {
    const std::size_t slash = exe.find_last_of("\\/");
    return slash == std::string::npos ? exe : exe.substr(slash + 1);
}

std::string FailText(const std::string& exe, const std::vector<std::string>& args, const RunResult& r) {
    std::string text = ExeName(exe) + " " + Join(args) + "\n";
    if (!r.started) {
        text += "could not start";
    } else if (r.timedOut) {
        text += "timed out";
    } else {
        text += "exit " + std::to_string(r.exitCode);
    }
    if (!r.output.empty()) {
        // Keep the end: that is where a CLI writes why it stopped.
        std::string tail = r.output;
        if (tail.size() > kMaxFailBytes) {
            std::size_t cut = tail.size() - kMaxFailBytes;
            while (cut < tail.size() && (static_cast<unsigned char>(tail[cut]) & 0xC0) == 0x80) ++cut;
            tail = tail.substr(cut);
        }
        text += "\n" + tail;
    }
    return text;
}

std::string EncodeBreaks(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) {
        const char c = s[i];
        if (c == '\r') continue;
        out += (c == '\n') ? '|' : c;
    }
    return out;
}

}  // namespace

bool AllowedFromMenu(const CallContext& ctx, std::string& why) {
    if (!ctx.valid) {
        why = "no call context";
        return false;
    }
    if (!ctx.server.empty()) {
        why = "called on server " + ctx.server;
        return false;
    }
    if (!ctx.remoteOwner.empty() && ctx.remoteOwner != "0") {
        why = "remote executed by " + ctx.remoteOwner;
        return false;
    }
    if (!ctx.mission.empty()) {
        why = "called in mission " + ctx.mission;
        return false;
    }
    // Our functions are the only ones allowed to call these commands. The engine
    // reports them as /ahc/addons/arma_mcp/functions/fn_connectX.sqf.
    std::string file = ToLower(ctx.file);
    std::replace(file.begin(), file.end(), '\\', '/');
    if (!file.empty() && file.front() == '/') file.erase(0, 1);
    if (file.rfind("ahc/addons/arma_mcp/functions/fn_connect", 0) != 0) {
        why = "called from " + ctx.file;
        return false;
    }
    why.clear();
    return true;
}

bool ClaudeHasPlugin(const std::string& listJson) {
    std::vector<std::size_t> ids;
    for (std::size_t at = FindKeyValue(listJson, "id", 0); at != std::string::npos;
         at = FindKeyValue(listJson, "id", at)) {
        ids.push_back(at);
    }
    for (std::size_t i = 0; i < ids.size(); ++i) {
        if (!ValueIs(listJson, ids[i], kPluginId)) continue;
        const std::size_t limit = i + 1 < ids.size() ? ids[i + 1] : std::string::npos;
        const std::size_t enabled = FindKeyValue(listJson, "enabled", ids[i]);
        if (enabled != std::string::npos && enabled < limit && listJson.compare(enabled, 4, "true") == 0) {
            return true;
        }
    }
    return false;
}

bool ClaudeHasMarketplace(const std::string& listJson) {
    std::size_t at = 0;
    while ((at = FindKeyValue(listJson, "name", at)) != std::string::npos) {
        if (ValueIs(listJson, at, kMarketplaceName)) return true;
        ++at;
    }
    return false;
}

bool CodexHasPlugin(const std::string& listText) {
    for (const std::string& line : SplitLines(listText)) {
        if (FirstWordIs(line, kPluginId) && line.find("installed, enabled") != std::string::npos &&
            line.find("not installed") == std::string::npos) {
            return true;
        }
    }
    return false;
}

bool CodexHasMarketplace(const std::string& listText) {
    for (const std::string& line : SplitLines(listText)) {
        if (FirstWordIs(line, kMarketplaceName)) return true;
    }
    return false;
}

std::string StripAnsi(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (std::size_t i = 0; i < s.size(); ++i) {
        if (s[i] == 0x1B && i + 1 < s.size() && s[i + 1] == '[') {
            i += 2;
            while (i < s.size() && (s[i] < 0x40 || s[i] > 0x7E)) ++i;
            continue;
        }
        out += s[i];
    }
    return out;
}

Connector::Connector(Platform& platform) : platform_(platform) {
    for (const HostSpec& spec : Hosts()) {
        HostState state;
        state.id = spec.id;
        hosts_.push_back(state);
    }
}

bool Connector::Begin(const char* phase) {
    bool expected = false;
    if (!busy_.compare_exchange_strong(expected, true)) return false;
    std::lock_guard<std::mutex> lock(mtx_);
    phase_ = phase;
    return true;
}

void Connector::Finish() {
    {
        std::lock_guard<std::mutex> lock(mtx_);
        phase_ = "ready";
    }
    busy_.store(false);
}

bool Connector::Probe() {
    if (!Begin("probing")) return false;
    std::thread([this]() {
        DoProbe();
        Finish();
    }).detach();
    return true;
}

bool Connector::Connect(const std::vector<std::string>& hostIds) {
    if (!Begin("working")) return false;
    std::thread([this, hostIds]() {
        DoConnect(hostIds);
        Finish();
    }).detach();
    return true;
}

bool Connector::Remove(const std::string& hostId) {
    if (!Begin("working")) return false;
    std::thread([this, hostId]() {
        DoRemove(hostId);
        Finish();
    }).detach();
    return true;
}

RunResult Connector::RunLogged(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs) {
    RunResult r = platform_.Run(exe, args, timeoutMs);
    platform_.Log(exe + " " + Join(args) + " -> " +
                  (r.started ? (r.timedOut ? std::string("timeout") : "exit " + std::to_string(r.exitCode))
                             : std::string("not started")));
    return r;
}

void Connector::SetActivity(std::size_t index, const char* activity, int percent) {
    std::lock_guard<std::mutex> lock(mtx_);
    hosts_[index].activity = activity;
    hosts_[index].percent = percent;
}

void Connector::Fail(std::size_t index, const std::string& text) {
    platform_.Log("failed " + hosts_[index].id + ": " + text);
    std::lock_guard<std::mutex> lock(mtx_);
    hosts_[index].activity.clear();
    hosts_[index].percent = 0;
    hosts_[index].failed = true;
    hosts_[index].failText = text;
}

void Connector::DoProbe() {
    platform_.ReportModPath();
    const std::vector<std::string> nodeDirs = {R"(%APPDATA%\fnm\aliases\default)"};
    const bool node = !platform_.FindExe("node", nodeDirs).empty();
    const bool git = !platform_.FindExe("git", {}).empty();
    {
        std::lock_guard<std::mutex> lock(mtx_);
        nodeFound_ = node;
        gitFound_ = git;
    }
    const std::vector<HostSpec>& specs = Hosts();
    for (std::size_t i = 0; i < specs.size(); ++i) {
        const std::string exe = platform_.FindExe(specs[i].exe, specs[i].extraDirs);
        bool connected = false;
        if (!exe.empty()) {
            const RunResult r = RunLogged(exe, specs[i].listArgs, kListTimeoutMs);
            connected = r.started && !r.timedOut && r.exitCode == 0 && specs[i].hasPlugin(r.output);
        }
        std::lock_guard<std::mutex> lock(mtx_);
        hosts_[i].exe = exe;
        hosts_[i].found = !exe.empty();
        hosts_[i].connected = connected;
        hosts_[i].activity.clear();
        hosts_[i].percent = 0;
        hosts_[i].failed = false;
        hosts_[i].failText.clear();
    }
}

void Connector::ConnectOne(std::size_t index, const std::string& exe) {
    const HostSpec& spec = Hosts()[index];

    SetActivity(index, "marketplace", 20);
    const RunResult market = RunLogged(exe, spec.marketListArgs, kListTimeoutMs);
    if (!market.started || market.timedOut || market.exitCode != 0) {
        Fail(index, FailText(exe, spec.marketListArgs, market));
        return;
    }
    // A registration that already exists stays as it is, wherever it points.
    if (!spec.hasMarket(market.output)) {
        const RunResult add = RunLogged(exe, spec.marketAddArgs, kInstallTimeoutMs);
        if (!add.started || add.timedOut || add.exitCode != 0) {
            Fail(index, FailText(exe, spec.marketAddArgs, add));
            return;
        }
    }

    SetActivity(index, "install", 60);
    const RunResult install = RunLogged(exe, spec.installArgs, kInstallTimeoutMs);
    if (!install.started || install.timedOut || install.exitCode != 0) {
        Fail(index, FailText(exe, spec.installArgs, install));
        return;
    }

    SetActivity(index, "verify", 90);
    const RunResult list = RunLogged(exe, spec.listArgs, kListTimeoutMs);
    if (!list.started || list.timedOut || list.exitCode != 0 || !spec.hasPlugin(list.output)) {
        Fail(index, FailText(exe, spec.listArgs, list));
        return;
    }

    std::lock_guard<std::mutex> lock(mtx_);
    hosts_[index].connected = true;
    hosts_[index].activity.clear();
    hosts_[index].percent = 0;
}

void Connector::DoConnect(const std::vector<std::string>& hostIds) {
    platform_.ReportModPath();
    const std::vector<HostSpec>& specs = Hosts();
    for (std::size_t i = 0; i < specs.size(); ++i) {
        if (std::find(hostIds.begin(), hostIds.end(), specs[i].id) == hostIds.end()) continue;
        std::string exe;
        {
            std::lock_guard<std::mutex> lock(mtx_);
            hosts_[i].failed = false;
            hosts_[i].failText.clear();
            exe = hosts_[i].exe;
        }
        if (exe.empty()) continue;
        ConnectOne(i, exe);
    }
}

void Connector::DoRemove(const std::string& hostId) {
    const std::vector<HostSpec>& specs = Hosts();
    for (std::size_t i = 0; i < specs.size(); ++i) {
        if (hostId != specs[i].id) continue;
        std::string exe;
        {
            std::lock_guard<std::mutex> lock(mtx_);
            hosts_[i].failed = false;
            hosts_[i].failText.clear();
            exe = hosts_[i].exe;
        }
        if (exe.empty()) return;

        SetActivity(i, "remove", 50);
        const RunResult remove = RunLogged(exe, specs[i].removeArgs, kInstallTimeoutMs);
        const RunResult list = RunLogged(exe, specs[i].listArgs, kListTimeoutMs);
        const bool still = !list.started || list.timedOut || list.exitCode != 0 || specs[i].hasPlugin(list.output);
        if (still) {
            Fail(i, FailText(exe, specs[i].removeArgs, remove));
            return;
        }
        std::lock_guard<std::mutex> lock(mtx_);
        hosts_[i].connected = false;
        hosts_[i].activity.clear();
        hosts_[i].percent = 0;
        return;
    }
}

std::string Connector::StateArray() const {
    std::lock_guard<std::mutex> lock(mtx_);
    std::vector<std::string> fields = {phase_, nodeFound_ ? "1" : "0", gitFound_ ? "1" : "0"};
    for (const HostState& h : hosts_) {
        fields.push_back(h.id);
        fields.push_back(h.found ? "1" : "0");
        fields.push_back(h.connected ? "1" : "0");
        fields.push_back(h.activity);
        fields.push_back(std::to_string(h.percent));
        fields.push_back(h.failed ? "1" : "0");
        fields.push_back(EncodeBreaks(h.failText));
    }
    return BuildSafeArray(fields);
}

#if defined(_WIN32)

namespace {

std::wstring Widen(const std::string& s) {
    if (s.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    if (need <= 0) return {};
    std::wstring w(static_cast<std::size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), w.data(), need);
    return w;
}

std::string Narrow(const std::wstring& w, UINT codePage = CP_UTF8) {
    if (w.empty()) return {};
    const int need = WideCharToMultiByte(codePage, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    if (need <= 0) return {};
    std::string s(static_cast<std::size_t>(need), '\0');
    WideCharToMultiByte(codePage, 0, w.data(), static_cast<int>(w.size()), s.data(), need, nullptr, nullptr);
    return s;
}

// cmd.exe errors arrive in the ANSI code page, not UTF-8.
std::string ToUtf8(const std::string& raw) {
    if (utf8::IsValid(raw)) return raw;
    const int need = MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(raw.size()), nullptr, 0);
    if (need <= 0) return {};
    std::wstring w(static_cast<std::size_t>(need), L'\0');
    MultiByteToWideChar(CP_ACP, 0, raw.data(), static_cast<int>(raw.size()), w.data(), need);
    return Narrow(w);
}

std::wstring ExpandEnv(const std::wstring& s) {
    const DWORD need = ExpandEnvironmentStringsW(s.c_str(), nullptr, 0);
    if (need == 0) return s;
    std::wstring out(need, L'\0');
    const DWORD got = ExpandEnvironmentStringsW(s.c_str(), out.data(), need);
    if (got == 0 || got > need) return s;
    out.resize(got - 1);
    return out;
}

std::wstring ReadRegistryPath(HKEY root, const wchar_t* key) {
    DWORD bytes = 0;
    if (RegGetValueW(root, key, L"Path", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, nullptr, nullptr,
                     &bytes) != ERROR_SUCCESS || bytes == 0) {
        return {};
    }
    std::wstring value(bytes / sizeof(wchar_t), L'\0');
    if (RegGetValueW(root, key, L"Path", RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND, nullptr, value.data(),
                     &bytes) != ERROR_SUCCESS) {
        return {};
    }
    value.resize(wcsnlen(value.c_str(), value.size()));
    return ExpandEnv(value);
}

std::wstring CurrentEnvPath() {
    const DWORD need = GetEnvironmentVariableW(L"Path", nullptr, 0);
    if (need == 0) return {};
    std::wstring value(need, L'\0');
    const DWORD got = GetEnvironmentVariableW(L"Path", value.data(), need);
    value.resize(got);
    return value;
}

// The game inherits Steam's environment, which can predate an install. Adding the
// registry values finds what was installed after Steam started.
std::wstring MergedPath() {
    std::vector<std::wstring> seen;
    std::wstring out;
    const std::wstring parts[] = {
        CurrentEnvPath(),
        ReadRegistryPath(HKEY_CURRENT_USER, L"Environment"),
        ReadRegistryPath(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
    };
    for (const std::wstring& part : parts) {
        std::size_t start = 0;
        while (start <= part.size()) {
            std::size_t end = part.find(L';', start);
            if (end == std::wstring::npos) end = part.size();
            std::wstring dir = part.substr(start, end - start);
            start = end + 1;
            if (dir.empty()) continue;
            std::wstring key = dir;
            CharLowerBuffW(key.data(), static_cast<DWORD>(key.size()));
            if (std::find(seen.begin(), seen.end(), key) != seen.end()) continue;
            seen.push_back(key);
            if (!out.empty()) out += L';';
            out += dir;
        }
    }
    return out;
}

bool IsFile(const std::wstring& path) {
    const DWORD attrs = GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring FindInDir(const std::wstring& dir, const std::wstring& name) {
    for (const wchar_t* ext : {L".exe", L".cmd", L".bat"}) {
        std::wstring path = dir;
        if (!path.empty() && path.back() != L'\\' && path.back() != L'/') path += L'\\';
        path += name;
        path += ext;
        if (IsFile(path)) return path;
    }
    return {};
}

// A copy of this process's environment with Path replaced.
std::wstring EnvBlockWithPath(const std::wstring& path) {
    std::wstring block;
    LPWCH env = GetEnvironmentStringsW();
    if (env != nullptr) {
        for (const wchar_t* p = env; *p != L'\0'; p += wcslen(p) + 1) {
            if (_wcsnicmp(p, L"Path=", 5) == 0) continue;
            block += p;
            block += L'\0';
        }
        FreeEnvironmentStringsW(env);
    }
    block += L"Path=" + path;
    block += L'\0';
    // Nobody can answer a Git login prompt from here, and it would wait until the
    // timeout. Failing at once shows the reason in the window instead.
    block += L"GIT_TERMINAL_PROMPT=0";
    block += L'\0';
    block += L"GCM_INTERACTIVE=never";
    block += L'\0';
    block += L'\0';
    return block;
}

bool EndsWithCi(const std::wstring& s, const wchar_t* suffix) {
    const std::size_t n = wcslen(suffix);
    return s.size() >= n && _wcsicmp(s.c_str() + (s.size() - n), suffix) == 0;
}

// CLI output is shown and copied for whoever helps, and paths in it hold the Windows
// user name.
std::string MaskUserProfile(std::string text) {
    const std::string profile = Narrow(ExpandEnv(L"%USERPROFILE%"));
    if (profile.empty() || profile.find('%') != std::string::npos) return text;
    const std::string mask = "%USERPROFILE%";
    for (std::size_t at = text.find(profile); at != std::string::npos; at = text.find(profile, at + mask.size())) {
        text.replace(at, profile.size(), mask);
    }
    return text;
}

RunResult RunProcess(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs) {
    RunResult result;

    SECURITY_ATTRIBUTES inherit{};
    inherit.nLength = sizeof(inherit);
    inherit.bInheritHandle = TRUE;
    HANDLE readPipe = nullptr;
    HANDLE writePipe = nullptr;
    if (!CreatePipe(&readPipe, &writePipe, &inherit, 0)) return result;
    SetHandleInformation(readPipe, HANDLE_FLAG_INHERIT, 0);
    // A prompt must fail, not wait: nobody can answer it.
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr);

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul;
    si.hStdOutput = writePipe;
    si.hStdError = writePipe;

    const std::wstring wexe = Widen(exe);
    std::wstring tail;
    for (const std::string& a : args) {
        tail += L' ';
        tail += L'"';
        tail += Widen(a);
        tail += L'"';
    }

    std::wstring app;
    std::wstring cmd;
    if (EndsWithCi(wexe, L".cmd") || EndsWithCi(wexe, L".bat")) {
        wchar_t comspec[MAX_PATH] = {};
        const DWORD n = GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH);
        app = (n > 0 && n < MAX_PATH) ? comspec : L"C:\\Windows\\System32\\cmd.exe";
        cmd = L"\"" + app + L"\" /d /s /c \"\"" + wexe + L"\"" + tail + L"\"";
    } else {
        app = wexe;
        cmd = L"\"" + wexe + L"\"" + tail;
    }

    std::wstring env = EnvBlockWithPath(MergedPath());
    PROCESS_INFORMATION pi{};
    const BOOL created = CreateProcessW(app.c_str(), cmd.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, env.data(),
                                        nullptr, &si, &pi);
    CloseHandle(writePipe);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    if (!created) {
        CloseHandle(readPipe);
        return result;
    }

    // The job exists so a timeout also stops what the CLI started. It has no
    // kill-on-close: closing the game does not cut an install short.
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job != nullptr) AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);
    result.started = true;

    std::string raw;
    const auto drain = [&]() {
        char buffer[4096];
        DWORD available = 0;
        while (PeekNamedPipe(readPipe, nullptr, 0, nullptr, &available, nullptr) && available > 0) {
            DWORD got = 0;
            if (!ReadFile(readPipe, buffer, sizeof(buffer), &got, nullptr) || got == 0) break;
            raw.append(buffer, got);
            if (raw.size() > kMaxOutputBytes) raw.erase(0, raw.size() - kMaxOutputBytes);
        }
    };

    const ULONGLONG deadline = GetTickCount64() + timeoutMs;
    for (;;) {
        drain();
        const DWORD wait = WaitForSingleObject(pi.hProcess, 30);
        if (wait == WAIT_OBJECT_0) break;
        if (GetTickCount64() >= deadline) {
            result.timedOut = true;
            if (job != nullptr) TerminateJobObject(job, 1);
            TerminateProcess(pi.hProcess, 1);
            WaitForSingleObject(pi.hProcess, 2000);
            break;
        }
    }
    drain();

    DWORD exitCode = 1;
    GetExitCodeProcess(pi.hProcess, &exitCode);
    result.exitCode = static_cast<int>(exitCode);
    result.output = MaskUserProfile(StripAnsi(ToUtf8(raw)));

    if (job != nullptr) CloseHandle(job);
    CloseHandle(pi.hProcess);
    CloseHandle(readPipe);
    return result;
}

std::wstring LocalAppDataDir() {
    return ExpandEnv(L"%LOCALAPPDATA%\\Arma-MCP");
}

class WindowsPlatform final : public Platform {
public:
    std::string FindExe(const std::string& name, const std::vector<std::string>& extraDirs) override {
        // Lets a test see the "not installed" screens on a PC that has everything.
        wchar_t hide[256] = {};
        if (GetEnvironmentVariableW(L"ARMA_MCP_CONNECT_HIDE", hide, 256) > 0 &&
            ("," + Narrow(hide) + ",").find("," + name + ",") != std::string::npos) {
            return {};
        }
        const std::wstring wname = Widen(name);
        const std::wstring path = MergedPath();
        std::size_t start = 0;
        while (start <= path.size()) {
            std::size_t end = path.find(L';', start);
            if (end == std::wstring::npos) end = path.size();
            const std::wstring dir = path.substr(start, end - start);
            start = end + 1;
            if (dir.empty()) continue;
            const std::wstring found = FindInDir(dir, wname);
            if (!found.empty()) return Narrow(found);
        }
        for (const std::string& extra : extraDirs) {
            const std::wstring found = FindInDir(ExpandEnv(Widen(extra)), wname);
            if (!found.empty()) return Narrow(found);
        }
        return {};
    }

    RunResult Run(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs) override {
        return RunProcess(exe, args, timeoutMs);
    }

    // Tells the daemon where this mod lives, so arma.selfModPath can stay empty.
    // A game the daemon launched already has a known mod, and its path can be a
    // temporary stack overlay, so that game does not report.
    void ReportModPath() override {
        if (GetEnvironmentVariableW(L"ARMA_MCP_GAME_PIPE", nullptr, 0) > 0) return;

        HMODULE self = nullptr;
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                                reinterpret_cast<LPCWSTR>(&LocalAppDataDir), &self)) {
            return;
        }
        wchar_t modulePath[MAX_PATH * 2] = {};
        const DWORD n = GetModuleFileNameW(self, modulePath, MAX_PATH * 2);
        if (n == 0 || n >= MAX_PATH * 2) return;
        std::wstring modRoot(modulePath, n);
        const std::size_t slash = modRoot.find_last_of(L"\\/");
        if (slash == std::wstring::npos) return;
        modRoot.resize(slash);

        const json::Object body{{"modPath", Narrow(modRoot)}};
        const std::string text = json::Serialize(body);

        const std::wstring dir = LocalAppDataDir();
        CreateDirectoryW(dir.c_str(), nullptr);
        const std::wstring file = dir + L"\\bridge-mod.json";
        const std::wstring temp = file + L".tmp";
        HANDLE h = CreateFileW(temp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return;
        DWORD written = 0;
        const BOOL ok = WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
        CloseHandle(h);
        if (ok && written == text.size()) {
            MoveFileExW(temp.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING);
        } else {
            DeleteFileW(temp.c_str());
        }
    }

    void Log(const std::string& line) override {
        const std::wstring dir = LocalAppDataDir();
        CreateDirectoryW(dir.c_str(), nullptr);
        const std::wstring file = dir + L"\\connect.log";

        WIN32_FILE_ATTRIBUTE_DATA info{};
        const bool big = GetFileAttributesExW(file.c_str(), GetFileExInfoStandard, &info) &&
                         (info.nFileSizeHigh != 0 || info.nFileSizeLow > 256 * 1024);
        HANDLE h = CreateFileW(file.c_str(), big ? GENERIC_WRITE : FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                               big ? CREATE_ALWAYS : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return;

        SYSTEMTIME t{};
        GetLocalTime(&t);
        char stamp[32];
        const int stampLen = wsprintfA(stamp, "%04d-%02d-%02d %02d:%02d:%02d ", t.wYear, t.wMonth, t.wDay, t.wHour,
                                       t.wMinute, t.wSecond);
        std::string text(stamp, static_cast<std::size_t>(stampLen));
        text += line;
        text += "\r\n";
        DWORD written = 0;
        WriteFile(h, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
        CloseHandle(h);
    }
};

}  // namespace

namespace {
WindowsPlatform& ThePlatform() {
    static WindowsPlatform* platform = new WindowsPlatform();
    return *platform;
}
}  // namespace

Connector& Instance() {
    static Connector* connector = new Connector(ThePlatform());
    return *connector;
}

void LogLine(const std::string& line) {
    ThePlatform().Log(line);
}

void CopyTextAsync(const std::string& text) {
    std::thread([text]() {
        const std::wstring wide = Widen(text);
        if (!OpenClipboard(nullptr)) return;
        EmptyClipboard();
        const std::size_t bytes = (wide.size() + 1) * sizeof(wchar_t);
        HGLOBAL mem = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if (mem != nullptr) {
            void* dst = GlobalLock(mem);
            if (dst != nullptr) {
                memcpy(dst, wide.c_str(), bytes);
                GlobalUnlock(mem);
                if (SetClipboardData(CF_UNICODETEXT, mem) == nullptr) GlobalFree(mem);
            } else {
                GlobalFree(mem);
            }
        }
        CloseClipboard();
    }).detach();
}

RunResult RunProcessForTest(const std::string& exe, const std::vector<std::string>& args, unsigned timeoutMs) {
    return RunProcess(exe, args, timeoutMs);
}

#else  // !_WIN32

namespace {

class NullPlatform final : public Platform {
public:
    std::string FindExe(const std::string&, const std::vector<std::string>&) override { return {}; }
    RunResult Run(const std::string&, const std::vector<std::string>&, unsigned) override { return {}; }
    void ReportModPath() override {}
    void Log(const std::string&) override {}
};

}  // namespace

Connector& Instance() {
    static NullPlatform* platform = new NullPlatform();
    static Connector* connector = new Connector(*platform);
    return *connector;
}

void LogLine(const std::string&) {}

void CopyTextAsync(const std::string&) {}

RunResult RunProcessForTest(const std::string&, const std::vector<std::string>&, unsigned) {
    return {};
}

#endif

}  // namespace ahc::connect
