#include "..\script_component.hpp"
/*
 * fn_connectOnLoad - onLoad of the connect window. Checks this PC again, because
 * the person may have installed something since the menu opened, and keeps the
 * window on the DLL's state until it closes. The DLL does all the waiting on its
 * own thread, so the window only reads.
 */
params ["_display"];

_display setVariable ["AHC_unchecked", []];
[_display, EXTENSION callExtension "connectState"] call (uiNamespace getVariable "AHC_ArmaMCP_fnc_connectRefresh");
EXTENSION callExtension "connectProbe";

private _tick = { _this call (uiNamespace getVariable "AHC_ArmaMCP_fnc_connectTick"); };
_display displayAddEventHandler ["MouseHolding", _tick];
_display displayAddEventHandler ["MouseMoving", _tick];
