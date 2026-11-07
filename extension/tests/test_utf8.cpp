// test_utf8.cpp — validates the UTF-8 byte contract (Korean + emoji round-trip).
#include "../src/Utf8.hpp"

#include <cstdio>
#include <string>

using namespace ahc;

static int g_failures = 0;
#define CHECK(cond) do { if (!(cond)) { std::printf("FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failures; } } while (0)

int main() {
    const std::string korean = u8"한글닉네임";
    const std::string emoji = u8"안녕 👋🎮";
    CHECK(utf8::IsValid(korean));
    CHECK(utf8::IsValid(emoji));
    CHECK(utf8::IsValid(u8"mixed 한국어 and English 123"));
    CHECK(utf8::IsValid(""));

    CHECK(utf8::CountCodePoints(korean) == 5);
    CHECK(utf8::CountCodePoints(u8"ab") == 2);

    CHECK(!utf8::IsValid(std::string("\xC0\xAF")));      // overlong '/'
    CHECK(!utf8::IsValid(std::string("\xED\xA0\x80")));  // surrogate U+D800
    CHECK(!utf8::IsValid(std::string("\xFF")));          // invalid lead
    CHECK(!utf8::IsValid(std::string("\xE0\x80")));      // truncated 3-byte

    const std::string han = u8"한글";
    CHECK(utf8::TruncateOnBoundary(han, 2).empty());
    CHECK(utf8::TruncateOnBoundary(han, 3) == u8"한");
    CHECK(utf8::TruncateOnBoundary(han, 6) == han);
    CHECK(utf8::TruncateOnBoundary(han, 100) == han);
    CHECK(utf8::IsValid(utf8::TruncateOnBoundary(emoji, 9)));

    if (g_failures == 0) std::printf("test_utf8: ALL PASS\n");
    return g_failures == 0 ? 0 : 1;
}
