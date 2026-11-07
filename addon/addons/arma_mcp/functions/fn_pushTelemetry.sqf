#include "..\script_component.hpp"
/*
 * fn_pushTelemetry - builds and pushes a telemetry frame body to the DLL.
 * Argument: _reqId (string; "" for periodic push, or the requesting reqId).
 */
params [["_reqId", ""]];
private _body = [_reqId] call AHC_ArmaMCP_fnc_buildTelemetry;
EXTENSION callExtension ["pushTelemetry", [_body]];
