// test_json.cpp — JSON round-trip (incl. UTF-8) and length-prefixed framing.
#include "../src/FrameCodec.hpp"
#include "../src/Json.hpp"
#include "../src/Utf8.hpp"

#include <cstdio>
#include <string>
#include <vector>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

int main() {
    // 1) Object serialize/parse round-trip with Korean + special chars.
    {
        json::Object o{
            {"type", "execResult"},
            {"machine", "server"},
            {"result", u8"STRING: \"한글 결과\""},
        };
        const std::string s = json::Serialize(o);
        CHECK(utf8::IsValid(s));

        json::Object back;
        CHECK(json::Parse(s, back));
        CHECK(back["type"] == "execResult");
        CHECK(back["machine"] == "server");
        CHECK(back["result"] == u8"STRING: \"한글 결과\"");
    }

    // 2) Parser tolerates a numeric "v" field (stored as text) and whitespace.
    {
        json::Object o;
        CHECK(json::Parse("{ \"v\": 1, \"type\": \"exec\" }", o));
        CHECK(o["v"] == "1");
        CHECK(o["type"] == "exec");
    }

    // 3) Malformed input is rejected, not crashed.
    {
        json::Object o;
        CHECK(!json::Parse("not json", o));
        CHECK(!json::Parse("{\"a\":}", o));
        CHECK(!json::Parse("{\"a\":\"unterminated}", o));
    }

    // 4) Frame encode + decode across arbitrary chunk splits.
    {
        const std::string p1 = json::Serialize({{"type", "a"}, {"text", u8"가나다"}});
        const std::string p2 = json::Serialize({{"type", "b"}, {"text", "second"}});
        const std::string stream = EncodeFrame(p1) + EncodeFrame(p2);

        std::vector<std::string> got;
        FrameDecoder dec;
        for (char c : stream) {
            const bool ok = dec.Feed(&c, 1, [&](const std::string& f) { got.push_back(f); });
            CHECK(ok);
        }
        CHECK(got.size() == 2);
        CHECK(got[0] == p1);
        CHECK(got[1] == p2);
    }

    // 5) Corrupt length prefix (too large) is rejected.
    {
        std::string bad;
        bad.push_back(static_cast<char>(0xFF));
        bad.push_back(static_cast<char>(0xFF));
        bad.push_back(static_cast<char>(0xFF));
        bad.push_back(static_cast<char>(0xFF));
        FrameDecoder dec;
        const bool ok = dec.Feed(bad.data(), bad.size(), [](const std::string&) {});
        CHECK(!ok);
    }

    if (g_failures == 0) std::printf("test_json: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
