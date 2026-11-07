// test_safearray.cpp — adversarial escaping for the parseSimpleArray inbound path.
//
// The threat: a hostile payload must not break out of the SQF array literal.
// We assert the output is well-formed and structural characters stay contained
// inside quoted strings. (SQF code is DATA here — parseSimpleArray never runs it.)
#include "../src/SafeArray.hpp"
#include "../src/Utf8.hpp"

#include <cstdio>
#include <string>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

static int ValidateFlatStringArray(const std::string& s) {
    std::size_t i = 0;
    auto skipws = [&] { while (i < s.size() && (s[i] == ' ' || s[i] == '\t')) ++i; };
    skipws();
    if (i >= s.size() || s[i] != '[') return -1;
    ++i; skipws();
    int fields = 0;
    if (i < s.size() && s[i] == ']') return 0;
    for (;;) {
        skipws();
        if (i >= s.size() || s[i] != '"') return -1;
        ++i;
        for (;;) {
            if (i >= s.size()) return -1;
            if (s[i] == '"') {
                if (i + 1 < s.size() && s[i + 1] == '"') { i += 2; continue; }
                ++i; break;
            }
            ++i;
        }
        ++fields;
        skipws();
        if (i < s.size() && s[i] == ',') { ++i; continue; }
        if (i < s.size() && s[i] == ']') { ++i; return fields; }
        return -1;
    }
}

int main() {
    // Benign exec payload: [reqId, mode, target, code, label]
    {
        const std::string a = BuildSafeArray({"abc123", "server", "", "1+1", "agent"});
        CHECK(ValidateFlatStringArray(a) == 5);
    }
    // Korean in code/label preserved and valid UTF-8.
    {
        const std::string a = BuildSafeArray({"id", "server", "", u8"systemChat \"안녕\"", u8"라벨"});
        CHECK(ValidateFlatStringArray(a) == 5);
        CHECK(utf8::IsValid(a));
    }
    // Adversarial code with quotes, brackets, commas — no break-out.
    {
        const std::string nasty = R"(code "q" and , comma and ] bracket and ["nested"])";
        const std::string a = BuildSafeArray({"id", "server", "", nasty, "l"});
        CHECK(ValidateFlatStringArray(a) == 5);
    }
    // Attempt to inject a 6th field.
    {
        const std::string inject = R"(","INJECTED","x)";
        const std::string a = BuildSafeArray({"id", "server", "", inject, "l"});
        CHECK(ValidateFlatStringArray(a) == 5);
    }
    // Control chars neutralized (no raw newline survives — parseSimpleArray chokes on them).
    {
        const std::string a = BuildSafeArray({"id", "server", "", "line1\nline2\r\ttab", "l"});
        CHECK(ValidateFlatStringArray(a) == 5);
        CHECK(a.find('\n') == std::string::npos);
        CHECK(a.find('\r') == std::string::npos);
        CHECK(a.find('\t') == std::string::npos);
    }
    // EscapeField doubles quotes (not backslash).
    {
        CHECK(EscapeField(R"(a"b)") == R"(a""b)");
        CHECK(EscapeField("plain") == "plain");
    }

    if (g_failures == 0) std::printf("test_safearray: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
