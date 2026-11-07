#include "Utf8.hpp"

#include <cstdint>

namespace ahc::utf8 {

namespace {

bool DecodeOne(const std::string& s, std::size_t& i, std::uint32_t& cp) {
    const std::size_t n = s.size();
    const auto b0 = static_cast<unsigned char>(s[i]);

    if (b0 < 0x80) {
        cp = b0;
        i += 1;
        return true;
    }

    int len;
    std::uint32_t min;
    if ((b0 & 0xE0) == 0xC0) { len = 2; cp = b0 & 0x1F; min = 0x80; }
    else if ((b0 & 0xF0) == 0xE0) { len = 3; cp = b0 & 0x0F; min = 0x800; }
    else if ((b0 & 0xF8) == 0xF0) { len = 4; cp = b0 & 0x07; min = 0x10000; }
    else return false;

    if (i + static_cast<std::size_t>(len) > n) return false;

    for (int k = 1; k < len; ++k) {
        const auto bk = static_cast<unsigned char>(s[i + k]);
        if ((bk & 0xC0) != 0x80) return false;
        cp = (cp << 6) | (bk & 0x3F);
    }

    if (cp < min) return false;
    if (cp > 0x10FFFF) return false;
    if (cp >= 0xD800 && cp <= 0xDFFF) return false;

    i += static_cast<std::size_t>(len);
    return true;
}

} // namespace

bool IsValid(const std::string& s) {
    std::size_t i = 0;
    const std::size_t n = s.size();
    while (i < n) {
        std::uint32_t cp;
        if (!DecodeOne(s, i, cp)) return false;
    }
    return true;
}

std::string TruncateOnBoundary(const std::string& s, std::size_t maxBytes) {
    if (s.size() <= maxBytes) return s;
    std::size_t cut = maxBytes;
    while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xC0) == 0x80) {
        --cut;
    }
    return s.substr(0, cut);
}

std::size_t CountCodePoints(const std::string& s) {
    std::size_t count = 0;
    for (unsigned char c : s) {
        if ((c & 0xC0) != 0x80) ++count;
    }
    return count;
}

} // namespace ahc::utf8
