#include "..\script_component.hpp"
/*
 * fn_initEditor - Eden editor bridge. The Functions Library skips postInit while
 * is3DEN, so fn_init never runs in the editor. Cfg3DEN >> EventHandlers calls
 * this on onTerrainNew, onMissionNew, onMissionLoad and onMissionPreviewEnd
 * (the same hook BI's own editor scripts use).
 *
 * Same wire contract as fn_initServer: config, shutdown, start, ExtensionCallback
 * routing, a per-frame poll and the throttled telemetry and heartbeat. It differs in:
 *   - It runs several times in one editor session. Each run raises a generation
 *     number in uiNamespace, and handlers added by an older run remove themselves
 *     on their next call. A handler is never added twice, and no handler id is
 *     removed by guess (BI's editor scripts add EachFrame handlers of their own).
 *   - sessionInfo carries "editor":1 (fn_pushSession reads is3DEN), so the daemon
 *     can tell the agent that only server-mode exec exists and there are no players.
 *   - No PlayerConnected, OnUserClientStateChanged or Ended handlers. The editor
 *     has no players and no mission end. Preview start calls fn_stopEditor.
 *
 * Throttles use diag_tickTime as in fn_initServer.
 */
if (!is3DEN) exitWith {};
// Opening a mission can raise onTerrainNew and onMissionLoad together. One restart per frame.
if ((uiNamespace getVariable ["AHC_ArmaMCP_editorFrame", -1]) == diag_frameNo) exitWith {};
uiNamespace setVariable ["AHC_ArmaMCP_editorFrame", diag_frameNo];

private _gen = (uiNamespace getVariable ["AHC_ArmaMCP_editorGen", 0]) + 1;
uiNamespace setVariable ["AHC_ArmaMCP_editorGen", _gen];

// If the editor keeps missionNamespace across a preview, the guard a preview's
// fn_initServer set would stop the next preview's bridge. Clear it here.
AHC_ArmaMCP_serverInit = nil;

EXTENSION callExtension ["config", [MCP_PIPE, "0", "127.0.0.1", "0"]];
EXTENSION callExtension "shutdown";
EXTENSION callExtension "start";
[format ["editor bridge starting on %1 (%2, gen %3)", worldName, missionName, _gen]] call AHC_ArmaMCP_fnc_log;

AHC_ArmaMCP_sessionSent = false;
AHC_ArmaMCP_lastTelemetry = -1e9;

addMissionEventHandler ["ExtensionCallback", {
    params ["_name", "_function", "_data"];
    if ((uiNamespace getVariable ["AHC_ArmaMCP_editorGen", 0]) != (_thisArgs select 0)) exitWith {
        removeMissionEventHandler [_thisEvent, _thisEventHandler];
    };
    if (_name != "AHC_ArmaMCP") exitWith {};
    switch (_function) do {
        case "exec":         { _data call AHC_ArmaMCP_fnc_onExec; };
        case "telemetryReq": { _data call AHC_ArmaMCP_fnc_onTelemetryReq; };
    };
}, [_gen]];

addMissionEventHandler ["EachFrame", {
    if ((uiNamespace getVariable ["AHC_ArmaMCP_editorGen", 0]) != (_thisArgs select 0)) exitWith {
        removeMissionEventHandler [_thisEvent, _thisEventHandler];
    };
    EXTENSION callExtension "poll";

    // Read with defaults: if the editor replaces missionNamespace under a live
    // handler, a bare read would raise an error every frame.
    if (diag_tickTime - (missionNamespace getVariable ["AHC_ArmaMCP_lastTelemetry", -1e9]) >= MCP_TELEMETRY_INTERVAL) then {
        AHC_ArmaMCP_lastTelemetry = diag_tickTime;

        private _status = EXTENSION callExtension "status";
        private _connected = (_status find """connected"":""1""") >= 0;

        if (_connected) then {
            if !(missionNamespace getVariable ["AHC_ArmaMCP_sessionSent", false]) then {
                AHC_ArmaMCP_sessionSent = true;
                "" call AHC_ArmaMCP_fnc_pushSession;
            };
            "" call AHC_ArmaMCP_fnc_pushTelemetry;
            EXTENSION callExtension ["pushHeartbeat", ["{""up"":0}"]];
        } else {
            AHC_ArmaMCP_sessionSent = false;
        };
    };
}, [_gen]];
