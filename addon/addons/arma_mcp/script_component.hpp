// script_component.hpp — shared macros for the @arma_mcp addon.

#define EXTENSION  "arma_mcp"
#define LOG_PREFIX "[ArmaMCP]"

// Default IPC pipe (SQF treats backslash literally, so this is \\.\pipe\arma_mcp).
#define MCP_PIPE   "\\.\pipe\arma_mcp"

// Telemetry / heartbeat push interval (seconds). Clamped >= 1.0 by the engine.
#define MCP_TELEMETRY_INTERVAL 5.0
