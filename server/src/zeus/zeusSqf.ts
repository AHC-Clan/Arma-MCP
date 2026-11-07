// zeusSqf.ts: arma_zeus_find, arma_zeus_module 이 게임에 보내는 SQF 를 조립한다.
//
// 조립 SQF 는 exec 경로에서 compile 만 되고 preprocess 되지 않으므로 주석을 넣지 않는다.
// 사용자 문자열은 sqfString 으로만 넣는다. exec 는 server, client 모드 모두 spawn 안에서
// 돌므로, 목록 수집과 모듈 생성은 isNil { } 로 감싸 한 번에(unscheduled) 실행한다.
//
// 결과는 fn_execRun 의 500자 캡에 걸린다. 그래서 행을 다 모은 뒤 str 길이로 행 단위
// 페이지를 나누고, 첫 페이지만 바로 돌려준다. 나머지는 그 머신의 missionNamespace 변수
// AHC_MCP_pg(HashMap, 호출 키별)에 두고 buildPageSqf 로 받는다. 행 중간에서 자르지
// 않으므로 한국어 UTF-8 이 깨지지 않는다.

import { sqfNumber, sqfString, sqfStringArray } from '../mcp/sqfLiteral.js';

/**
 * 페이지 하나의 str 길이 상한. 첫 쪽은 "ARRAY: " 와 [합계,쪽수, 와 meta(약 25자)가 더해져도 500 아래다.
 * 실게임에서 행 하나가 120~150자라 380 이면 한 쪽에 두세 행이었다(47행에 18번 왕복).
 */
export const PAGE_BUDGET = 440;
/** 문자열 필드 하나의 글자 수 상한(toArray 기준, 글자 단위). */
export const FIELD_MAX = 40;
/** 호출 키 HashMap 에 남겨 두는 최대 항목 수. 중간에 끊긴 호출의 찌꺼기를 치운다. */
const PAGE_STORE_MAX = 8;

export type FindSource = 'mission' | 'selected';
export type MissionKind = 'unit' | 'group' | 'vehicle' | 'module' | 'object' | 'marker';
export type PaletteKind = 'unit' | 'vehicle' | 'object' | 'module' | 'groupTemplate';

/** mission, selected 행의 열 순서. TS 매퍼(zeusRuntime.ts)가 같은 순서로 읽는다. */
export const MISSION_ROW = [
  'kind',
  'ref',
  'label',
  'type',
  'class',
  'name',
  'var',
  'callsign',
  'role',
  'side',
  'grid',
  'x',
  'y',
  'flags',
  'extra',
  'score',
  'dist',
] as const;

/** palette 행의 열 순서. */
export const PALETTE_ROW = ['kind', 'class', 'label', 'path', 'side', 'flags', 'score'] as const;

/** mission 행 flags 비트. */
export const MF = { zeus: 1, player: 2, local: 4 } as const;
/** palette 행 flags 비트. */
export const PF = { canAttach: 1, attributeDialog: 2, opensDialog: 4 } as const;

// ---------------------------------------------------------------- 공용 조각

/** 문자열을 글자 단위로 자른다. count 가 바이트를 세더라도 toArray 는 글자를 센다. */
const CUT =
  'private _cut = {params ["_s","_n"]; if (count _s > _n) then {toString ((toArray _s) select [0,_n])} else {_s}};';

/**
 * 점수. _q 가 비면 1(목록), 정확 일치 100, 앞부분 60, 포함 40, 낱말이 모두 들어 있으면 25.
 * 호출하는 쪽 스코프의 _q, _tk 를 읽는다.
 */
const SCORE =
  'private _sc = {params ["_ls"]; if (_q isEqualTo "") exitWith {1}; private _b = 0; ' +
  '{private _l = toLower _x; if (_l isEqualTo _q) then {_b = _b max 100} else ' +
  '{private _i = _l find _q; if (_i == 0) then {_b = _b max 60} else {if (_i > 0) then {_b = _b max 40}}}} forEach _ls; ' +
  'if (_b == 0 && {count _tk > 1}) then {private _a = toLower (_ls joinString " "); ' +
  'if ((_tk findIf {(_a find _x) < 0}) < 0) then {_b = 25}}; _b};';

/** 쿼리 문자열과 낱말. */
function queryPrelude(query: string): string {
  return `private _q = toLower ${sqfString(query.trim())}; private _tk = _q splitString " ";`;
}

/**
 * _rows 를 점수 내림차순, 거리 오름차순으로 정렬해 _lim 개만 남긴다. _total 에 전체 수.
 * 점수 열과 거리 열 위치를 받는다(거리 열이 없으면 -1).
 */
function sortAndLimit(scoreCol: number, distCol: number): string {
  const dist = distCol >= 0 ? `((_x select ${distCol}) max 0)` : '0';
  return (
    'private _dec = []; ' +
    `{_dec pushBack [0 - (_x select ${scoreCol}), ${dist}, _forEachIndex]} forEach _rows; ` +
    '_dec sort true; private _total = count _rows; ' +
    'private _src = _rows; _rows = (_dec select [0, _lim]) apply {_src select (_x select 2)};'
  );
}

/**
 * 문자열 필드를 FIELD_MAX 로 자르고, 그래도 한 행이 예산을 넘으면 dropCols 를 비운다.
 * 그 뒤 행 단위로 페이지를 나눠 _pages 에 담는다.
 */
function paginate(dropCols: number[], labelCol: number): string {
  return (
    `_rows = _rows apply {private _r = +_x; {if (_x isEqualType "") then {_r set [_forEachIndex, [_x, ${FIELD_MAX}] call _cut]}} forEach _r; ` +
    `if (count str _r > ${PAGE_BUDGET}) then {{_r set [_x, ""]} forEach ${JSON.stringify(dropCols)}}; ` +
    `if (count str _r > ${PAGE_BUDGET}) then {_r set [${labelCol}, [_r select ${labelCol}, 12] call _cut]}; _r}; ` +
    'private _pages = []; private _pg = []; private _len = 2; ' +
    `{private _s = (count str _x) + 1; if (_len + _s > ${PAGE_BUDGET} && {count _pg > 0}) then {_pages pushBack _pg; _pg = []; _len = 2}; ` +
    '_pg pushBack _x; _len = _len + _s} forEach _rows; ' +
    'if (count _pg > 0 || {_pages isEqualTo []}) then {_pages pushBack _pg};'
  );
}

/** 2쪽 이상이면 남은 쪽을 호출 키로 보관한다. 오래된 키는 PAGE_STORE_MAX 를 넘으면 버린다. */
function storePages(key: string): string {
  return (
    'if (isNil "AHC_MCP_pg") then {AHC_MCP_pg = createHashMap}; ' +
    `if (count AHC_MCP_pg >= ${PAGE_STORE_MAX}) then {{AHC_MCP_pg deleteAt _x} forEach (keys AHC_MCP_pg)}; ` +
    `if (count _pages > 1) then {AHC_MCP_pg set [${sqfString(key)}, _pages]};`
  );
}

/** 이 머신에서 보는 Zeus 정보. _cur 는 이 머신 플레이어의 curator(없으면 objNull). */
const CURATOR =
  'private _cur = if (hasInterface && {!isNull player}) then {getAssignedCuratorLogic player} else {objNull};';

/** [게임 언어, Zeus 창 열림, 이 머신 curator 있음] */
const META = '[language, !isNull (findDisplay 312), !isNull _cur]';

// ---------------------------------------------------------------- 머신 선택

/**
 * 서버에서 돈다. [isMultiplayer, isDedicated, [[Zeus 플레이어 이름, 서버 로컬], ...]].
 * curator 에 배정된 유닛 중 플레이어인 것만 센다.
 */
export function buildDetectSqf(): string {
  return (
    'private _z = []; ' +
    '{private _u = getAssignedCuratorUnit _x; if (!isNull _u && {isPlayer _u}) then {_z pushBack [name _u, local _u]}} forEach allCurators; ' +
    '[isMultiplayer, isDedicated, _z]'
  );
}

// ---------------------------------------------------------------- mission, selected

export interface FindSqfArgs {
  source: FindSource;
  query: string;
  kinds: MissionKind[];
  side: string;
  zeusOnly: boolean;
  /** [] 이면 거리 정렬 없음. 'camera' 는 Zeus 카메라 위치. */
  near: [number, number] | 'camera' | null;
  limit: number;
  key: string;
}

/**
 * mission(맵 전체) 또는 selected(이 머신의 curatorSelected)에서 이름으로 찾는다.
 * 반환: [합계, 쪽수, 첫 쪽 행 배열, meta]. 행 열 순서는 MISSION_ROW.
 */
export function buildFindSqf(a: FindSqfArgs): string {
  const near =
    a.near === 'camera'
      ? 'private _np = if (!isNull curatorCamera) then {getPosATL curatorCamera} else {if (hasInterface) then {positionCameraToWorld [0,0,0]} else {[]}};'
      : a.near
        ? `private _np = [${sqfNumber(a.near[0])},${sqfNumber(a.near[1])},0];`
        : 'private _np = [];';

  const sources =
    a.source === 'selected'
      ? 'private _sel = curatorSelected; private _so = _sel param [0, []]; ' +
        'private _U = _so select {_x isKindOf "CAManBase"}; ' +
        'private _G = (_sel param [1, []]) select {side _x != sideLogic}; ' +
        'private _M = _so select {_x isKindOf "Module_F"}; ' +
        'private _O = _so select {!(_x isKindOf "CAManBase") && {!(_x isKindOf "Logic")}}; ' +
        'private _MK = _sel param [3, []]; private _all = true;'
      : 'private _U = allUnits; private _G = allGroups select {side _x != sideLogic}; ' +
        'private _M = allMissionObjects "Module_F"; ' +
        'private _O = vehicles + (_ed select {!(_x isKindOf "CAManBase") && {!(_x isKindOf "Logic")}}); _O = _O arrayIntersect _O; ' +
        'private _MK = allMapMarkers; private _all = false;';

  const want = (k: MissionKind): string => `(_K isEqualTo [] || {${sqfString(k)} in _K})`;

  const push =
    'private _push = {params ["_kd","_ref","_lb","_ty","_cls","_nm","_vr","_cs","_rl","_sdx","_fl","_ex","_p"]; ' +
    'if (count _K > 0 && {!(_kd in _K)}) exitWith {}; ' +
    'if (_sd != "" && {_sdx != _sd}) exitWith {}; ' +
    'private _s = [[_lb,_ty,_cls,_nm,_vr,_cs,_rl]] call _sc; if (_s <= 0) exitWith {}; ' +
    'private _d = if (count _np > 1) then {round (_p distance2D _np)} else {-1}; ' +
    '_rows pushBack [_kd,_ref,_lb,[_ty, ""] select (_ty isEqualTo _lb),_cls,_nm,_vr,_cs,_rl,_sdx,mapGridPosition _p,round (_p select 0),round (_p select 1),_fl,_ex,_s,_d]};';

  const units =
    `if ${want('unit')} then {{private _u = _x; private _z = _u in _ed; if (!_zo || {_z}) then {` +
    'private _v = vehicleVarName _u; private _ty = getText (configOf _u >> "displayName"); private _nm = name _u; ' +
    `private _fl = (parseNumber _z) + ${MF.player} * (parseNumber (isPlayer _u)) + ${MF.local} * (parseNumber (local _u)); ` +
    '["unit", _u call BIS_fnc_netId, [_ty, format ["%1 (%2)", _ty, _nm]] select (isPlayer _u), _ty, typeOf _u, _nm, _v, groupId group _u, roleDescription _u, str side group _u, _fl, "", getPosATL _u] call _push' +
    '}} forEach _U};';

  const groups =
    `if ${want('group')} then {{private _g = _x; private _us = units _g; ` +
    'private _z = (_us findIf {_x in _ed}) >= 0; if (count _us > 0 && {!_zo || {_z}}) then {' +
    'private _ld = leader _g; ' +
    `private _fl = (parseNumber _z) + ${MF.player} * (parseNumber ((_us findIf {isPlayer _x}) >= 0)) + ${MF.local} * (parseNumber (local _g)); ` +
    '["group", _g call BIS_fnc_netId, groupId _g, "", "", name _ld, "", groupId _g, "", str side _g, _fl, count _us, getPosATL _ld] call _push' +
    '}} forEach _G};';

  const objects =
    `if (${want('vehicle')} || ${want('object')}) then {{private _o = _x; ` +
    'if (!isNull _o && {!(_o isKindOf "WeaponHolder")} && {!(_o isKindOf "WeaponHolderSimulated")}) then {' +
    'private _vh = _o isKindOf "AllVehicles"; private _z = _o in _ed; private _v = vehicleVarName _o; ' +
    'if ((_all || {_vh} || {_z} || {_v != ""}) && {!_zo || {_z}}) then {' +
    'private _ty = getText (configOf _o >> "displayName"); ' +
    `private _fl = (parseNumber _z) + ${MF.local} * (parseNumber (local _o)); ` +
    '[["object","vehicle"] select _vh, _o call BIS_fnc_netId, _ty, _ty, typeOf _o, "", _v, "", "", str side _o, _fl, count crew _o, getPosATL _o] call _push' +
    '}}} forEach _O};';

  const modules =
    `if ${want('module')} then {{private _o = _x; private _z = _o in _ed; if (!_zo || {_z}) then {` +
    'private _v = vehicleVarName _o; private _ty = getText (configOf _o >> "displayName"); ' +
    `private _fl = (parseNumber _z) + ${MF.local} * (parseNumber (local _o)); ` +
    '["module", _o call BIS_fnc_netId, _ty, _ty, typeOf _o, "", _v, "", "", "", _fl, "", getPosATL _o] call _push' +
    '}} forEach _M};';

  const markers =
    `if (${want('marker')} && {!_zo}) then {{private _t = markerText _x; ` +
    '["marker", _x, [_t, _x] select (_t == ""), _t, markerType _x, "", "", "", "", "", 0, "", markerPos _x] call _push' +
    '} forEach _MK};';

  return [
    queryPrelude(a.query),
    `private _K = ${sqfStringArray(a.kinds)}; private _sd = ${sqfString(a.side)}; private _zo = ${a.zeusOnly ? 'true' : 'false'}; private _lim = ${Math.trunc(a.limit)};`,
    CUT,
    SCORE,
    CURATOR,
    'private _out = [];',
    'isNil {',
    'private _ed = []; if (!isNull _cur) then {_ed = curatorEditableObjects _cur} else {{_ed append (curatorEditableObjects _x)} forEach allCurators};',
    near,
    sources,
    'private _rows = [];',
    push,
    units,
    groups,
    objects,
    modules,
    markers,
    sortAndLimit(15, 16),
    paginate([5, 6, 8, 3, 7], 2),
    storePages(a.key),
    `_out = [_total, count _pages, _pages select 0, ${META}];`,
    '};',
    '_out',
  ].join(' ');
}

// ---------------------------------------------------------------- palette

/**
 * Zeus 생성 패널 색인을 이 머신의 missionNamespace(AHC_MCP_zp)에 만든다. 미션 동안 캐시된다.
 * Zeus 처럼 curatorAddons 의 CfgPatches units[] 중 scopeCurator == 2 만 담는다.
 * curator 가 없으면 전체 CfgPatches 를 본다. CfgGroups 도 groupTemplate 으로 담는다.
 * 색인 행: [kind, class, 표시 이름, 경로, side, canAttach]. 표시 이름은 이 머신 언어다.
 * 바깥 스코프의 _cur 를 읽는다.
 */
const PALETTE_INDEX =
  'if (isNil "AHC_MCP_zp") then {' +
  'private _ad = if (isNull _cur) then {("true" configClasses (configFile >> "CfgPatches")) apply {configName _x}} else {curatorAddons _cur}; ' +
  'private _sn = ["EAST","WEST","GUER","CIV"]; private _seen = createHashMap; private _ix = []; ' +
  '{{if !(_x in _seen) then {_seen set [_x, 0]; private _c = configFile >> "CfgVehicles" >> _x; ' +
  'if (isClass _c && {getNumber (_c >> "scopeCurator") == 2}) then {' +
  'private _kd = if (_x isKindOf "Logic") then {"module"} else {if (_x isKindOf "CAManBase") then {"unit"} else {if (_x isKindOf "AllVehicles") then {"vehicle"} else {"object"}}}; ' +
  'private _pa = if (_kd == "module") then {getText (configFile >> "CfgFactionClasses" >> getText (_c >> "category") >> "displayName")} else {' +
  'private _f = getText (configFile >> "CfgFactionClasses" >> getText (_c >> "faction") >> "displayName"); ' +
  'private _e = getText (configFile >> "CfgEditorSubcategories" >> getText (_c >> "editorSubcategory") >> "displayName"); ' +
  'if (_e == "") then {_f} else {_f + " > " + _e}}; ' +
  '_ix pushBack [_kd, _x, getText (_c >> "displayName"), _pa, _sn param [getNumber (_c >> "side"), ""], getNumber (_c >> "curatorCanAttach") > 0]' +
  '}}} forEach getArray (configFile >> "CfgPatches" >> _x >> "units")} forEach _ad; ' +
  '{private _sdc = _x; {private _fc = _x; {private _ca = _x; {' +
  '_ix pushBack ["groupTemplate", format ["%1|%2|%3|%4", configName _sdc, configName _fc, configName _ca, configName _x], ' +
  'getText (_x >> "name"), getText (_fc >> "name") + " > " + getText (_ca >> "name"), _sn param [getNumber (_x >> "side"), ""], false]' +
  '} forEach ("true" configClasses _ca)} forEach ("true" configClasses _fc)} forEach ("true" configClasses _sdc)} forEach ("true" configClasses (configFile >> "CfgGroups")); ' +
  'AHC_MCP_zp = _ix};';

/** 색인 행 하나를 점수 매긴 결과 행으로. 모듈이면 속성 창과 함수 본문의 창 열기를 본다. */
const PALETTE_ROW_SQF =
  'private _prow = {params ["_e","_s"]; _e params ["_kd","_cl","_lb","_pa","_sx","_at"]; ' +
  `private _fl = ${PF.canAttach} * (parseNumber _at); ` +
  'if (_kd == "module") then {private _c = configFile >> "CfgVehicles" >> _cl; ' +
  `if (getText (_c >> "curatorInfoType") != "") then {_fl = _fl + ${PF.attributeDialog}}; ` +
  'private _fs = str (missionNamespace getVariable [getText (_c >> "function"), {}]); ' +
  `if (({(_fs find _x) >= 0} count ["createDialog","createDisplay","zen_dialog_fnc_create"]) > 0) then {_fl = _fl + ${PF.opensDialog}}}; ` +
  '[_kd, _cl, _lb, _pa, _sx, _fl, _s]};';

export interface PaletteSqfArgs {
  query: string;
  kinds: PaletteKind[];
  side: string;
  limit: number;
  key: string;
}

/** Zeus 생성 패널에서 이름으로 찾는다. 반환: [합계, 쪽수, 첫 쪽 행 배열, meta]. 행은 PALETTE_ROW. */
export function buildPaletteSqf(a: PaletteSqfArgs): string {
  return [
    queryPrelude(a.query),
    `private _K = ${sqfStringArray(a.kinds)}; private _sd = ${sqfString(a.side)}; private _lim = ${Math.trunc(a.limit)};`,
    CUT,
    SCORE,
    CURATOR,
    PALETTE_ROW_SQF,
    'private _out = [];',
    'isNil {',
    PALETTE_INDEX,
    'private _hit = []; {_x params ["_kd","_cl","_lb","_pa","_sx"]; ' +
      'if ((count _K == 0 || {_kd in _K}) && {_sd == "" || {_sx == _sd}}) then {' +
      'private _s = [[_lb, _cl, _pa]] call _sc; if (_s > 0) then {_hit pushBack [_x, _s]}}} forEach AHC_MCP_zp;',
    'private _rows = _hit;',
    sortAndLimit(1, -1),
    '_rows = _rows apply {_x call _prow};',
    paginate([3], 2),
    storePages(a.key),
    `_out = [_total, count _pages, _pages select 0, ${META}];`,
    '};',
    '_out',
  ].join(' ');
}

// ---------------------------------------------------------------- 페이지

/** 보관한 쪽 하나를 꺼낸다. last 면 키를 지운다. 반환: [보관된 쪽수, 행 배열]. */
export function buildPageSqf(key: string, index: number, last: boolean): string {
  const k = sqfString(key);
  return (
    `private _p = (missionNamespace getVariable ["AHC_MCP_pg", createHashMap]) getOrDefault [${k}, []]; ` +
    `private _r = _p param [${Math.trunc(index)}, []]; ` +
    (last ? `if (!isNil "AHC_MCP_pg") then {AHC_MCP_pg deleteAt ${k}}; ` : '') +
    '[count _p, _r]'
  );
}

// ---------------------------------------------------------------- 모듈 실행

export interface ModuleRunSqfArgs {
  /** 클래스명 또는 Zeus 에 보이는 모듈 이름. */
  module: string;
  /** arma_zeus_find 의 ref(netId). 빈 문자열이면 대상 없음. */
  target: string;
  pos: [number, number] | null;
  dryRun: boolean;
  key: string;
}

/**
 * 모듈을 해석하고(클래스명이 아니면 palette 의 module 검색), Zeus 배치를 흉내 내 만든다.
 *
 * 흉내 내는 것(BIS fn_moduleInit, fn_curatorObjectPlaced, fn_curatorAttachObject 원문 기준):
 *  - 그룹 변수 isCuratorModuleGroup 이 true 면 moduleInit 이 Zeus 배치로 보고 바로 활성화한다.
 *  - bis_fnc_curatorObjectPlaced_mouseOver 에 대상을 남긴다.
 *  - curatorCanAttach 모듈이 객체 대상을 받으면 bis_fnc_curatorAttachObject 와 같은 순서로 붙인다.
 * moduleInit 은 함수를 spawn 뒤에 부르므로 isNil 안에서 생성과 부착을 끝내면 함수보다 먼저다.
 *
 * 반환:
 *  ["OK", class, 표시 이름, 카테고리, 로직 netId, [x,y], flags, 대상 종류]
 *  ["DRY", class, 표시 이름, 카테고리, "", [x,y], flags, 대상 종류]
 *  ["AMBIG", 후보 수, [[class, 표시 이름], ...]] (500자 안에 드는 만큼만)
 *  ["NONE"], ["NOTARGET"], ["NOPOS"], ["FAIL", 이유]
 */
export function buildModuleRunSqf(a: ModuleRunSqfArgs): string {
  const pos = a.pos ? `[${sqfNumber(a.pos[0])},${sqfNumber(a.pos[1])},0]` : '[]';
  return [
    queryPrelude(a.module),
    `private _in = ${sqfString(a.module.trim())}; private _tr = ${sqfString(a.target.trim())}; private _ps = ${pos};`,
    CUT,
    SCORE,
    CURATOR,
    PALETTE_ROW_SQF,
    'private _out = ["FAIL", "unknown"];',
    'isNil {',
    'private _cls = ""; private _c = configFile >> "CfgVehicles" >> _in;',
    'if (isClass _c && {_in isKindOf "Logic"}) then {_cls = configName _c} else {',
    PALETTE_INDEX,
    'private _hit = []; {if ((_x select 0) == "module") then {private _s = [[_x select 2, _x select 1, _x select 3]] call _sc; if (_s > 0) then {_hit pushBack [0 - _s, _x select 2, _forEachIndex]}}} forEach AHC_MCP_zp;',
    '_hit sort true;',
    'if (count _hit == 1 || {count _hit > 1 && {((_hit select 0) select 0) < ((_hit select 1) select 0)}}) then {_cls = (AHC_MCP_zp select ((_hit select 0) select 2)) select 1} else {',
    'if (count _hit > 1) then {private _am = []; {private _e = AHC_MCP_zp select (_x select 2); private _it = [_e select 1, [_e select 2, 24] call _cut]; ' +
      `if (count str (_am + [_it]) < ${PAGE_BUDGET}) then {_am pushBack _it}} forEach (_hit select [0, 8]); _out = ["AMBIG", count _hit, _am]} else {_out = ["NONE"]}};`,
    '};',
    'if (_cls != "") then {',
    'private _t = objNull; private _tg = grpNull;',
    'if (_tr != "") then {_t = _tr call BIS_fnc_objectFromNetId; if (isNull _t) then {_tg = _tr call BIS_fnc_groupFromNetId}};',
    'if (_tr != "" && {isNull _t} && {isNull _tg}) exitWith {_out = ["NOTARGET"]};',
    'private _p = if (count _ps > 1) then {_ps} else {if (!isNull _t) then {getPosATL _t} else {if (!isNull _tg) then {getPosATL leader _tg} else {if (hasInterface) then {screenToWorld [0.5,0.5]} else {[]}}}};',
    'if (count _p < 2) exitWith {_out = ["NOPOS"]};',
    '_p = [_p select 0, _p select 1, 0];',
    'private _c2 = configFile >> "CfgVehicles" >> _cls;',
    'private _row = [["module", _cls, getText (_c2 >> "displayName"), getText (configFile >> "CfgFactionClasses" >> getText (_c2 >> "category") >> "displayName"), "", getNumber (_c2 >> "curatorCanAttach") > 0], 0] call _prow;',
    'private _tk2 = if (!isNull _t) then {"object"} else {if (!isNull _tg) then {"group"} else {""}};',
    a.dryRun
      ? '_out = ["DRY", _cls, [_row select 2, 40] call _cut, [_row select 3, 40] call _cut, "", [round (_p select 0), round (_p select 1)], _row select 5, _tk2];'
      : [
          'private _d0 = count allDisplays; private _dl0 = dialog;',
          'private _g = createGroup [sideLogic, true];',
          'if (isNull _g) exitWith {_out = ["FAIL", "createGroup"]};',
          '_g setVariable ["isCuratorModuleGroup", true, true];',
          'private _m = _g createUnit [_cls, _p, [], 0, "CAN_COLLIDE"];',
          'if (isNull _m) exitWith {_out = ["FAIL", "createUnit"]};',
          'bis_fnc_curatorObjectPlaced_mouseOver = if (!isNull _t) then {["OBJECT", _t]} else {if (!isNull _tg) then {["GROUP", _tg]} else {[""]}};',
          'if (!isNull _t && {getNumber (_c2 >> "curatorCanAttach") > 0}) then {',
          '_m setVariable ["bis_fnc_curatorAttachObject_object", _t, true];',
          'private _ao = (_t getVariable ["bis_fnc_curatorAttachObject_objects", []]) - [objNull];',
          '_m attachTo [_t, [0, 0, 2 + count _ao]];',
          '_t setVariable ["bis_fnc_curatorAttachObject_objects", _ao + [_m], true]};',
          'if (isNil "AHC_MCP_zm") then {AHC_MCP_zm = createHashMap};',
          `AHC_MCP_zm set [${sqfString(a.key)}, [_m, _d0, _dl0]];`,
          '_out = ["OK", _cls, [_row select 2, 40] call _cut, [_row select 3, 40] call _cut, _m call BIS_fnc_netId, [round (_p select 0), round (_p select 1)], _row select 5, _tk2];',
        ].join(' '),
    '};',
    '};',
    '_out',
  ].join(' ');
}

/**
 * 모듈 생성 뒤 같은 머신에서 결과를 본다.
 * 반환: ["OK", 로직이 남았나, 지금 dialog, 늘어난 창 수, 전에 dialog 였나, Zeus 창 열림, 로직 netId] 또는 ["NOKEY"].
 */
export function buildModuleObserveSqf(key: string): string {
  const k = sqfString(key);
  return (
    `private _e = (missionNamespace getVariable ["AHC_MCP_zm", createHashMap]) getOrDefault [${k}, []]; ` +
    `if (!isNil "AHC_MCP_zm") then {AHC_MCP_zm deleteAt ${k}}; ` +
    'if (_e isEqualTo []) exitWith {["NOKEY"]}; ' +
    '_e params ["_m", "_d0", "_dl0"]; ' +
    '["OK", !isNull _m, dialog, (count allDisplays) - _d0, _dl0, !isNull (findDisplay 312), if (isNull _m) then {""} else {_m call BIS_fnc_netId}]'
  );
}

/**
 * 서버에서 돈다. 남은 모듈 로직을 curator 편집 대상에 넣어 Zeus 화면에 보이게 한다.
 * player 가 비어 있지 않으면 그 플레이어에게 배정된 curator 에만, 없거나 못 찾으면 모든 curator 에.
 * 반환: ["OK", 넣은 curator 수] 또는 ["GONE"].
 */
export function buildCuratorAddSqf(ref: string, player: string): string {
  return (
    `private _o = ${sqfString(ref)} call BIS_fnc_objectFromNetId; if (isNull _o) exitWith {["GONE"]}; ` +
    `private _nm = ${sqfString(player)}; private _u = objNull; ` +
    'if (_nm != "") then {private _i = allUnits findIf {isPlayer _x && {name _x == _nm}}; if (_i >= 0) then {_u = allUnits select _i}}; ' +
    'private _cs = if (isNull _u) then {allCurators} else {allCurators select {(getAssignedCuratorUnit _x) isEqualTo _u}}; ' +
    'if (_cs isEqualTo []) then {_cs = allCurators}; ' +
    '{_x addCuratorEditableObjects [[_o], false]} forEach _cs; ["OK", count _cs]'
  );
}
