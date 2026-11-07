#include "..\script_component.hpp"
#include "..\ui_defines.hpp"
/*
 * fn_connectInfoTick - once a second while the main menu is on top. The first run
 * moves the row above SITREP, which the menu's own onLoad may have moved, and starts
 * a check of this PC. Later runs keep the label on the connection state.
 */
params ["_display"];

if (diag_tickTime < (_display getVariable ["AHC_connectNext", 0])) exitWith {};
_display setVariable ["AHC_connectNext", diag_tickTime + 1];

private _group = _display getVariable ["AHC_connectRow", controlNull];
if (isNull _group) exitWith {};
private _button = _group controlsGroupCtrl AHCMCP_IDC_INFO_BUTTON;
private _hover = uiNamespace getVariable "AHC_ArmaMCP_fnc_connectInfoHover";

if !(_group getVariable ["AHC_placed", false]) then {
    _group setVariable ["AHC_placed", true];
    private _news = _display displayCtrl AHCMCP_IDC_VANILLA_NEWS;
    if (!isNull _news) then {
        private _position = ctrlPosition _group;
        _position set [1, (ctrlPosition _news select 1) - (_position select 3) - 4 * pixelH];
        _group ctrlSetPosition _position;
        _group ctrlCommit 0;
    };
    ["exit", [_button]] call _hover;
    EXTENSION callExtension "connectProbe";
};

private _raw = EXTENSION callExtension "connectState";
if (_raw isEqualTo (_group getVariable ["AHC_lastState", "<none>"])) exitWith {};
_group setVariable ["AHC_lastState", _raw];

private _connected = false;
if (_raw != "") then {
    private _fields = parseSimpleArray _raw;
    for "_i" from 3 to (count _fields - 7) step 7 do {
        if ((_fields select (_i + 2)) == "1") then { _connected = true; };
    };
};
_group setVariable ["AHC_connected", _connected];
(_group controlsGroupCtrl AHCMCP_IDC_INFO_TEXT) ctrlSetText localize (
    ["STR_AHC_ArmaMCP_Title", "STR_AHC_ArmaMCP_TitleConnected"] select _connected
);
["exit", [_button]] call _hover;
