// Protocol.hpp — IPC framing protocol between the DLL and the Arma-MCP server.
//
// Wire format: length-prefixed UTF-8 JSON.
//   [4 bytes little-endian uint32 payload length][payload bytes (UTF-8 JSON)]
//
// The payload is a JSON object; every frame carries "v":1. All strings are
// opaque UTF-8 (Korean text and emoji pass through unchanged — see Utf8.hpp).
//
// Message types (the "type" field). See docs/protocol.md for full schemas.
//   DLL    -> server: {"v":1,"type":"hello","role":"arma-ext","ver":"..."}
//   addon  -> server: {"v":1,"type":"sessionInfo", ...}
//   addon  -> server: {"v":1,"type":"telemetry", ...}
//   addon  -> server: {"v":1,"type":"execResult","reqId":"..","machine":"..","result":".."}
//   addon  -> server: {"v":1,"type":"heartbeat","up":N}
//   server -> game:   {"v":1,"type":"exec","reqId":"..","mode":"..","target":"..","code":"..","label":".."}
//   server -> game:   {"v":1,"type":"telemetryRequest","reqId":".."}
//   server -> game:   {"v":1,"type":"ping"}
//
// Outbound bodies (sessionInfo/execResult/telemetry/heartbeat/log) are built in
// SQF and forwarded verbatim by the DLL, which only stamps the {"v":1,"type":..}
// envelope (see Bridge::WrapBody). This keeps the DLL's JSON minimal while still
// supporting nested telemetry arrays. Only `hello` is DLL-generated.

#pragma once

#include <cstdint>
#include <string>

namespace ahc {

// Protocol version carried in every frame's "v" field.
constexpr int kProtocolVersion = 1;

// 4-byte length prefix, little-endian. Cap guards against a desynced stream.
constexpr std::uint32_t kMaxFrameBytes = 1u * 1024u * 1024u;

} // namespace ahc
