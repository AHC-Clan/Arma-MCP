#include "..\script_component.hpp"
/*
 * fn_initServer - server-only bridge setup.
 *   1. Configure + (re)start the extension so a FRESH socket opens per mission
 *      (shutdown then start; the MCP server resets per-mission state on connect).
 *   2. Register the ExtensionCallback mission EH that routes inbound frames to SQF.
 *   3. Start ONE per-frame handler that (a) drains inbound via "poll" every frame,
 *      and (b) every MCP_TELEMETRY_INTERVAL seconds pushes telemetry + heartbeat,
 *      detects the connection rising edge, and (re)sends sessionInfo.
 *   4. On "Ended", shut the extension down so the socket closes cleanly.
 *
 * CBA present -> CBA_fnc_addPerFrameHandler(0). Absent -> "EachFrame" MEH. Both
 * run every frame; telemetry throttling is done with a time check either way.
 *
 * Throttles use diag_tickTime (real time), not time (game time). SP game time
 * stops in the pause menu (and, without -noPause, when the window loses focus);
 * EachFrame keeps running, but a time-based throttle would stop the heartbeat
 * and the MCP server would drop the link after 15 s. Values
 * that report game time (heartbeat "up", telemetry "time") stay on time so the
 * server can see the game clock stand still.
 */
if (!isServer) exitWith {};
if (!isNil "AHC_ArmaMCP_serverInit") exitWith {};
AHC_ArmaMCP_serverInit = true;

// --- 1. Configure + restart the extension (pipe mode by default) --------------
EXTENSION callExtension ["config", [MCP_PIPE, "0", "127.0.0.1", "0"]];
EXTENSION callExtension "shutdown";
EXTENSION callExtension "start";
[format ["server bridge starting on %1 (%2)", worldName, briefingName]] call AHC_ArmaMCP_fnc_log;

AHC_ArmaMCP_sessionSent = false;
AHC_ArmaMCP_lastTelemetry = -1e9;

// --- 2. Inbound routing via ExtensionCallback ---------------------------------
addMissionEventHandler ["ExtensionCallback", {
    params ["_name", "_function", "_data"];
    if (_name != "AHC_ArmaMCP") exitWith {};
    switch (_function) do {
        case "exec":        { _data call AHC_ArmaMCP_fnc_onExec; };
        case "telemetryReq": { _data call AHC_ArmaMCP_fnc_onTelemetryReq; };
    };
}];

// --- 3. Per-frame handler: poll + throttled telemetry -------------------------
AHC_ArmaMCP_fnc_tick = {
    // Drain inbound every frame (cheap; usually 0 dispatched).
    EXTENSION callExtension "poll";

    // Throttled telemetry + connection-edge sessionInfo.
    if (diag_tickTime - AHC_ArmaMCP_lastTelemetry >= MCP_TELEMETRY_INTERVAL) then {
        AHC_ArmaMCP_lastTelemetry = diag_tickTime;

        private _status = EXTENSION callExtension "status";
        private _connected = (_status find """connected"":""1""") >= 0;

        if (_connected) then {
            if (!AHC_ArmaMCP_sessionSent) then {
                AHC_ArmaMCP_sessionSent = true;
                "" call AHC_ArmaMCP_fnc_pushSession;
            };
            "" call AHC_ArmaMCP_fnc_pushTelemetry;
            private _hb = format ["{""up"":%1}", round time];
            EXTENSION callExtension ["pushHeartbeat", [_hb]];
        } else {
            // Link down -> next connect re-sends the session snapshot.
            AHC_ArmaMCP_sessionSent = false;
        };
    };
};

if (call AHC_ArmaMCP_fnc_hasCba) then {
    AHC_ArmaMCP_pfh = [{ call AHC_ArmaMCP_fnc_tick; }, 0, []] call CBA_fnc_addPerFrameHandler;
    [format ["poll loop started via CBA PFH"]] call AHC_ArmaMCP_fnc_log;
} else {
    AHC_ArmaMCP_pfhEH = addMissionEventHandler ["EachFrame", { call AHC_ArmaMCP_fnc_tick; }];
    [format ["poll loop started via EachFrame MEH (no CBA)"]] call AHC_ArmaMCP_fnc_log;
};

// --- 3b. Join/leave edge: push telemetry immediately so the MCP server's
// expectN derivation sees fresh player/HC counts instead of waiting out the
// MCP_TELEMETRY_INTERVAL throttle (up to 5 s of stale counts otherwise).
addMissionEventHandler ["PlayerConnected", {
    "" call AHC_ArmaMCP_fnc_pushTelemetry;
}];
addMissionEventHandler ["PlayerDisconnected", {
    "" call AHC_ArmaMCP_fnc_pushTelemetry;
}];

// --- 3c. Client state transitions: the lobby-to-in-game moment is what
// arma_play waits on, and it must not sit behind the 5 s telemetry throttle.
// Throttled at 0.5 s because every client walks through several states.
AHC_ArmaMCP_lastStatePush = -1e9;
addMissionEventHandler ["OnUserClientStateChanged", {
    if (diag_tickTime - AHC_ArmaMCP_lastStatePush > 0.5) then {
        AHC_ArmaMCP_lastStatePush = diag_tickTime;
        "" call AHC_ArmaMCP_fnc_pushTelemetry;
    };
}];

// --- 4. Clean shutdown at mission end -----------------------------------------
addMissionEventHandler ["Ended", {
    EXTENSION callExtension "shutdown";
}];
