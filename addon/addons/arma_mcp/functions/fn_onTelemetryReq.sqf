#include "..\script_component.hpp"
/*
 * fn_onTelemetryReq - server-side handler for a "telemetryRequest" frame. Pushes
 * a fresh sessionInfo + telemetry immediately, carrying the requesting reqId so
 * the MCP server can correlate the round-trip (arma_mission_info fresh=true).
 *
 * Argument: _data (parseSimpleArray-safe string [reqId]).
 */
if (!isServer) exitWith {};
params [["_data", ""]];
private _arr = parseSimpleArray _data;
private _reqId = if (_arr isNotEqualTo []) then { _arr select 0 } else { "" };

"" call AHC_ArmaMCP_fnc_pushSession;
[_reqId] call AHC_ArmaMCP_fnc_pushTelemetry;
