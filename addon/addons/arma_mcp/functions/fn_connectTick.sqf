#include "..\script_component.hpp"
/*
 * fn_connectTick - a few times a second while the connect window is open. Redraws
 * only when the DLL's state changed, and puts a copy button's text back.
 */
params ["_display"];

if (diag_tickTime < (_display getVariable ["AHC_connectNext", 0])) exitWith {};
_display setVariable ["AHC_connectNext", diag_tickTime + 0.15];

private _flash = _display getVariable ["AHC_flash", []];
if (_flash isNotEqualTo [] && { diag_tickTime >= (_flash select 2) }) then {
    (_flash select 0) ctrlSetText (_flash select 1);
    _display setVariable ["AHC_flash", []];
};

private _raw = EXTENSION callExtension "connectState";
if (_raw isEqualTo (_display getVariable ["AHC_lastState", "<none>"])) exitWith {};
_display setVariable ["AHC_lastState", _raw];
[_display, _raw] call (uiNamespace getVariable "AHC_ArmaMCP_fnc_connectRefresh");
