// test_openurl.cpp — IsSafeHttpUrl accept/reject matrix.
#include "../src/OpenUrl.hpp"

#include <cstdio>
#include <string>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

int main() {
    // Accepted: plain http/https, case-insensitive scheme, ports, paths, query.
    CHECK(IsSafeHttpUrl("http://192.168.0.10:5302/"));
    CHECK(IsSafeHttpUrl("https://example.com/brief?rev=2"));
    CHECK(IsSafeHttpUrl("HTTP://192.168.0.10:5302/brief"));
    CHECK(IsSafeHttpUrl("HtTpS://example.com"));
    CHECK(IsSafeHttpUrl("http://a"));

    // Rejected: wrong/absent scheme.
    CHECK(!IsSafeHttpUrl(""));
    CHECK(!IsSafeHttpUrl("ftp://example.com"));
    CHECK(!IsSafeHttpUrl("file:///C:/Windows/System32/calc.exe"));
    CHECK(!IsSafeHttpUrl("javascript:alert(1)"));
    CHECK(!IsSafeHttpUrl("C:\\Windows\\System32\\calc.exe"));
    CHECK(!IsSafeHttpUrl("\\\\evil-host\\share\\payload.exe"));
    CHECK(!IsSafeHttpUrl("http:/example.com"));
    CHECK(!IsSafeHttpUrl("httpx://example.com"));

    // Rejected: embedded whitespace / control chars / quotes / backslashes.
    CHECK(!IsSafeHttpUrl("http://example.com/a b"));
    CHECK(!IsSafeHttpUrl("http://example.com/a\tb"));
    CHECK(!IsSafeHttpUrl("http://example.com/a\nb"));
    CHECK(!IsSafeHttpUrl("http://example.com/a\rb"));
    CHECK(!IsSafeHttpUrl(std::string("http://example.com/a\0b", 22)));
    CHECK(!IsSafeHttpUrl("http://example.com/\"quoted\""));
    CHECK(!IsSafeHttpUrl("http://example.com\\..\\x"));
    CHECK(!IsSafeHttpUrl("http://example.com/\x7F"));

    // Rejected: over the 2048-byte cap (scheme-valid but too long).
    {
        std::string longUrl = "http://example.com/";
        longUrl.append(2048, 'a');
        CHECK(!IsSafeHttpUrl(longUrl));
    }
    // Boundary: exactly 2048 bytes is allowed.
    {
        std::string edge = "http://e/";
        edge.append(2048 - edge.size(), 'a');
        CHECK(edge.size() == 2048);
        CHECK(IsSafeHttpUrl(edge));
    }

    if (g_failures == 0) std::printf("test_openurl: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
