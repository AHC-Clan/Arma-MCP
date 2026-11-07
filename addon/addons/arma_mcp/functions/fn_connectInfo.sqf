#include "..\script_component.hpp"
/*
 * fn_connectInfo - onLoad of the main menu row. There is no mission here and, with
 * no menu world, spawned scripts may not run, so the row lives on display events:
 * the mouse events below fire every frame on the top display.
 */
params ["_button"];

private _display = ctrlParent _button;
_display setVariable ["AHC_connectRow", ctrlParentControlsGroup _button];

private _tick = { _this call (uiNamespace getVariable "AHC_ArmaMCP_fnc_connectInfoTick"); };
_display displayAddEventHandler ["MouseHolding", _tick];
_display displayAddEventHandler ["MouseMoving", _tick];
