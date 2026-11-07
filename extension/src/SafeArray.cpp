#include "SafeArray.hpp"

namespace ahc {

std::string EscapeField(const std::string& field) {
    std::string out;
    out.reserve(field.size() + 8);
    for (char ch : field) {
        switch (ch) {
            case '"':
                out += "\"\"";   // SQF: a literal double quote is written as ""
                break;
            case '\r':
            case '\n':
            case '\t':
                out += ' ';      // parseSimpleArray chokes on raw control chars
                break;
            default:
                out += ch;       // all other bytes (incl. UTF-8 multibyte) pass through
                break;
        }
    }
    return out;
}

std::string BuildSafeArray(const std::vector<std::string>& fields) {
    std::string out = "[";
    for (std::size_t i = 0; i < fields.size(); ++i) {
        if (i != 0) out += ',';
        out += '"';
        out += EscapeField(fields[i]);
        out += '"';
    }
    out += ']';
    return out;
}

std::string BuildSafeArray(std::initializer_list<std::string> fields) {
    return BuildSafeArray(std::vector<std::string>(fields));
}

} // namespace ahc
