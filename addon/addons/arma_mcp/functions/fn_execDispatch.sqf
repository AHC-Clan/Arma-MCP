#include "..\script_component.hpp"
/*
 * fn_execDispatch - server-only exec fan-out by mode.
 *   server -> run here (spawn), report as "server".
 *   all    -> run on every machine (incl. server), each reports its own result.
 *   client -> resolve the player by name, run on that one client.
 *
 * Targeting uses remoteExec (core Arma, CBA-independent) of the CfgFunctions
 * function AHC_ArmaMCP_fnc_execRunRemote. All remoteExec calls are fire-and-forget
 * (no JIP id) so nothing persists/replays for a late joiner.
 *
 * Argument: [_reqId, _mode, _target, _code, _label].
 */
if (!isServer) exitWith {};
params [["_reqId", ""], ["_mode", "server"], ["_target", ""], ["_code", ""], ["_label", ""]];
_mode = toLower _mode;

switch (_mode) do {
    case "server": {
        // Run on the server directly (spawn keeps a heavy/looping script off the
        // ExtensionCallback sim thread). Report through the shared result path.
        [_reqId, _code, _label] spawn {
            params ["_reqId", "_code", "_label"];
            private _ret = [_code] call AHC_ArmaMCP_fnc_execRun;
            ["server", _reqId, _label, _ret] call AHC_ArmaMCP_fnc_execResultIn;
        };
    };

    case "all": {
        // Everyone incl. the server. remoteExec target 0 covers the (dedicated)
        // server too, where execRunRemote runs and reports as "server".
        [_reqId, _code, _label] remoteExec ["AHC_ArmaMCP_fnc_execRunRemote", 0];
        [format ["[EXEC] ALL dispatched reqId=%1", _reqId]] call AHC_ArmaMCP_fnc_log;
    };

    case "client": {
        private _unit = [_target] call AHC_ArmaMCP_fnc_unitByName;
        if (isNull _unit) exitWith {
            ["server", _reqId, _label, format ["ERROR: no unit named '%1'", _target]] call AHC_ArmaMCP_fnc_execResultIn;
        };
        [_reqId, _code, _label] remoteExec ["AHC_ArmaMCP_fnc_execRunRemote", owner _unit];
        [format ["[EXEC] -> %1 reqId=%2", name _unit, _reqId]] call AHC_ArmaMCP_fnc_log;
    };

    default {
        ["server", _reqId, _label, format ["ERROR: unknown mode '%1'", _mode]] call AHC_ArmaMCP_fnc_execResultIn;
    };
};
