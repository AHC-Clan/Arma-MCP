// OpenUrl.hpp — open a URL in the machine's default browser.
//
// Used by the "openUrl" extension command (arma_web_open / arma_web_publish):
// the game server broadcasts a URL via the exec path and every client machine
// opens it locally. Deliberately independent of Bridge/IPC — player machines
// have no MCP server, and the command must still work there.

#pragma once

#include <string>

namespace ahc {

// True iff the URL is safe to hand to the OS: http:// or https:// prefix
// (case-insensitive), <= 2048 bytes, and free of whitespace/control chars,
// double quotes and backslashes. Rejects file://, UNC paths, javascript: etc.
// Pure — testable on any platform.
bool IsSafeHttpUrl(const std::string& url);

// Fire-and-forget: opens the URL in the default browser on a detached thread,
// so the extension export returns instantly (ShellExecute can block for
// hundreds of ms on a browser cold start). Caller must have validated the URL
// with IsSafeHttpUrl. No-op on non-Windows builds.
//
// NOTE on the Utf8.hpp contract ("never convert to UTF-16"): that contract
// covers IPC message bytes. This is a one-shot boundary conversion into the
// Windows *W API, which is precisely where UTF-16 belongs.
void OpenUrlAsync(const std::string& url);

} // namespace ahc
