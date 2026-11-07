#include "..\script_component.hpp"
#include "..\ui_defines.hpp"
/*
 * fn_connectAction - every button in the connect window. The DLL refuses these
 * commands unless they come from this file on the main menu, so a mission cannot
 * reach them through extension calls.
 */
params ["_key", "_args"];

private _control = _args select 0;
private _display = ctrlParent _control;

// Shows "Copied" on a copy button for a moment.
private _flash = {
    params ["_button"];
    if ((_display getVariable ["AHC_flash", []]) isNotEqualTo []) exitWith {};
    _display setVariable ["AHC_flash", [_button, ctrlText _button, diag_tickTime + 1.5]];
    _button ctrlSetText localize "STR_AHC_ArmaMCP_Copied";
};

switch (_key) do {
    case "close": {
        _display closeDisplay 2;
    };
    case "primary": {
        switch (_display getVariable ["AHC_primary", ""]) do {
            case "close": { _display closeDisplay 2; };
            case "probe": { EXTENSION callExtension "connectProbe"; };
            case "retry": {
                EXTENSION callExtension ["connectRun", _display getVariable ["AHC_retry", []]];
            };
            case "connect": {
                private _unchecked = _display getVariable ["AHC_unchecked", []];
                private _ids = (_display getVariable ["AHC_open", []]) select { !(_x in _unchecked) };
                if (count _ids > 0) then { EXTENSION callExtension ["connectRun", _ids]; };
            };
        };
    };
    case "box": {
        _args params ["_box", "_state"];
        private _id = _box getVariable ["AHC_id", ""];
        private _unchecked = _display getVariable ["AHC_unchecked", []];
        _unchecked = _unchecked - [_id];
        if (_state == 0) then { _unchecked pushBack _id; };
        _display setVariable ["AHC_unchecked", _unchecked];
        // Nothing checked means nothing to connect.
        [_display, EXTENSION callExtension "connectState"] call (uiNamespace getVariable "AHC_ArmaMCP_fnc_connectRefresh");
    };
    case "row": {
        private _row = floor ((ctrlIDC _control - AHCMCP_IDC_ROW) / 10);
        private _action = (_display getVariable ["AHC_rowActions", []]) param [_row, []];
        switch (_action param [0, ""]) do {
            case "remove": { EXTENSION callExtension ["connectRemove", [_action select 1]]; };
            case "open": { EXTENSION callExtension ["openUrl", [_action select 1]]; };
        };
    };
    case "copySay": {
        EXTENSION callExtension ["copyText", [localize "STR_AHC_ArmaMCP_SayText"]];
        [_control] call _flash;
    };
    case "copyRaw": {
        private _text = ((_display getVariable ["AHC_rawText", ""]) splitString "|") joinString toString [13, 10];
        EXTENSION callExtension ["copyText", [_text]];
        [_control] call _flash;
    };
};
