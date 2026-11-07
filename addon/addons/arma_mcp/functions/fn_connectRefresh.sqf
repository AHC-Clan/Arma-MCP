#include "..\ui_defines.hpp"
/*
 * fn_connectRefresh - draws the connect window for one DLL state.
 *
 * Arguments: [_display, _raw] where _raw is the connectState string. An empty
 * string means the extension did not load, which is what BattlEye causes.
 *
 * It decides a mode, lists rows for that mode, then places everything from the top
 * down. The window height follows the content, and the window stays centered.
 */
params ["_display", "_raw"];
if (isNull _display) exitWith {};

private _pw = pixelW * pixelGrid * 2 / AHCMCP_MOCK_UNIT;
private _ph = pixelH * pixelGrid * 2 / AHCMCP_MOCK_UNIT;
private _ctrl = { _display displayCtrl _this };

// RscText and RscStructuredText draw a few pixels in from their left edge. Text
// starts this far left of the box it should line up with.
private _textInset = 6;

private _setRich = {
    params ["_control", "_text"];
    private _safe = _text regexReplace ["&", "&amp;"];
    _safe = _safe regexReplace ["<", "&lt;"];
    _safe = _safe regexReplace [">", "&gt;"];
    _control ctrlSetStructuredText parseText (_safe regexReplace ["\|", "<br/>"]);
};

// --- what the DLL says ------------------------------------------------------
private _fields = if (_raw == "") then { [] } else { parseSimpleArray _raw };
private _phase = _fields param [0, "idle"];
private _node = (_fields param [1, "0"]) == "1";
private _git = (_fields param [2, "0"]) == "1";
private _hosts = [];
for "_i" from 3 to (count _fields - 7) step 7 do {
    _hosts pushBack (_fields select [_i, 7]);
};

private _found = _hosts select { (_x select 1) == "1" };
private _open = _found select { (_x select 2) != "1" };
private _failed = _found select { (_x select 5) == "1" };

private _mode = switch (true) do {
    case (_raw == ""): { "blocked" };
    case (_phase == "idle"): { "checking" };
    case (_phase == "probing" && { count _found == 0 }): { "checking" };
    case (_phase == "working"): { "working" };
    case (count _found == 0): { "none" };
    case (!_node || { !_git && { _open isNotEqualTo [] } }): { "prereq" };
    case (count _failed > 0): { "failed" };
    case (count _open > 0): { "ready" };
    default { "done" };
};

// --- texts and rows for this mode --------------------------------------------
private _colorOk = [0.498, 0.82, 0.604, 1];
private _colorWarn = [0.94, 0.70, 0.353, 1];
private _colorBad = [0.937, 0.541, 0.502, 1];
private _colorDim = [1, 1, 1, 0.55];

private _iconCheck = "ahc\addons\arma_mcp\ui\check_ca.paa";
private _iconWarn = "ahc\addons\arma_mcp\ui\warn_ca.paa";
private _iconCross = "ahc\addons\arma_mcp\ui\cross_ca.paa";

private _hostName = { ["Codex", "Claude Code"] select (_this == "claude") };
private _unchecked = _display getVariable ["AHC_unchecked", []];

// A row: [leading, name, subText, subColor, percent, actionText, action]
//   leading: "" | "box:<id>" | icon path. action: [] | ["remove", id] | ["open", url]
private _rows = [];
private _hostRow = {
    params ["_host"];
    _host params ["_id", "", "_connected", "_activity", "_percent", "_isFailed"];
    private _name = _id call _hostName;
    if (_activity != "") exitWith {
        private _step = switch (_activity) do {
            case "marketplace": { "STR_AHC_ArmaMCP_StepMarketplace" };
            case "install": { "STR_AHC_ArmaMCP_StepInstall" };
            case "verify": { "STR_AHC_ArmaMCP_StepVerify" };
            default { "STR_AHC_ArmaMCP_StepRemove" };
        };
        ["", _name, localize _step, _colorDim, parseNumber _percent / 100, "", []]
    };
    if (_isFailed == "1") exitWith {
        [_iconCross, _name, localize "STR_AHC_ArmaMCP_FailConnect", _colorBad, -1, "", []]
    };
    if (_connected == "1") exitWith {
        [
            _iconCheck, _name, localize "STR_AHC_ArmaMCP_Connected", _colorOk, -1,
            ["", localize "STR_AHC_ArmaMCP_Remove"] select (_mode != "working"),
            [["remove", _id], []] select (_mode == "working")
        ]
    };
    private _leading = ["", "box:" + _id] select (_mode == "ready");
    if (_mode == "prereq") then { _leading = _iconCheck; };
    [_leading, _name, localize "STR_AHC_ArmaMCP_Found", _colorDim, -1, "", []]
};
private _getRow = {
    params ["_name", "_url"];
    [_iconWarn, _name, localize "STR_AHC_ArmaMCP_NotInstalled", _colorWarn, -1, localize "STR_AHC_ArmaMCP_Get", ["open", _url]]
};

private _lead = localize "STR_AHC_ArmaMCP_Lead";
private _note = "";
private _primaryText = localize "STR_AHC_ArmaMCP_Close";
private _primaryAction = "close";
private _primaryEnabled = true;
private _showClose = true;
private _showSay = false;
private _rawText = "";

switch (_mode) do {
    case "blocked": {
        _lead = localize "STR_AHC_ArmaMCP_BattlEye";
        _showClose = false;
    };
    case "checking": {
        _lead = localize "STR_AHC_ArmaMCP_Checking";
        _showClose = false;
    };
    case "none": {
        _lead = localize "STR_AHC_ArmaMCP_NeedApp";
        _rows pushBack (["Claude Code", "https://code.claude.com/docs/en/quickstart"] call _getRow);
        _rows pushBack (["Codex", "https://developers.openai.com/codex/cli"] call _getRow);
        _primaryText = localize "STR_AHC_ArmaMCP_CheckAgain";
        _primaryAction = "probe";
    };
    case "prereq": {
        private _needGit = !_git && { count _open > 0 };
        _lead = localize (switch (true) do {
            case (!_node && _needGit): { "STR_AHC_ArmaMCP_NeedNodeGit" };
            case (!_node): { "STR_AHC_ArmaMCP_NeedNode" };
            default { "STR_AHC_ArmaMCP_NeedGit" };
        });
        { _rows pushBack ([_x] call _hostRow); } forEach _found;
        if (!_node) then { _rows pushBack (["Node.js", "https://nodejs.org/ko/download"] call _getRow); };
        if (_needGit) then { _rows pushBack (["Git", "https://git-scm.com/downloads/win"] call _getRow); };
        _primaryText = localize "STR_AHC_ArmaMCP_CheckAgain";
        _primaryAction = "probe";
    };
    case "working": {
        { _rows pushBack ([_x] call _hostRow); } forEach _found;
        _note = localize "STR_AHC_ArmaMCP_NoteWorking";
        _primaryText = localize "STR_AHC_ArmaMCP_Connecting";
        _primaryAction = "";
        _primaryEnabled = false;
    };
    case "failed": {
        _lead = localize "STR_AHC_ArmaMCP_FailLead";
        { _rows pushBack ([_x] call _hostRow); } forEach _found;
        _rawText = (_failed apply { _x select 6 }) joinString "|";
        _primaryText = localize "STR_AHC_ArmaMCP_Retry";
        _primaryAction = "retry";
        _display setVariable ["AHC_retry", _failed apply { _x select 0 }];
    };
    case "ready": {
        { _rows pushBack ([_x] call _hostRow); } forEach _found;
        _note = localize "STR_AHC_ArmaMCP_NoteRemove";
        _primaryText = localize "STR_AHC_ArmaMCP_Connect";
        _primaryAction = "connect";
        _primaryEnabled = _phase == "ready" && { ({ !((_x select 0) in _unchecked) } count _open) > 0 };
        _display setVariable ["AHC_open", _open apply { _x select 0 }];
    };
    case "done": {
        _lead = "";
        { _rows pushBack ([_x] call _hostRow); } forEach _found;
        _showSay = true;
        _note = localize "STR_AHC_ArmaMCP_NoteOpenChat";
        _showClose = false;
    };
};

_display setVariable ["AHC_primary", _primaryAction];
_display setVariable ["AHC_rawText", _rawText];

// --- placing -----------------------------------------------------------------
private _w = 640;
private _pad = 24;
private _inner = _w - 2 * _pad;
private _ops = [];   // [control, x, y, w, h], in mockup pixels from the window's top left
private _hide = [];
private _place = {
    params ["_idc", "_x1", "_y1", "_w1", "_h1"];
    _ops pushBack [_idc call _ctrl, _x1, _y1, _w1, _h1];
};
private _hideIdc = { { _hide pushBack (_x call _ctrl); } forEach _this; };

private _y = 56;
[AHCMCP_IDC_HEAD, 0, 0, _w, 56] call _place;
[AHCMCP_IDC_TITLE, _pad - _textInset, 0, _inner, 56] call _place;
_y = _y + 20;

private _leadCtrl = AHCMCP_IDC_LEAD call _ctrl;
if (_lead != "") then {
    [_leadCtrl, _lead] call _setRich;
    _leadCtrl ctrlSetPositionW ((_inner + _textInset) * _pw);
    _leadCtrl ctrlCommit 0;
    private _h = (ctrlTextHeight _leadCtrl) / _ph;
    [AHCMCP_IDC_LEAD, _pad - _textInset, _y, _inner + _textInset, _h] call _place;
    _y = _y + _h + 16;
} else {
    [AHCMCP_IDC_LEAD] call _hideIdc;
};

// Rows.
private _rowH = 68;
private _action = [];
for "_r" from 0 to 3 do {
    private _base = AHCMCP_IDC_ROW + _r * 10;
    private _part = { _base + _this };
    if (_r >= count _rows) then {
        [
            AHCMCP_ROW_LINE call _part, AHCMCP_ROW_BOX call _part, AHCMCP_ROW_ICON call _part,
            AHCMCP_ROW_NAME call _part, AHCMCP_ROW_SUB call _part, AHCMCP_ROW_BARBG call _part,
            AHCMCP_ROW_BAR call _part, AHCMCP_ROW_ACT call _part, AHCMCP_ROW_ACTFRAME call _part
        ] call _hideIdc;
        _action pushBack [];
    } else {
        (_rows select _r) params ["_leading", "_name", "_sub", "_subColor", "_percent", "_actText", "_act"];
        _action pushBack _act;

        [AHCMCP_ROW_LINE call _part, _pad, _y, _inner, 1] call _place;

        // Leading mark.
        private _boxIdc = AHCMCP_ROW_BOX call _part;
        private _iconIdc = AHCMCP_ROW_ICON call _part;
        if ((_leading select [0, 4]) == "box:") then {
            private _id = _leading select [4];
            private _box = _boxIdc call _ctrl;
            _box setVariable ["AHC_id", _id];
            private _want = !(_id in _unchecked);
            if (cbChecked _box != _want) then { _box cbSetChecked _want; };
            [_boxIdc, _pad, _y + 23, 22, 22] call _place;
            [_iconIdc] call _hideIdc;
        } else {
            [_boxIdc] call _hideIdc;
            if (_leading == "") then {
                [_iconIdc] call _hideIdc;
            } else {
                private _icon = _iconIdc call _ctrl;
                _icon ctrlSetText _leading;
                _icon ctrlSetTextColor (switch (_leading) do {
                    case _iconCheck: { _colorOk };
                    case _iconWarn: { _colorWarn };
                    default { _colorBad };
                });
                [_iconIdc, _pad, _y + 23, 22, 22] call _place;
            };
        };

        // Action button on the right.
        private _nameW = _inner - 36;
        private _actIdc = AHCMCP_ROW_ACT call _part;
        private _frameIdc = AHCMCP_ROW_ACTFRAME call _part;
        if (_actText == "") then {
            [_actIdc, _frameIdc] call _hideIdc;
        } else {
            private _button = _actIdc call _ctrl;
            _button ctrlSetText _actText;
            private _isRemove = (_act param [0, ""]) == "remove";
            _button ctrlSetTextColor ([[1, 1, 1, 1], _colorDim] select _isRemove);
            private _bw = (((ctrlTextWidth _button) / _pw + 16) max ([92, 48] select _isRemove));
            [_actIdc, _pad + _inner - _bw, _y + 14, _bw, 40] call _place;
            if (_isRemove) then {
                [_frameIdc] call _hideIdc;
            } else {
                [_frameIdc, _pad + _inner - _bw, _y + 14, _bw, 40] call _place;
            };
            _nameW = _nameW - _bw - 12;
        };

        // Name, sub line and progress.
        private _hasBar = _percent >= 0;
        private _nameIdc = AHCMCP_ROW_NAME call _part;
        private _subIdc = AHCMCP_ROW_SUB call _part;
        (_nameIdc call _ctrl) ctrlSetText _name;
        private _subCtrl = _subIdc call _ctrl;
        _subCtrl ctrlSetText _sub;
        _subCtrl ctrlSetTextColor _subColor;
        private _top = _y + ([11, 5] select _hasBar);
        [_nameIdc, _pad + 36 - _textInset, _top, _nameW + _textInset, 24] call _place;
        [_subIdc, _pad + 36 - _textInset, _top + 24, _nameW + _textInset, 20] call _place;
        private _barBgIdc = AHCMCP_ROW_BARBG call _part;
        private _barIdc = AHCMCP_ROW_BAR call _part;
        if (_hasBar) then {
            (_barIdc call _ctrl) progressSetPosition _percent;
            [_barBgIdc, _pad + 36, _y + 53, _inner - 36, 3] call _place;
            [_barIdc, _pad + 36, _y + 53, _inner - 36, 3] call _place;
        } else {
            [_barBgIdc, _barIdc] call _hideIdc;
        };

        _y = _y + _rowH;
    };
};
_display setVariable ["AHC_rowActions", _action];

if (count _rows > 0) then {
    [AHCMCP_IDC_ENDLINE, _pad, _y, _inner, 1] call _place;
    _y = _y + 1;
} else {
    [AHCMCP_IDC_ENDLINE] call _hideIdc;
};

// What to say next.
if (_showSay) then {
    _y = _y + 18;
    [AHCMCP_IDC_SAY_BG, _pad, _y, _inner, 94] call _place;
    [AHCMCP_IDC_SAY_PROMPT, _pad + 16 - _textInset, _y + 12, _inner - 32, 24] call _place;
    [AHCMCP_IDC_SAY_QUOTE, _pad + 16 - _textInset, _y + 40, _inner - 140, 40] call _place;
    private _copy = AHCMCP_IDC_SAY_COPY call _ctrl;
    private _bw = ((ctrlTextWidth _copy) / _pw + 16) max 92;
    [AHCMCP_IDC_SAY_COPY, _pad + _inner - 16 - _bw, _y + 40, _bw, 40] call _place;
    [AHCMCP_IDC_SAY_FRAME, _pad + _inner - 16 - _bw, _y + 40, _bw, 40] call _place;
    _y = _y + 94;
} else {
    [AHCMCP_IDC_SAY_BG, AHCMCP_IDC_SAY_PROMPT, AHCMCP_IDC_SAY_QUOTE, AHCMCP_IDC_SAY_COPY, AHCMCP_IDC_SAY_FRAME] call _hideIdc;
};

// The CLI's own words, for whoever helps.
if (_rawText != "") then {
    _y = _y + 14;
    private _text = AHCMCP_IDC_RAW_TEXT call _ctrl;
    // Show the command and the end of the output. "Copy Details" gives all of it.
    private _shown = _rawText;
    if (count _shown > 520) then {
        _shown = (_shown select [0, 90]) + " ... " + (_shown select [count _shown - 420]);
    };
    [_text, _shown] call _setRich;
    _text ctrlSetPositionW ((_inner - 24) * _pw);
    _text ctrlCommit 0;
    private _h = ((ctrlTextHeight _text) / _ph) min 150;
    [AHCMCP_IDC_RAW_BG, _pad, _y, _inner, _h + 20] call _place;
    [AHCMCP_IDC_RAW_FRAME, _pad, _y, _inner, _h + 20] call _place;
    [AHCMCP_IDC_RAW_TEXT, _pad + 12, _y + 10, _inner - 24, _h] call _place;
    _y = _y + _h + 20;
} else {
    [AHCMCP_IDC_RAW_BG, AHCMCP_IDC_RAW_FRAME, AHCMCP_IDC_RAW_TEXT] call _hideIdc;
};

// Bottom line: note or details button on the left, buttons on the right.
_y = _y + 20;
private _right = _pad + _inner;
private _primary = AHCMCP_IDC_PRIMARY call _ctrl;
_primary ctrlSetText _primaryText;
_primary ctrlEnable _primaryEnabled;
private _bw = ((ctrlTextWidth _primary) / _pw + 36) max 92;
[AHCMCP_IDC_PRIMARY, _right - _bw, _y, _bw, 40] call _place;
_right = _right - _bw - 8;
if (_showClose) then {
    private _close = AHCMCP_IDC_CLOSE call _ctrl;
    private _cw = ((ctrlTextWidth _close) / _pw + 36) max 92;
    [AHCMCP_IDC_CLOSE, _right - _cw, _y, _cw, 40] call _place;
    [AHCMCP_IDC_CLOSE_FRAME, _right - _cw, _y, _cw, 40] call _place;
    _right = _right - _cw - 8;
} else {
    [AHCMCP_IDC_CLOSE, AHCMCP_IDC_CLOSE_FRAME] call _hideIdc;
};
if (_rawText != "") then {
    private _left = AHCMCP_IDC_LEFT call _ctrl;
    private _lw = ((ctrlTextWidth _left) / _pw + 36) max 92;
    [AHCMCP_IDC_LEFT, _pad, _y, _lw, 40] call _place;
    [AHCMCP_IDC_LEFT_FRAME, _pad, _y, _lw, 40] call _place;
    [AHCMCP_IDC_NOTE] call _hideIdc;
} else {
    [AHCMCP_IDC_LEFT, AHCMCP_IDC_LEFT_FRAME] call _hideIdc;
    if (_note != "") then {
        (AHCMCP_IDC_NOTE call _ctrl) ctrlSetText _note;
        [AHCMCP_IDC_NOTE, _pad - _textInset, _y, _right - _pad + _textInset, 40] call _place;
    } else {
        [AHCMCP_IDC_NOTE] call _hideIdc;
    };
};
_y = _y + 40 + 24;

// --- apply, centered ---------------------------------------------------------
private _left = 0.5 - _w * _pw / 2;
private _top = 0.5 - _y * _ph / 2;
private _bg = AHCMCP_IDC_BG call _ctrl;
_bg ctrlSetPosition [_left, _top, _w * _pw, _y * _ph];
_bg ctrlCommit 0;
private _frame = AHCMCP_IDC_FRAME call _ctrl;
_frame ctrlSetPosition [_left, _top, _w * _pw, _y * _ph];
_frame ctrlCommit 0;

{ _x ctrlShow false; } forEach _hide;
{
    _x params ["_control", "_x1", "_y1", "_w1", "_h1"];
    _control ctrlSetPosition [_left + _x1 * _pw, _top + _y1 * _ph, _w1 * _pw, (_h1 * _ph) max pixelH];
    _control ctrlCommit 0;
    _control ctrlShow true;
} forEach _ops;
