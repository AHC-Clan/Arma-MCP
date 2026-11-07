#include "..\script_component.hpp"
/*
 * fn_execRunRemote - runs an exec on THIS (possibly remote) machine and reports
 * the result back to the server. The remoteExec target of fn_execDispatch's
 * "all"/"client" modes. Runs in a spawn so a heavy/looping script never blocks
 * the frame; reports via serverEvent (CBA) or remoteExec to the server (vanilla).
 *
 * Argument: [_reqId, _code, _label].
 */
params [["_reqId", ""], ["_code", ""], ["_label", ""]];

[_reqId, _code, _label] spawn {
    params ["_reqId", "_code", "_label"];
    private _ret = [_code] call AHC_ArmaMCP_fnc_execRun;
    private _machine = if (isDedicated) then { "server" } else { name player };
    if (isServer) then {
        // Already on the server (dedicated server's own "all" branch) — report locally.
        [_machine, _reqId, _label, _ret] call AHC_ArmaMCP_fnc_execResultIn;
    } else {
        [_machine, _reqId, _label, _ret] remoteExec ["AHC_ArmaMCP_fnc_execResultIn", 2];
    };
};
