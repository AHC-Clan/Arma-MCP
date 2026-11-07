#include "..\ui_defines.hpp"
/*
 * fn_connectInfoHover - paints the main menu row. The vanilla rows get the same
 * effect from the menu script, which only handles its own idcs. Once connected the
 * row steps back so it does not compete with the rest of the menu.
 */
params ["_event", "_args"];
_args params ["_button"];

private _group = ctrlParentControlsGroup _button;
private _connected = _group getVariable ["AHC_connected", false];
private _on = _event == "enter";

private _icon = _group controlsGroupCtrl AHCMCP_IDC_INFO_ICON;
private _background = _group controlsGroupCtrl AHCMCP_IDC_INFO_BG;
private _backgroundIcon = _group controlsGroupCtrl AHCMCP_IDC_INFO_BGICON;
private _text = _group controlsGroupCtrl AHCMCP_IDC_INFO_TEXT;

_icon ctrlSetTextColor ([[1, 1, 1, [0.75, 0.4] select _connected], [1, 1, 1, 1]] select _on);
_text ctrlSetTextColor ([[1, 1, 1, [1, 0.55] select _connected], [1, 1, 1, 1]] select _on);
_background ctrlSetTextColor ([[0, 0, 0, 0.75], [1, 1, 1, 0.24]] select _on);
_backgroundIcon ctrlSetTextColor ([[0, 0, 0, 0.75], [1, 1, 1, 0.24]] select _on);
