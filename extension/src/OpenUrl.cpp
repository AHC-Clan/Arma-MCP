#include "OpenUrl.hpp"

#include <cctype>
#include <thread>

#if defined(_WIN32)
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#  include <shellapi.h>
#endif

namespace ahc {

namespace {

bool HasPrefixCi(const std::string& s, const char* prefix) {
    std::size_t i = 0;
    for (; prefix[i] != '\0'; ++i) {
        if (i >= s.size()) return false;
        const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(s[i])));
        if (a != prefix[i]) return false;
    }
    return true;
}

} // namespace

bool IsSafeHttpUrl(const std::string& url) {
    if (url.size() > 2048) return false;
    if (!HasPrefixCi(url, "http://") && !HasPrefixCi(url, "https://")) return false;
    for (const char c : url) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u <= 0x20 || u == 0x7F) return false; // control chars + space
        if (c == '"' || c == '\\') return false;
    }
    return true;
}

void OpenUrlAsync(const std::string& url) {
#if defined(_WIN32)
    std::thread([url]() {
        const int need =
            MultiByteToWideChar(CP_UTF8, 0, url.c_str(), static_cast<int>(url.size()), nullptr, 0);
        if (need <= 0) return;
        std::wstring w(static_cast<std::size_t>(need), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, url.c_str(), static_cast<int>(url.size()), w.data(), need);
        ShellExecuteW(nullptr, L"open", w.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    }).detach();
#else
    (void)url;
#endif
}

} // namespace ahc
