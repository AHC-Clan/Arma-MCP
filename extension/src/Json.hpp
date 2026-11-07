// Json.hpp — minimal, dependency-free JSON for the IPC frames.
//
// We only ever emit/consume small flat objects whose values are strings or
// integers. So this is intentionally tiny: a string-keyed map with string
// values, plus an escaping serializer and a tolerant parser. Nested
// objects/arrays are not parsed (the SQF-built telemetry body is forwarded as an
// opaque inner-JSON string via WrapBody, never parsed by the DLL).
//
// All string values are opaque UTF-8 (escaping operates on bytes < 0x20 and the
// two structural chars \ and "; UTF-8 multibyte bytes are >= 0x80 and pass
// through untouched, preserving Korean text).

#pragma once

#include <map>
#include <string>

namespace ahc::json {

using Object = std::map<std::string, std::string>;

std::string Serialize(const Object& obj);
bool Parse(const std::string& text, Object& out);
std::string EscapeString(const std::string& s);

} // namespace ahc::json
