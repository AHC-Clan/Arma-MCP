#include "..\script_component.hpp"
/*
 * fn_openUrl - opens an http/https URL in this machine's default browser via
 * the extension's local-only "openUrl" command (no IPC — works on player
 * machines that have no MCP server). Called inside an exec payload broadcast
 * by arma_web_publish / arma_web_open, so no new remoteExec target function
 * is introduced.
 *
 * Argument: [_url] (http:// or https:// only — validated here AND in the DLL).
 * Returns: BOOL — true iff the browser open was dispatched on this machine.
 * Dedicated servers / headless clients are a no-op (false).
 */
params [["_url", ""]];

if (!hasInterface) exitWith { false };

private _lower = toLower _url;
if !((_lower select [0, 7]) == "http://" || {(_lower select [0, 8]) == "https://"}) exitWith {
    [format ["openUrl rejected (scheme): %1", _url]] call AHC_ArmaMCP_fnc_log;
    false
};

private _r = EXTENSION callExtension ["openUrl", [_url]];
[format ["openUrl %1 -> %2", _url, _r select 0]] call AHC_ArmaMCP_fnc_log;
(_r select 0) == "ok"
