#include "..\script_component.hpp"
/*
 * fn_initClient - client-side setup. Nothing to register explicitly: exec
 * targeting uses remoteExec of AHC_ArmaMCP_fnc_execRunRemote (a CfgFunctions
 * function compiled on every machine), which is directly remoteExec-callable.
 * This hook exists as the documented client entry point and for future use.
 */
if (!hasInterface) exitWith {};
[format ["client ready (%1)", name player]] call AHC_ArmaMCP_fnc_log;
