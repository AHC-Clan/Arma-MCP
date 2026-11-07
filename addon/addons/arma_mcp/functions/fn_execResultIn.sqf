#include "..\script_component.hpp"
/*
 * fn_execResultIn - server-only receiver for one machine's exec result. Called
 * directly (server mode) or via remoteExec/serverEvent from a client. Pushes the
 * result frame out to the MCP server and audit-logs it.
 *
 * Argument: [_machine, _reqId, _label, _ret].
 */
if (!isServer) exitWith {};
params [["_machine", "?"], ["_reqId", ""], ["_label", ""], ["_ret", ""]];

[_machine, _reqId, _label, _ret] call AHC_ArmaMCP_fnc_pushResult;
// One RPT line per result, like the request line in fn_onExec. A multi-line value
// would leave lines without the prefix that RPT waits and error blocks skip.
private _retLine = _ret;
if (_retLine isEqualType "") then {
    _retLine = (_retLine splitString (toString [13, 10])) joinString " ";
};
[format ["[EXEC] result <- %1 (reqId=%2): %3", _machine, _reqId, _retLine]] call AHC_ArmaMCP_fnc_log;
