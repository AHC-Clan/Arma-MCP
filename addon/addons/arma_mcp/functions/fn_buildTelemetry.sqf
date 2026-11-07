#include "..\script_component.hpp"
/*
 * fn_buildTelemetry - gathers live mission info into a JSON body string (inner
 * object only; the DLL adds the envelope). players is a nested JSON array built
 * in SQF: [[name, side, uid, isPlayer], ...] — forwarded verbatim.
 *
 * Argument: _reqId (string; "" for periodic push). Returns: JSON body string.
 */
params [["_reqId", ""]];

private _hcs = entities "HeadlessClient_F";
private _players = allPlayers - _hcs;
private _parts = [];
{
    private _p = format [
        "[""%1"",""%2"",""%3"",%4]",
        [name _x] call AHC_ArmaMCP_fnc_jsonEsc,
        [str (side _x)] call AHC_ArmaMCP_fnc_jsonEsc,
        [getPlayerUID _x] call AHC_ArmaMCP_fnc_jsonEsc,
        (parseNumber (isPlayer _x))
    ];
    _parts pushBack _p;
} forEach _players;
private _playersJson = "[" + (_parts joinString ",") + "]";

// clients: 로비에 있는 사람까지 보인다. allPlayers 기반의 players 로는 슬롯을 고르기
// 전 접속자가 안 보여 "로비에 있음" 과 "인게임" 이 갈리지 않는다. getUserInfo 는
// [id, ownerId, uid, profileName, displayName, steamName, clientStateNumber, isHC,
//  adminState, networkInfo, unit] 을 준다 — HC 판정에 휴리스틱이 필요 없다.
// 6번 항목은 이름 그대로 Number 다(getClientStateNumber 표: 6 ROLE ASSIGNED,
// 8 GAME LOADED, 9 BRIEFING SHOWN, 10 BRIEFING READ). 문자열로 착각해 jsonEsc 에
// 넘기면 toArray 가 매 push 마다 RPT 에 에러를 쌓으므로 JSON 숫자로 그대로 내보낸다.
// SP 는 이 필드를 아예 보내지 않는다. 서버는 없음(null)과 빈 배열을 구분한다.
private _clientsJson = "";
if (isMultiplayer) then {
    private _rows = [];
    {
        private _info = getUserInfo _x;
        if (count _info > 10) then {
            _rows pushBack (format [
                "[""%1"",%2,%3,%4]",
                [_info select 4] call AHC_ArmaMCP_fnc_jsonEsc,
                _info select 6,
                parseNumber (_info select 7),
                parseNumber (!isNull (_info select 10))
            ]);
        };
    } forEach allUsers;
    _clientsJson = ",""clients"":[" + (_rows joinString ",") + "]";
};

// paused/focused: only a machine with a window has them. A dedicated server
// leaves both out and the MCP server keeps them unknown (null). SP stops game
// time in the pause menu; MP keeps running.
private _uiJson = "";
if (hasInterface) then {
    _uiJson = format [",""paused"":%1,""focused"":%2", parseNumber isGamePaused, parseNumber isGameFocused];
};

// scripts: diag_activeScripts = [spawn, execVM, exec, execFSM] running now.
private _scripts = diag_activeScripts;
private _perfJson = format [
    ",""fpsMin"":%1,""scripts"":[%2,%3,%4,%5]",
    round (diag_fpsMin * 10) / 10,
    _scripts select 0, _scripts select 1, _scripts select 2, _scripts select 3
];

private _date = date;   // [year, month, day, hour, minute]
private _body = format [
    "{""reqId"":""%1"",""world"":""%2"",""mission"":""%3"",""briefing"":""%4"",""time"":%5,""date"":[%6,%7,%8,%9,%10],""fps"":%11,""players"":%12,""playerCount"":%13,""hcCount"":%14,""t"":%15%16%17%18}",
    [_reqId] call AHC_ArmaMCP_fnc_jsonEsc,
    [worldName] call AHC_ArmaMCP_fnc_jsonEsc,
    [missionName] call AHC_ArmaMCP_fnc_jsonEsc,
    [briefingName] call AHC_ArmaMCP_fnc_jsonEsc,
    round (time * 10) / 10,
    _date select 0, _date select 1, _date select 2, _date select 3, _date select 4,
    round (diag_fps * 10) / 10,
    _playersJson,
    count _players,
    count _hcs,
    round time,
    _clientsJson,
    _perfJson,
    _uiJson
];
_body
