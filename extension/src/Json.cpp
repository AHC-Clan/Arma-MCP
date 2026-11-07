#include "Json.hpp"

#include <cctype>
#include <cstdio>

namespace ahc::json {

std::string EscapeString(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    for (char c : s) {
        const auto uc = static_cast<unsigned char>(c);
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (uc < 0x20) {
                    char buf[7];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", uc);
                    out += buf;
                } else {
                    out += c;
                }
                break;
        }
    }
    return out;
}

std::string Serialize(const Object& obj) {
    std::string out = "{";
    bool first = true;
    for (const auto& [key, val] : obj) {
        if (!first) out += ',';
        first = false;
        out += '"';
        out += EscapeString(key);
        out += "\":\"";
        out += EscapeString(val);
        out += '"';
    }
    out += '}';
    return out;
}

namespace {

void SkipWs(const std::string& s, std::size_t& i) {
    while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
}

bool ParseString(const std::string& s, std::size_t& i, std::string& out) {
    if (i >= s.size() || s[i] != '"') return false;
    ++i;
    while (i < s.size()) {
        const char c = s[i++];
        if (c == '"') return true;
        if (c == '\\') {
            if (i >= s.size()) return false;
            const char e = s[i++];
            switch (e) {
                case '"':  out += '"';  break;
                case '\\': out += '\\'; break;
                case '/':  out += '/';  break;
                case 'b':  out += '\b'; break;
                case 'f':  out += '\f'; break;
                case 'n':  out += '\n'; break;
                case 'r':  out += '\r'; break;
                case 't':  out += '\t'; break;
                case 'u': {
                    if (i + 4 > s.size()) return false;
                    unsigned int cp = 0;
                    for (int k = 0; k < 4; ++k) {
                        const char h = s[i++];
                        cp <<= 4;
                        if (h >= '0' && h <= '9') cp |= static_cast<unsigned>(h - '0');
                        else if (h >= 'a' && h <= 'f') cp |= static_cast<unsigned>(h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') cp |= static_cast<unsigned>(h - 'A' + 10);
                        else return false;
                    }
                    if (cp < 0x80) {
                        out += static_cast<char>(cp);
                    } else if (cp < 0x800) {
                        out += static_cast<char>(0xC0 | (cp >> 6));
                        out += static_cast<char>(0x80 | (cp & 0x3F));
                    } else {
                        out += static_cast<char>(0xE0 | (cp >> 12));
                        out += static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
                        out += static_cast<char>(0x80 | (cp & 0x3F));
                    }
                    break;
                }
                default: return false;
            }
        } else {
            out += c;
        }
    }
    return false;
}

bool ParseScalar(const std::string& s, std::size_t& i, std::string& out) {
    const std::size_t start = i;
    while (i < s.size()) {
        const char c = s[i];
        if (c == ',' || c == '}' || c == ' ' || c == '\t' || c == '\n' || c == '\r') break;
        if (c == '{' || c == '[' || c == '"') return false;
        ++i;
    }
    if (i == start) return false;
    out = s.substr(start, i - start);
    return true;
}

} // namespace

bool Parse(const std::string& text, Object& out) {
    out.clear();
    std::size_t i = 0;
    SkipWs(text, i);
    if (i >= text.size() || text[i] != '{') return false;
    ++i;
    SkipWs(text, i);
    if (i < text.size() && text[i] == '}') return true;

    while (i < text.size()) {
        SkipWs(text, i);
        std::string key;
        if (!ParseString(text, i, key)) return false;
        SkipWs(text, i);
        if (i >= text.size() || text[i] != ':') return false;
        ++i;
        SkipWs(text, i);

        std::string val;
        if (i < text.size() && text[i] == '"') {
            if (!ParseString(text, i, val)) return false;
        } else {
            if (!ParseScalar(text, i, val)) return false;
        }
        out[key] = val;

        SkipWs(text, i);
        if (i >= text.size()) return false;
        if (text[i] == ',') { ++i; continue; }
        if (text[i] == '}') { ++i; return true; }
        return false;
    }
    return false;
}

} // namespace ahc::json
