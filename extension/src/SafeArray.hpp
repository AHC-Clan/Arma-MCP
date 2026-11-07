// SafeArray.hpp — builds a parseSimpleArray-safe SQF array literal.
//
// Inbound (server->game) data is delivered to SQF as the third argument of the
// "ExtensionCallback" mission event handler, where SQF runs `parseSimpleArray`
// on it. parseSimpleArray is DATA-ONLY (it never compiles/executes), so the
// worst a hostile payload can do is break the array's syntax. This builder
// guarantees the emitted literal always parses.
//
// Output shape (a flat array of strings):
//   ["reqId","server","","1+1","label with ""quotes"" and , commas"]
//
// SQF string-literal rules honored:
//   - fields are wrapped in double quotes
//   - an embedded double quote is doubled ("" — NOT backslash-escaped)
//   - control characters (CR/LF/TAB) are replaced with a single space

#pragma once

#include <initializer_list>
#include <string>
#include <vector>

namespace ahc {

std::string BuildSafeArray(const std::vector<std::string>& fields);
std::string BuildSafeArray(std::initializer_list<std::string> fields);
std::string EscapeField(const std::string& field);

} // namespace ahc
