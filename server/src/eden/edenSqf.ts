// edenSqf.ts: arma_eden_* 툴이 Eden 에디터에 보내는 SQF 를 조립한다.
//
// zeusSqf.ts 와 같은 규칙을 따른다. 조립 SQF 는 compile 만 되고 preprocess 되지 않으므로 주석을
// 넣지 않고, 사용자 문자열은 sqfString 으로만 넣는다. 목록 수집과 편집은 isNil { } 로 감싸
// 한 프레임에(unscheduled) 돌린다. 결과는 fn_execRun 의 500자 캡에 걸리므로 행 단위로 쪽을 나누고
// 남은 쪽은 Zeus 툴과 같은 AHC_MCP_pg 보관소에 둔다(buildPageSqf 로 받는다).
//
// 숫자: `str` 은 유효숫자 6자리라 Altis 좌표 12345.67 이 12345.7 이 된다. 그래서 잰 값은
// toFixed 2 로 찍어 쉼표로 이은 문자열 하나(geom 열)로 보낸다. TS 가 mapRow 로 되읽는다.
//
// 편집은 collect3DENHistory 로 묶어 호출 한 번이 에디터의 실행 취소 한 단계가 되게 한다
// (BI 의 fn_3den_onKeyDown 이 같은 방식으로 엔티티를 만든다).

import { sqfNumber, sqfString, sqfStringArray } from '../mcp/sqfLiteral.js';
import {
  CUT,
  FIELD_MAX,
  PAGE_BUDGET,
  SCORE,
  paginate,
  queryPrelude,
  sortAndLimit,
  storePages,
} from '../zeus/zeusSqf.js';
import type { EdenKind } from './edenGeom.js';

/** 행 열 순서. TS 매퍼(edenRuntime.ts 의 mapRow)가 같은 순서로 읽는다. */
export const ROW = ['id', 'kind', 'class', 'name', 'layer', 'geom', 'flags'] as const;
/** geom 열 안의 숫자 순서. */
export const GEOM = [
  'cx',
  'cy',
  'cz',
  'dir',
  'hx',
  'hy',
  'hz',
  'bottom',
  'gapMin',
  'gapMax',
  'tilt',
  'attrZ',
] as const;
/** 행 flags 비트. target 은 이번 호출이 만들거나 바꾼 엔티티다. */
export const RF = { water: 1, box: 2, selected: 4, target: 8 } as const;

/** 엔티티 종류. 맵 물체(map)는 이웃 판정용으로만 온다. */
export const SCENE_KINDS: readonly EdenKind[] = ['unit', 'vehicle', 'object', 'logic', 'trigger', 'marker'];

/** 이웃 판정에 넣는 최대 수. 쪽이 늘어나는 만큼 왕복이 는다. */
export const NEIGHBOR_MAX = 12;

// ---------------------------------------------------------------- 공용 조각

const GUARD = 'if (!is3DEN) exitWith {["NOEDEN"]};';

/** get3DENAttribute 의 첫 값. 없거나 nil 이면 기본값. */
const ATTR =
  'private _attr = {params ["_e","_n","_d"]; private _v = (_e get3DENAttribute _n) param [0, _d]; if (isNil "_v") then {_d} else {_v}};';

const KIND_OF =
  'private _kindOf = {params ["_e"]; if (_e isEqualType "") exitWith {"marker"}; ' +
  'if (_e isKindOf "EmptyDetector") exitWith {"trigger"}; if (_e isKindOf "Logic") exitWith {"logic"}; ' +
  'if (_e isKindOf "CAManBase") exitWith {"unit"}; if (_e isKindOf "AllVehicles") exitWith {"vehicle"}; "object"};';

/** 엔티티 id 에서 레이어 이름으로. 그룹은 그 유닛들에 레이어를 준다(BI 의 fn_3DENExportSQF 와 같다). */
const LAYER_MAP =
  'private _lm = createHashMap; ' +
  '{private _ln = [_x, "name", ""] call _attr; if !(_ln isEqualType "") then {_ln = ""}; ' +
  '{if (_x isEqualType grpNull) then {{_lm set [get3DENEntityID _x, _ln]} forEach units _x} else ' +
  '{if !(_x isEqualType 0) then {_lm set [get3DENEntityID _x, _ln]}}} forEach (get3DENLayerEntities _x)} forEach (all3DENEntities select 6);';

/** 판정과 필터에 쓰는 위치(ASL). 마커는 위치 속성에 지형 높이를 붙인다. */
const POS_OF =
  'private _posOf = {params ["_e","_k"]; if (_k == "marker") then {private _p = [_e, "position", [0,0,0]] call _attr; ' +
  '[_p select 0, _p select 1, getTerrainHeightASL _p]} else {getPosASL _e}};';

/**
 * 물체 하나를 잰다: [상자 중심 ASL, 반길이, 바닥, 모서리 틈 최소, 최대].
 * boundingBoxReal 은 모델 좌표이고 modelToWorldWorld 가 그것을 월드 ASL 로 옮긴다.
 * 아래 네 모서리마다 상자 위에서 아래로 선을 쏴 자기를 뺀 첫 표면(지형보다 낮지 않음)까지 잰다.
 */
const MEASURE =
  'private _meas = {params ["_e"]; private _bb = boundingBoxReal _e; private _mn = _bb select 0; private _mx = _bb select 1; ' +
  'private _c = _e modelToWorldWorld [((_mn select 0) + (_mx select 0)) / 2, ((_mn select 1) + (_mx select 1)) / 2, ((_mn select 2) + (_mx select 2)) / 2]; ' +
  'private _h = [((_mx select 0) - (_mn select 0)) / 2, ((_mx select 1) - (_mn select 1)) / 2, ((_mx select 2) - (_mn select 2)) / 2]; ' +
  'private _top = (_c select 2) + (_h select 2) + 0.05; ' +
  'private _cs = [[_mn select 0, _mn select 1], [_mn select 0, _mx select 1], [_mx select 0, _mn select 1], [_mx select 0, _mx select 1]] apply ' +
  '{_e modelToWorldWorld [_x select 0, _x select 1, _mn select 2]}; ' +
  'private _gs = _cs apply {private _hs = lineIntersectsSurfaces [[_x select 0, _x select 1, _top], [_x select 0, _x select 1, (_x select 2) - 100], _e, objNull, true, 1, "GEOM", "NONE"]; ' +
  'private _g = getTerrainHeightASL _x; if (_hs isNotEqualTo []) then {_g = _g max (((_hs select 0) select 0) select 2)}; (_x select 2) - _g}; ' +
  '[_c, _h, selectMin (_cs apply {_x select 2}), selectMin _gs, selectMax _gs]};';

/** 숫자 배열을 toFixed 2 로 이어 붙인 geom 문자열. */
const GEOM_STR = 'private _gstr = {params ["_a"]; (_a apply {_x toFixed 2}) joinString ","};';

/**
 * 엔티티 한 행. _fl 은 호출자가 주는 flags(selected, target). 바깥 스코프의 _lm, _attr, _meas, _gstr 를 쓴다.
 * 마커와 트리거, 로직은 상자를 재지 않는다.
 */
const ROW_OF =
  'private _row = {params ["_e","_k","_fl"]; private _id = get3DENEntityID _e; private _ly = _lm getOrDefault [_id, ""]; ' +
  'if (_k == "marker") exitWith {private _p = [_e, "position", [0,0,0]] call _attr; private _r = [_e, "rotation", 0] call _attr; ' +
  'if (_r isEqualType []) then {_r = _r param [2, 0]}; private _t = getTerrainHeightASL _p; ' +
  '[_id, _k, [_e, "itemClass", ""] call _attr, _e, _ly, [[_p select 0, _p select 1, _t, _r, 0, 0, 0, _t, 0, 0, 0, _p param [2, 0]]] call _gstr, _fl]}; ' +
  'private _nm = [_e, "name", ""] call _attr; if !(_nm isEqualType "") then {_nm = ""}; ' +
  'private _az = ([_e, "position", [0,0,0]] call _attr) param [2, 0]; ' +
  `private _w = ${RF.water} * (parseNumber (surfaceIsWater getPosASL _e)); ` +
  'if (_k in ["trigger","logic"]) exitWith {private _p = getPosASL _e; ' +
  '[_id, _k, typeOf _e, _nm, _ly, [[_p select 0, _p select 1, _p select 2, getDir _e, 0, 0, 0, _p select 2, 0, 0, 0, _az]] call _gstr, _fl + _w]}; ' +
  '([_e] call _meas) params ["_c","_h","_bz","_g0","_g1"]; ' +
  '[_id, _k, typeOf _e, _nm, _ly, [[_c select 0, _c select 1, _c select 2, getDir _e, _h select 0, _h select 1, _h select 2, _bz, _g0, _g1, ' +
  `acos (((vectorUp _e) select 2) min 1), _az]] call _gstr, _fl + _w + ${RF.box}]};`;

/** 맵 물체(지형에 박힌 건물, 나무, 바위) 한 행. id 0, kind map. 나무는 typeOf 가 비어 모델 이름을 쓴다. */
const ROW_MAP =
  'private _rowMap = {params ["_e"]; private _cl = typeOf _e; if (_cl == "") then {_cl = (getModelInfo _e) select 0}; ' +
  '([_e] call _meas) params ["_c","_h","_bz","_g0","_g1"]; ' +
  '[0, "map", _cl, "", "", [[_c select 0, _c select 1, _c select 2, getDir _e, _h select 0, _h select 1, _h select 2, _bz, _g0, _g1, ' +
  `acos (((vectorUp _e) select 2) min 1), 0]] call _gstr, ${RF.box}]};`;

/** 모든 조립 SQF 앞에 붙는 조각. */
const PRELUDE = [CUT, ATTR, KIND_OF, LAYER_MAP, POS_OF, MEASURE, GEOM_STR, ROW_OF, ROW_MAP].join(' ');

/**
 * _rows 를 쪽으로 나눈다. keep 열(geom)은 자르지 않고 나머지 문자열은 FIELD_MAX 로 자른다.
 * 행 하나는 문자열 셋이 40자씩이어도 쪽 예산 안이다.
 */
function paginateRows(keep: number[]): string {
  return (
    `_rows = _rows apply {private _r = +_x; {if (_x isEqualType "" && {!(_forEachIndex in ${JSON.stringify(keep)})}) then ` +
    `{_r set [_forEachIndex, [_x, ${FIELD_MAX}] call _cut]}} forEach _r; _r}; ` +
    'private _pages = []; private _pg = []; private _len = 2; ' +
    `{private _s = (count str _x) + 1; if (_len + _s > ${PAGE_BUDGET} && {count _pg > 0}) then {_pages pushBack _pg; _pg = []; _len = 2}; ` +
    '_pg pushBack _x; _len = _len + _s} forEach _rows; ' +
    'if (count _pg > 0 || {_pages isEqualTo []}) then {_pages pushBack _pg};'
  );
}

/**
 * 대상 엔티티(_T, 물체만) 둘레의 이웃을 _rows 뒤에 붙인다. 맵 물체는 nearestTerrainObjects 로,
 * 다른 Eden 물체는 all3DENEntities 에서 찾는다. 반경은 대상 상자 반지름 + extra(m).
 */
function neighbors(extra: number): string {
  return (
    'private _nb = []; private _nm2 = []; ' +
    `{private _t = _x; private _r = ((boundingBoxReal _t) select 2) + ${sqfNumber(extra)}; ` +
    '{if (!(_x in _T) && {!(_x in _nb)}) then {_nb pushBack _x}} forEach ((all3DENEntities select 0) select {(_x distance2D _t) <= _r}); ' +
    '{if (!(_x in _nm2)) then {_nm2 pushBack _x}} forEach (nearestTerrainObjects [getPosASL _t, [], _r, true, true]); ' +
    '} forEach (_T select {_x isEqualType objNull}); ' +
    `_nb = _nb select [0, ${NEIGHBOR_MAX}]; _nm2 = _nm2 select [0, ${NEIGHBOR_MAX} - count _nb]; ` +
    '{_rows pushBack ([_x, [_x] call _kindOf, 0] call _row)} forEach _nb; ' +
    '{_rows pushBack ([_x] call _rowMap)} forEach _nm2;'
  );
}

function finish(key: string, meta: string): string {
  return [
    paginateRows([5]),
    storePages(key),
    `_out = [count _rows, count _pages, _pages select 0, ${meta}];`,
  ].join(' ');
}

// ---------------------------------------------------------------- 장면 읽기

export interface SceneSqfArgs {
  /** 비면 전체. */
  ids: number[];
  kinds: EdenKind[];
  /** 클래스, 변수 이름, 레이어, 표시 이름 조각(대소문자 무시). */
  query: string;
  layer: string;
  /** [x, y] 와 반경(m). 있으면 가까운 순으로 정렬한다. */
  near: [number, number] | null;
  radius: number;
  /** 에디터에서 선택한 것만. */
  selected: boolean;
  limit: number;
  key: string;
}

/**
 * 에디터 엔티티를 거르고 잰다. 반환: [합계(거른 뒤), 쪽수, 첫 쪽, [선택 수]].
 * 거르기는 싼 값(id, 종류, 이름, 위치)으로 먼저 하고, 상자 재기는 남은 limit 개에만 한다.
 */
export function buildSceneSqf(a: SceneSqfArgs): string {
  const near = a.near ? `[${sqfNumber(a.near[0])},${sqfNumber(a.near[1])}]` : '[]';
  return [
    GUARD,
    'private _out = [];',
    'isNil {',
    PRELUDE,
    `private _ids = [${a.ids.map((n) => sqfNumber(Math.trunc(n))).join(',')}]; private _K = ${sqfStringArray(a.kinds)}; `,
    `private _q = toLower ${sqfString(a.query.trim())}; private _L = toLower ${sqfString(a.layer.trim())}; `,
    `private _np = ${near}; private _rad = ${sqfNumber(a.radius)}; private _lim = ${Math.trunc(a.limit)};`,
    'private _S = (get3DENSelected "object") + (get3DENSelected "trigger") + (get3DENSelected "logic") + (get3DENSelected "marker");',
    'all3DENEntities params ["_objs","_grps","_trgs","_logs","_wps","_mks"];',
    `private _src = ${a.selected ? '_S' : '_objs + _trgs + _logs + _mks'};`,
    'private _cand = [];',
    '{private _e = _x; private _k = [_e] call _kindOf; private _id = get3DENEntityID _e; ' +
      'if ((_ids isEqualTo [] || {_id in _ids}) && {_K isEqualTo [] || {_k in _K}}) then {' +
      'private _p = [_e, _k] call _posOf; private _d = if (count _np > 1) then {_p distance2D _np} else {-1}; ' +
      'if (_d <= _rad) then {' +
      'private _ly = _lm getOrDefault [_id, ""]; ' +
      'if (_L isEqualTo "" || {(toLower _ly) isEqualTo _L}) then {' +
      'private _ok = _q isEqualTo ""; if (!_ok) then {' +
      'private _cl = if (_k == "marker") then {[_e, "itemClass", ""] call _attr} else {typeOf _e}; ' +
      'private _nm = if (_k == "marker") then {_e} else {[_e, "name", ""] call _attr}; if !(_nm isEqualType "") then {_nm = ""}; ' +
      'private _dn = if (_k == "marker") then {""} else {getText (configOf _e >> "displayName")}; ' +
      '_ok = (toLower ([_cl, _nm, _ly, _dn] joinString " ")) find _q >= 0}; ' +
      'if (_ok) then {_cand pushBack [[_d, _id] select (_d < 0), _id, _e, _k]}}}}} forEach _src;',
    '_cand sort true; private _total = count _cand;',
    `private _rows = (_cand select [0, _lim]) apply {[_x select 2, _x select 3, ${RF.selected} * (parseNumber ((_x select 2) in _S))] call _row};`,
    finish(a.key, '[_total, count _S]'),
    '};',
    '_out',
  ].join(' ');
}

// ---------------------------------------------------------------- 클래스 확인

/** 클래스 한 행: [클래스, 상태(0 없음, 1 크기 잼, 2 있지만 크기 모름), "hx,hy,hz"]. */
export const CLASS_ROW = ['class', 'state', 'half'] as const;

export interface ClassSqfArgs {
  /** [클래스, create3DENEntity 모드] */
  classes: [string, EdenMode][];
  key: string;
}

export type EdenMode = 'Object' | 'Logic' | 'Trigger' | 'Marker';

/**
 * 만들 클래스가 있는지 보고 크기를 잰다. 크기는 지역 단순 물체를 높이 2000 m 에 잠깐 만들어
 * boundingBoxReal 로 재고 바로 지운다(에디터 엔티티가 아니라 실행 취소 기록에 남지 않는다).
 * 없는 클래스의 후보는 여기서 찾지 않는다. arma_eden_find 와 같은 자산 색인(buildAssetsSqf)으로 찾는다.
 */
export function buildClassSqf(a: ClassSqfArgs): string {
  const list = '[' + a.classes.map(([c, m]) => `[${sqfString(c)},${sqfString(m)}]`).join(',') + ']';
  return [
    GUARD,
    'private _out = [];',
    'isNil {',
    CUT,
    GEOM_STR,
    'private _rows = [];',
    `{_x params ["_c","_m"]; private _cfg = configFile >> (["CfgVehicles","CfgMarkers"] select (_m == "Marker"));` +
      'if (!isClass (_cfg >> _c)) then {_rows pushBack [_c, 0, ""]} else {' +
      'if (_m != "Object") then {_rows pushBack [_c, 2, ""]} else {' +
      'private _o = createSimpleObject [_c, [0, 0, 2000], true]; ' +
      'if (isNull _o) then {_rows pushBack [_c, 2, ""]} else {' +
      'private _bb = boundingBoxReal _o; deleteVehicle _o; private _mn = _bb select 0; private _mx = _bb select 1; ' +
      '_rows pushBack [_c, 1, [[((_mx select 0) - (_mn select 0)) / 2, ((_mx select 1) - (_mn select 1)) / 2, ((_mx select 2) - (_mn select 2)) / 2]] call _gstr]}}}} forEach ' +
      list +
      ';',
    paginateRows([2]),
    storePages(a.key),
    '_out = [count _rows, count _pages, _pages select 0, []];',
    '};',
    '_out',
  ].join(' ');
}

// ---------------------------------------------------------------- 만들기와 고치기

/**
 * 높이 정하기. ground 는 아래 네 모서리 중 가장 가까운 것을 표면에 닿게 내리고(유닛은 에디터 스냅에 맡긴다),
 * on 은 ref 의 윗면(물체 중심 아래로 쏜 선이 ref 에 닿은 곳, 없으면 ref 상자 윗면)에 바닥을 놓고,
 * asl 은 바닥을 그 높이에, attr 는 에디터 위치 속성 z 를 그 값으로 둔다. keep 은 높이를 건드리지 않는다.
 */
export type ZRule =
  | { kind: 'ground' }
  | { kind: 'on'; ref: number }
  | { kind: 'asl'; z: number }
  | { kind: 'attr'; z: number }
  | { kind: 'keep' };

export interface PlaceItem {
  mode: EdenMode;
  class: string;
  pos: [number, number];
  dir: number;
  z: ZRule;
  name: string;
}

export interface EditOp {
  id: number;
  /** 새 위치(x, y). null 이면 그대로. */
  pos: [number, number] | null;
  /** 새 방위각. null 이면 그대로. */
  dir: number | null;
  z: ZRule;
  /** null 이면 그대로. */
  name: string | null;
  delete: boolean;
}

function zArgs(z: ZRule): string {
  switch (z.kind) {
    case 'ground':
      return '"ground",0';
    case 'on':
      return `"on",${sqfNumber(Math.trunc(z.ref))}`;
    case 'asl':
      return `"asl",${sqfNumber(z.z)}`;
    case 'attr':
      return `"attr",${sqfNumber(z.z)}`;
    case 'keep':
      return '"keep",0';
  }
}

/**
 * 높이를 맞춘다. _e 는 물체, _zk 와 _zv 는 zArgs 순서. 에디터 위치 속성 z 를 바닥이 옮겨 갈 만큼 바꾼다.
 * 유닛의 ground 는 create3DENEntity 의 스냅에 맡긴다(사람 상자 바닥이 발바닥과 같지 않다).
 */
const SETTLE =
  'private _settle = {params ["_e","_k","_zk","_zv"]; if (_zk == "keep" || {!(_e isEqualType objNull)} || {_k in ["trigger","logic"]}) exitWith {}; ' +
  'private _p = [_e, "position", getPosATL _e] call _attr; ' +
  'if (_zk == "attr") exitWith {_e set3DENAttribute ["position", [_p select 0, _p select 1, _zv]]}; ' +
  'if (_zk == "ground" && {_k == "unit"}) exitWith {}; ' +
  '([_e] call _meas) params ["_c","_h","_bz","_g0","_g1"]; private _dz = 0; ' +
  'if (_zk == "ground") then {_dz = 0 - _g0}; ' +
  'if (_zk == "asl") then {_dz = _zv - _bz}; ' +
  'if (_zk == "on") then {private _r = get3DENEntity _zv; if (!isNull _r) then {' +
  '([_r] call _meas) params ["_rc","_rh"]; private _rt = (_rc select 2) + (_rh select 2); ' +
  'private _hs = lineIntersectsSurfaces [[_c select 0, _c select 1, _rt + 1], [_c select 0, _c select 1, (_rc select 2) - (_rh select 2) - 1], _e, objNull, true, 10, "GEOM", "NONE"]; ' +
  'private _i = _hs findIf {((_x select 2) isEqualTo _r) || {(_x select 3) isEqualTo _r}}; ' +
  'private _sz = if (_i >= 0) then {((_hs select _i) select 0) select 2} else {_rt}; _dz = _sz - _bz}}; ' +
  'if (abs _dz > 0.001) then {_e set3DENAttribute ["position", [_p select 0, _p select 1, (_p select 2) + _dz]]}};';

/**
 * 상자 중심을 _w([x, y])에 맞춘다. 서버가 푸는 좌표는 상자 중심인데 위치 속성은 모델 원점이라,
 * 원점이 상자 중심에서 벗어난 모델(컨테이너 숙소는 약 1 m)은 그만큼 어긋난다. 방향을 넣은 뒤 재서 그 차이만큼 옮긴다.
 * _w 가 비었거나 상자가 없는 종류(마커, 트리거, 로직)는 건드리지 않는다.
 */
const CENTER =
  'private _center = {params ["_e","_k","_w"]; if (count _w < 2 || {!(_e isEqualType objNull)} || {_k in ["trigger","logic"]}) exitWith {}; ' +
  'private _p = [_e, "position", getPosATL _e] call _attr; ([_e] call _meas) params ["_c"]; ' +
  'private _dx = (_w select 0) - (_c select 0); private _dy = (_w select 1) - (_c select 1); ' +
  'if (abs _dx > 0.001 || {abs _dy > 0.001}) then {_e set3DENAttribute ["position", [(_p select 0) + _dx, (_p select 1) + _dy, _p select 2]]}};';

/** 방향. 마커는 rotation 이 수 하나, 나머지는 [x, y, z] 이고 z 가 방위각이다. */
const ROTATE =
  'private _rot = {params ["_e","_k","_d"]; if (_k == "marker") then {_e set3DENAttribute ["rotation", _d]} else ' +
  '{private _r = [_e, "rotation", [0,0,0]] call _attr; if !(_r isEqualType []) then {_r = [0,0,0]}; ' +
  '_e set3DENAttribute ["rotation", [_r param [0, 0], _r param [1, 0], _d]]}};';

export interface PlaceSqfArgs {
  items: PlaceItem[];
  /** 만든 것을 에디터에서 선택한다. */
  select: boolean;
  /** 이웃 반경 여유(m). 0 이면 이웃을 보지 않는다. */
  neighborRadius: number;
  key: string;
}

/**
 * 엔티티를 만들고 높이와 방향을 맞춘 뒤 잰다. 한 호출이 실행 취소 한 단계다.
 * 반환: [행 수, 쪽수, 첫 쪽, [만든 수, 못 만든 순번들]]. 만든 엔티티 행은 flags 에 target 비트가 있다.
 */
export function buildPlaceSqf(a: PlaceSqfArgs): string {
  const items =
    '[' +
    a.items
      .map(
        (it) =>
          `[${sqfString(it.mode)},${sqfString(it.class)},[${sqfNumber(it.pos[0])},${sqfNumber(it.pos[1])}],${sqfNumber(it.dir)},${zArgs(it.z)},${sqfString(it.name)}]`,
      )
      .join(',') +
    ']';
  return [
    GUARD,
    'private _out = [];',
    'isNil {',
    PRELUDE,
    SETTLE,
    CENTER,
    ROTATE,
    'private _new = []; private _bad = [];',
    'collect3DENHistory {' +
      '{_x params ["_m","_c","_xy","_d","_zk","_zv","_nm"]; ' +
      'private _e = create3DENEntity [_m, _c, [_xy select 0, _xy select 1, 0], true]; ' +
      'if (isNil "_e" || {_e isEqualTo objNull} || {_e isEqualTo ""}) then {_bad pushBack _forEachIndex} else {' +
      'private _k = [_e] call _kindOf; [_e, _k, _d] call _rot; ' +
      'if (_nm != "" && {_k != "marker"}) then {_e set3DENAttribute ["name", _nm]}; ' +
      '_new pushBack [_e, _k, _zk, _zv, _xy]}} forEach ' +
      items +
      '; ' +
      '{_x params ["_e","_k","_zk","_zv","_w"]; [_e, _k, _w] call _center; [_e, _k, _zk, _zv] call _settle} forEach _new;' +
      '};',
    a.select ? 'set3DENSelected (_new apply {_x select 0});' : '',
    'private _T = _new apply {_x select 0};',
    `private _rows = _new apply {[_x select 0, _x select 1, ${RF.target}] call _row};`,
    a.neighborRadius > 0 ? neighbors(a.neighborRadius) : '',
    finish(a.key, '[count _new, _bad]'),
    '};',
    '_out',
  ].join(' ');
}

export interface EditSqfArgs {
  ops: EditOp[];
  neighborRadius: number;
  key: string;
}

/**
 * 있는 엔티티를 옮기고, 돌리고, 이름을 바꾸고, 지운다. 한 호출이 실행 취소 한 단계다.
 * 반환: [행 수, 쪽수, 첫 쪽, [바꾼 수, 지운 수, 못 찾은 id 들]]. 지운 것은 행이 없다.
 */
export function buildEditSqf(a: EditSqfArgs): string {
  const ops =
    '[' +
    a.ops
      .map((o) => {
        const pos = o.pos ? `[${sqfNumber(o.pos[0])},${sqfNumber(o.pos[1])}]` : '[]';
        const dir = o.dir === null ? '-1' : sqfNumber(o.dir);
        // 이름을 바꾸지 않으면 문자열이 아닌 0 을 보낸다(SQF 가 isEqualType "" 로 가른다).
        const name = o.name === null ? '0' : sqfString(o.name);
        return `[${sqfNumber(Math.trunc(o.id))},${pos},${dir},${zArgs(o.z)},${name},${o.delete ? 'true' : 'false'}]`;
      })
      .join(',') +
    ']';
  return [
    GUARD,
    'private _out = [];',
    'isNil {',
    PRELUDE,
    SETTLE,
    CENTER,
    ROTATE,
    'private _ed = []; private _del = []; private _miss = [];',
    'collect3DENHistory {' +
      '{_x params ["_id","_xy","_d","_zk","_zv","_nm","_rm"]; private _e = get3DENEntity _id; ' +
      'if (isNil "_e" || {_e isEqualTo objNull} || {_e isEqualTo ""} || {(get3DENEntityID _e) != _id}) then {_miss pushBack _id} else {' +
      'if (_rm) then {_del pushBack _e} else {private _k = [_e] call _kindOf; ' +
      'if (count _xy > 1) then {private _p = [_e, "position", getPosATL _e] call _attr; _e set3DENAttribute ["position", [_xy select 0, _xy select 1, _p param [2, 0]]]}; ' +
      'if (_d >= 0) then {[_e, _k, _d] call _rot}; ' +
      'if (_nm isEqualType "" && {_k != "marker"}) then {_e set3DENAttribute ["name", _nm]}; ' +
      '_ed pushBack [_e, _k, _zk, _zv, _xy]}}} forEach ' +
      ops +
      '; ' +
      '{_x params ["_e","_k","_zk","_zv","_w"]; [_e, _k, _w] call _center; [_e, _k, _zk, _zv] call _settle} forEach _ed; ' +
      'if (_del isNotEqualTo []) then {delete3DENEntities _del};' +
      '};',
    'private _T = _ed apply {_x select 0};',
    `private _rows = _ed apply {[_x select 0, _x select 1, ${RF.target}] call _row};`,
    a.neighborRadius > 0 ? neighbors(a.neighborRadius) : '',
    finish(a.key, '[count _ed, count _del, _miss]'),
    '};',
    '_out',
  ].join(' ');
}

/** 에디터 실행 취소를 n 번. 반환: ["OK", n]. */
export function buildUndoSqf(n: number): string {
  const k = Math.max(1, Math.min(50, Math.trunc(n)));
  return `${GUARD} for "_i" from 1 to ${k} do {do3DENAction "Undo"}; ["OK", ${k}]`;
}

// ---------------------------------------------------------------- 자산 목록 (arma_eden_find)

/** 에디터 자산 패널의 종류. group 은 CfgGroups 편성, marker 는 CfgMarkers 다. */
export type AssetKind = 'unit' | 'vehicle' | 'object' | 'module' | 'group' | 'marker';
export const ASSET_KINDS: readonly AssetKind[] = ['unit', 'vehicle', 'object', 'module', 'group', 'marker'];
/** 자산 행의 열 순서. */
export const ASSET_ROW = ['kind', 'class', 'label', 'path', 'side', 'flags', 'score'] as const;
/** 자산 행 flags 비트. is3DEN 은 Eden 속성 창을 쓰는 모듈(config is3DEN = 1), zeus 는 Zeus 목록에도 있는 것(scopeCurator 2). */
export const AF = { is3DEN: 1, zeus: 2 } as const;

/**
 * 에디터 자산 패널 색인을 uiNamespace(AHC_MCP_ea)에 만든다. 모드 구성은 게임을 다시 켜야 바뀌므로 게임 동안 캐시한다.
 * Zeus 색인(zeusSqf 의 PALETTE_INDEX)과 기준이 다르다. Zeus 는 scopeCurator 2 를 담고, 에디터는 scope 2 를 담는다.
 * 그래서 에디터에만 있는 모듈이 들어가고 Zeus 전용 모듈은 빠진다.
 * 경로: 유닛과 차량은 세력 > editorSubcategory, 물체는 editorCategory > editorSubcategory, 모듈은 category.
 * 진영: 유닛과 차량은 config side, 물체는 EMPTY(에디터의 빈 물체 탭). 표시 이름은 이 게임의 언어다.
 * 색인 행: [kind, class, 표시 이름, 경로, side, flags].
 */
const ASSET_INDEX =
  'private _ea = uiNamespace getVariable ["AHC_MCP_ea", []]; if (_ea isEqualTo []) then {' +
  'private _sn = ["EAST","WEST","GUER","CIV"]; ' +
  'private _dn = {params ["_cfg","_n"]; if (_n == "") exitWith {""}; getText (configFile >> _cfg >> _n >> "displayName")}; ' +
  '{private _c = _x; private _cl = configName _c; ' +
  'private _kd = if (_cl isKindOf "Logic") then {"module"} else {if (_cl isKindOf "CAManBase") then {"unit"} else {if (_cl isKindOf "AllVehicles") then {"vehicle"} else {"object"}}}; ' +
  'private _sub = ["CfgEditorSubcategories", getText (_c >> "editorSubcategory")] call _dn; ' +
  'private _pa = if (_kd == "module") then {["CfgFactionClasses", getText (_c >> "category")] call _dn} else {' +
  'private _top = if (_kd == "object") then {["CfgEditorCategories", getText (_c >> "editorCategory")] call _dn} else {["CfgFactionClasses", getText (_c >> "faction")] call _dn}; ' +
  'if (_sub == "") then {_top} else {_top + " > " + _sub}}; ' +
  'private _sx = if (_kd in ["unit","vehicle"]) then {_sn param [getNumber (_c >> "side"), ""]} else {["", "EMPTY"] select (_kd == "object")}; ' +
  `_ea pushBack [_kd, _cl, getText (_c >> "displayName"), _pa, _sx, ${AF.is3DEN} * (parseNumber (getNumber (_c >> "is3DEN") > 0)) + ${AF.zeus} * (parseNumber (getNumber (_c >> "scopeCurator") == 2))]` +
  '} forEach ("getNumber (_x >> ""scope"") == 2" configClasses (configFile >> "CfgVehicles")); ' +
  '{private _sdc = _x; {private _fc = _x; {private _ca = _x; {' +
  '_ea pushBack ["group", format ["%1|%2|%3|%4", configName _sdc, configName _fc, configName _ca, configName _x], ' +
  'getText (_x >> "name"), getText (_fc >> "name") + " > " + getText (_ca >> "name"), _sn param [getNumber (_x >> "side"), ""], 0]' +
  '} forEach ("true" configClasses _ca)} forEach ("true" configClasses _fc)} forEach ("true" configClasses _sdc)} forEach ("true" configClasses (configFile >> "CfgGroups")); ' +
  '{_ea pushBack ["marker", configName _x, getText (_x >> "name"), getText (configFile >> "CfgMarkerClasses" >> getText (_x >> "markerClass") >> "displayName"), "", 0]} ' +
  'forEach ("getNumber (_x >> ""scope"") == 2" configClasses (configFile >> "CfgMarkers")); ' +
  'uiNamespace setVariable ["AHC_MCP_ea", _ea]};';

export interface AssetsSqfArgs {
  query: string;
  kinds: AssetKind[];
  /** WEST, EAST, GUER, CIV, EMPTY 또는 빈 문자열(모두). */
  side: string;
  limit: number;
  key: string;
}

/**
 * 에디터 자산 패널에서 이름으로 찾는다. 점수는 Zeus palette 와 같다(표시 이름, 클래스, 경로).
 * 반환: [합계, 쪽수, 첫 쪽 행 배열, [게임 언어, 색인 크기]]. 행은 ASSET_ROW.
 */
export function buildAssetsSqf(a: AssetsSqfArgs): string {
  return [
    GUARD,
    queryPrelude(a.query),
    `private _K = ${sqfStringArray(a.kinds)}; private _sd = ${sqfString(a.side)}; private _lim = ${Math.trunc(a.limit)};`,
    CUT,
    SCORE,
    'private _out = [];',
    'isNil {',
    ASSET_INDEX,
    'private _rows = []; {_x params ["_kd","_cl","_lb","_pa","_sx"]; ' +
      'if ((count _K == 0 || {_kd in _K}) && {_sd == "" || {_sx == _sd}}) then {' +
      'private _s = [[_lb, _cl, _pa]] call _sc; if (_s > 0) then {_rows pushBack (_x + [_s])}}} forEach _ea;',
    sortAndLimit(6, -1),
    paginate([3], 2),
    storePages(a.key),
    '_out = [_total, count _pages, _pages select 0, [language, count _ea]];',
    '};',
    '_out',
  ].join(' ');
}

// ---------------------------------------------------------------- 카메라

/**
 * 에디터 카메라를 옮긴다. 처음 옮길 때 원래 자리를 AHC_MCP_edenCam 에 둔다(buildCameraRestoreSqf 가 되돌린다).
 * BI 의 fn_3DENCamera 처럼 get3DENCamera 에 setPosASL 과 setVectorDirAndUp 을 쓴다.
 */
export function buildCameraSqf(pos: readonly number[], dir: readonly number[], up: readonly number[]): string {
  const v = (a: readonly number[]): string => '[' + a.map((n) => sqfNumber(n)).join(',') + ']';
  return (
    `${GUARD} private _c = get3DENCamera; if (isNull _c) exitWith {["NOCAM"]}; ` +
    'if (isNil "AHC_MCP_edenCam") then {AHC_MCP_edenCam = [getPosASL _c, vectorDir _c, vectorUp _c]}; ' +
    `_c setPosASL ${v(pos)}; _c setVectorDirAndUp [${v(dir)}, ${v(up)}]; ["OK"]`
  );
}

/** 카메라를 처음 자리로 되돌린다. */
export function buildCameraRestoreSqf(): string {
  return (
    `${GUARD} private _c = get3DENCamera; if (isNull _c || {isNil "AHC_MCP_edenCam"}) exitWith {["NONE"]}; ` +
    'AHC_MCP_edenCam params ["_p","_d","_u"]; _c setPosASL _p; _c setVectorDirAndUp [_d, _u]; AHC_MCP_edenCam = nil; ["OK"]'
  );
}

/**
 * 점들이 지금 화면 어디에 있는지. 반환: ["OK", [[id, x, y], ...]]. x, y 는 화면 폭과 높이에 대한 0~1 비율 문자열이다.
 * 화면 밖이나 카메라 뒤면 빈 문자열이다. worldToScreen 은 AGL 을 받는다.
 */
export function buildProjectSqf(points: readonly { id: number; pos: readonly number[] }[]): string {
  const list =
    '[' + points.map((p) => `[${sqfNumber(Math.trunc(p.id))},[${p.pos.map((n) => sqfNumber(n)).join(',')}]]`).join(',') + ']';
  return (
    `${GUARD} ["OK", ${list} apply {_x params ["_id","_p"]; private _s = worldToScreen (ASLToAGL _p); ` +
    'if (_s isEqualTo []) then {[_id, "", ""]} else {' +
    '[_id, (((_s select 0) - safeZoneX) / safeZoneW) toFixed 3, (((_s select 1) - safeZoneY) / safeZoneH) toFixed 3]}}]'
  );
}

/** 지형 높이 하나(카메라가 땅속으로 들어가지 않게). 반환: ["OK", "z"]. */
export function buildTerrainSqf(x: number, y: number): string {
  return `${GUARD} ["OK", (getTerrainHeightASL [${sqfNumber(x)},${sqfNumber(y)}]) toFixed 2]`;
}
