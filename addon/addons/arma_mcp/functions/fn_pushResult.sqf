#include "..\script_component.hpp"
/*
 * fn_pushResult - builds the execResult body JSON and hands it to the DLL, which
 * stamps the {"v":1,"type":"execResult",...} envelope. The MCP server correlates
 * by reqId.
 *
 * Argument: [_machine, _reqId, _label, _ret].
 */
params [["_machine", "?"], ["_reqId", ""], ["_label", ""], ["_ret", ""]];

private _body = format [
    "{""reqId"":""%1"",""machine"":""%2"",""result"":""%3"",""label"":""%4"",""t"":%5}",
    [_reqId] call AHC_ArmaMCP_fnc_jsonEsc,
    [_machine] call AHC_ArmaMCP_fnc_jsonEsc,
    [_ret] call AHC_ArmaMCP_fnc_jsonEsc,
    [_label] call AHC_ArmaMCP_fnc_jsonEsc,
    round time
];
EXTENSION callExtension ["pushResult", [_body]];
