// Utf8.hpp — UTF-8 handling contract.
//
// THE CONTRACT (load-bearing for Korean text):
//   Arma 3 hands SQF strings to the extension as UTF-8 `char*`, and reads the
//   output buffer back as UTF-8. Therefore every string in this DLL is treated
//   as an OPAQUE sequence of UTF-8 bytes held in std::string. We never convert
//   to wchar_t/UTF-16, never touch the Windows ANSI code page, and never call a
//   locale-dependent CRT function on message bytes. Bytes in == bytes out.

#pragma once

#include <string>

namespace ahc::utf8 {

bool IsValid(const std::string& s);
std::string TruncateOnBoundary(const std::string& s, std::size_t maxBytes);
std::size_t CountCodePoints(const std::string& s);

} // namespace ahc::utf8
