#include "..\script_component.hpp"
/*
 * fn_onExec - server-side ExtensionCallback handler for an "exec" frame. The DLL
 * delivered a parseSimpleArray-safe string: [reqId, mode, target, code, label].
 * Audit-logs the request, then dispatches.
 *
 * Argument: _data (the callback data string).
 */
if (!isServer) exitWith {};
params [["_data", ""]];

private _arr = parseSimpleArray _data;
if (count _arr < 5) exitWith {
    [format ["[EXEC] malformed inbound: %1", _data]] call AHC_ArmaMCP_fnc_log;
};
_arr params ["_reqId", "_mode", "_target", "_code", "_label"];

// Audit trail: verbatim source + engine hash to correlate repeats. This runs on
// the unscheduled sim thread — a per-character SQF loop over a 128 KiB payload
// would stall the frame, so use hashValue (2.10+, see requiredVersion).
private _sum = hashValue _code;
// The source is logged on one RPT line: line breaks become spaces. A continuation
// line would carry no "[ArmaMCP] [EXEC]" prefix, so an RPT wait could not skip it
// and would match a marker in the code before the code ran. splitString and
// joinString are engine commands, so a large payload stays cheap.
private _codeLine = _code;
if (_codeLine isEqualType "") then {
    _codeLine = (_codeLine splitString (toString [13, 10])) joinString " ";
};
[format ["[EXEC] mode=%1 target=%2 reqId=%3 label=%4 sum=%5 code=%6",
    _mode, _target, _reqId, _label, _sum, _codeLine]] call AHC_ArmaMCP_fnc_log;

[_reqId, _mode, _target, _code, _label] call AHC_ArmaMCP_fnc_execDispatch;
