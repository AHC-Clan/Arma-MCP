// safeSpawn.ts — 스캐폴드 미션이 바다나 공중에서 시작하지 않게 한다.
//
// 두 가지를 한다.
//  1) position 을 SQF getPos 순서 [동, 북, 높이] 로 받아 mission.sqm 의
//     [동, 고도, 북] 순서로 변환한다. 이 순서 혼동이 공중 스폰의 직접 원인이었다.
//     옛 규약 그대로 [3000,4000,0] 을 넣으면 고도 4000m 에 스폰했다.
//  2) init.sqf 앞에 보정 프렐류드를 붙인다. 미션이 시작되면 플레이어가 물 위나
//     공중에 있는지 보고 육지 지면으로 옮긴다.
//
// 프렐류드는 지형별 좌표 테이블을 쓰지 않는다. worldSize, surfaceIsWater,
// getTerrainHeightASL, BIS_fnc_findSafePos 만 쓰므로 모드 맵에서도 같게 동작한다.
// 애드온(@arma_mcp)에도 의존하지 않는다 — 생성된 미션은 바닐라에서 자립해야 한다.
//
// 미션 init.sqf 는 엔진이 preprocessFile 하므로 주석을 써도 된다.
// compile 만 하는 arma_exec 경로와 다르다(src/exec/sanitize.ts 주석 참고).

import { sqfNumber } from '../mcp/sqfLiteral.js';

export type SafeSpawnMode = 'off' | 'ground' | 'land';

export const SAFE_SPAWN_MODES = ['off', 'ground', 'land'] as const;

/** 프렐류드가 RPT 에 남기는 줄의 접두어. arma_rpt_search 로 찾는다. */
export const SAFE_SPAWN_LOG_PREFIX = '[arma-mcp][safeSpawn]';
/** 보정 상태를 담는 미션 변수. pending 에서 ok, moved, skip, failed 중 하나로 끝난다. */
export const SAFE_SPAWN_VAR = 'arma_mcp_safeSpawn';
/** 보정 후 최종 좌표를 담는 미션 변수. */
export const SAFE_SPAWN_POS_VAR = 'arma_mcp_safeSpawnPos';

/** 알려진 어떤 Arma 3 지형보다 큰 값. Altis 가 30720 이다. */
export const WORLD_COORD_MAX = 51200;
/** 이보다 큰 높이는 옛 sqm 순서로 호출했다는 통계적 징후다. */
export const SUSPICIOUS_HEIGHT = 1000;

export interface PositionPlan {
  /** 사용자가 요청한 값 [동, 북, 높이]. 음수 높이는 0 으로 보정된 뒤의 값이다. */
  requested: [number, number, number];
  /** mission.sqm 에 그대로 쓸 값 [동, 고도, 북]. */
  sqm: [number, number, number];
  /** 프렐류드가 육지를 찾을 때 쓸 원점. null 이면 런타임이 맵 중앙을 쓴다. */
  wantXY: [number, number] | null;
  warnings: string[];
}

export interface NormalizeContext {
  world: string;
  safeSpawn: SafeSpawnMode;
}

function assertCoord(value: number, axis: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`position: ${axis} 가 유한한 수가 아니다 (${value})`);
  }
  if (value < 0) {
    throw new Error(`position: ${axis} 가 음수다 (${value}) — 월드 좌표는 0 이상이다`);
  }
  if (value > WORLD_COORD_MAX) {
    throw new Error(
      `position: ${axis} 가 ${WORLD_COORD_MAX} 를 넘는다 (${value}) — ` +
        '알려진 어떤 지형보다 크다. [동, 북, 높이] 순서인지 확인하라',
    );
  }
}

/**
 * position 입력을 검증하고 mission.sqm 순서로 변환한다.
 *
 * 입력은 [동, 북] 또는 [동, 북, 높이] 다. SQF getPos 와 같은 순서이며
 * mission.sqm 의 [동, 고도, 북] 이 아니다.
 */
export function normalizePosition(
  input: readonly number[] | undefined,
  ctx: NormalizeContext,
): PositionPlan {
  const warnings: string[] = [];
  const isVR = ctx.world.toUpperCase() === 'VR';

  if (input === undefined) {
    if (ctx.safeSpawn === 'off' && !isVR) {
      warnings.push(
        'position 을 지정하지 않았고 safeSpawn 이 off 다 — 지형 남서쪽 모서리에서 시작한다. ' +
          '대부분의 지형에서 바다다.',
      );
    }
    return { requested: [0, 0, 0], sqm: [0, 0, 0], wantXY: null, warnings };
  }

  if (input.length !== 2 && input.length !== 3) {
    throw new Error(
      `position: 원소가 ${input.length} 개다 — [동, 북] 또는 [동, 북, 높이] 여야 한다`,
    );
  }

  const east = input[0] as number;
  const north = input[1] as number;
  assertCoord(east, '동(첫 번째 값)');
  assertCoord(north, '북(두 번째 값)');

  let height = input.length === 3 ? (input[2] as number) : 0;
  if (!Number.isFinite(height)) {
    throw new Error(`position: 높이가 유한한 수가 아니다 (${height})`);
  }
  if (height < 0) {
    warnings.push(`position 의 높이 ${height} m 가 음수라 0 으로 보정했다.`);
    height = 0;
  }
  if (height > SUSPICIOUS_HEIGHT) {
    warnings.push(
      `position 의 높이가 ${height} m 다. 파라미터 순서는 [동, 북, 높이] 이고 ` +
        'mission.sqm 의 [동, 고도, 북] 이 아니다. 옛 순서로 호출했다면 값을 바꿔라.',
    );
  }
  if (height > 0 && ctx.safeSpawn !== 'off') {
    warnings.push(
      `safeSpawn 이 ${ctx.safeSpawn} 이라 요청한 높이 ${height} m 는 런타임에 지면으로 내려간다. ` +
        '공중 시작을 원하면 safeSpawn 을 off 로 두어라.',
    );
  }
  if (east === 0 && north === 0 && !isVR) {
    warnings.push(
      'position [0, 0] 은 지형 남서쪽 모서리다. 대부분의 지형에서 바다다.' +
        (ctx.safeSpawn === 'land'
          ? ' safeSpawn 이 land 라 미션 시작 시 육지로 옮긴다.'
          : ' safeSpawn 이 land 가 아니라 가로 보정을 하지 않는다.'),
    );
  }
  if (ctx.safeSpawn === 'off' && warnings.length > 0) {
    warnings.push('safeSpawn 이 off 라 자동 보정이 없다. 위 경고를 직접 처리해야 한다.');
  }

  return {
    requested: [east, north, height],
    // mission.sqm 의 PositionInfo::position[] 은 [동, 고도, 북] 순서다.
    sqm: [east, height, north],
    wantXY: [east, north],
    warnings,
  };
}

/**
 * init.sqf 앞에 붙일 보정 프렐류드를 만든다.
 *
 * 생성기가 채우는 것은 _mode 와 _want 두 줄뿐이고 나머지는 고정 텍스트다.
 */
export function buildSafeSpawnSqf(opts: {
  mode: 'ground' | 'land';
  want: readonly [number, number] | null;
  /** 플레이어 슬롯 수. 여럿이면 옮긴 자리를 슬롯 순번만큼 동쪽으로 벌린다. */
  slots?: number;
}): string {
  const wantLiteral = opts.want
    ? `[${sqfNumber(opts.want[0])},${sqfNumber(opts.want[1])}]`
    : '[]';
  // 가로 탐색은 land 모드에만 넣는다. ground 모드는 가로 좌표를 유지하는 것이 계약이라
  // 탐색 코드가 파일에 남아 있으면 계약을 읽는 사람이 헷갈린다.
  const landHelpers =
    opts.mode === 'land'
      ? `
    // _this = [동, 북] 을 중심으로 동심원을 훑어 첫 육지점을 돌려준다. 못 찾으면 [].
    // 바깥 forEach 의 _x 를 _r 로 먼저 붙잡는다. _isLand 안에도 forEach 가 있다.
    private _scan = {
        private _cx = _this select 0;
        private _cy = _this select 1;
        private _hit = [];
        {
            private _r = _x;
            if (_hit isEqualTo []) then {
                private _n = if (_r < 1) then {1} else {24};
                for "_i" from 0 to (_n - 1) do {
                    if (_hit isEqualTo []) then {
                        private _a = (_i * 360 / _n) + (_r mod 360);
                        private _p = [_cx + _r * (sin _a), _cy + _r * (cos _a)] call _clamp;
                        if (_p call _isLand) then { _hit = _p };
                    };
                };
            };
        } forEach [0, 60, 150, 300, 600, 1200, 2400, 4800, 9600, 19200, 38400];
        _hit
    };

    // 검색 원점. 요청 좌표가 있으면 그 좌표, 없으면 맵 중앙.
    private _origin = if ((count _want) >= 2) then {
        [_want select 0, _want select 1] call _clamp
    } else {
        [_size / 2, _size / 2]
    };
`
      : '';
  const landBranch =
    opts.mode === 'land'
      ? `
                        if (_wet) then {
                            private _hit = _origin call _scan;
                            if (_hit isEqualTo []) then {
                                // 스캔이 실패할 만큼 특이한 지형이면 엔진 유틸에 맡긴다.
                                // 실패 시 defaultPos 인 [-1,-1] 이 돌아오므로 음수로 가려낸다.
                                private _fb = [[_size / 2, _size / 2], 0, _size / 2, 8, 0, 0.4, 0, [], [-1,-1]] call BIS_fnc_findSafePos;
                                if (((_fb select 0) >= 0) && {(_fb select 1) >= 0}) then {
                                    _hit = [_fb select 0, _fb select 1] call _clamp;
                                };
                            };
                            if (!(_hit isEqualTo [])) then { _dst = _hit };
                        };
`
      : '';
  // 여러 슬롯이 한 점으로 옮겨져 겹쳐 서지 않게 한다. 슬롯 유닛 이름(mcp_slot_<순번>)에서 순번을 읽는다.
  // 슬롯이 하나면 넣지 않아 0.4 와 같은 파일이 된다. ground 모드는 가로 좌표를 지키므로 넣지 않는다.
  const slotBranch =
    (opts.slots ?? 1) > 1 && opts.mode === 'land'
      ? `
                        if (((vehicleVarName _u) find "mcp_slot_") == 0) then {
                            private _slot = parseNumber ((vehicleVarName _u) select [9]);
                            _dst = [(_dst select 0) + 3 * _slot, _dst select 1];
                        };
`
      : '';
  return `// arma-mcp safe spawn — 바다와 공중 스폰 보정 (arma_scaffold_mission 이 생성)
//
// 미션이 시작되면 이 기계에서 local 인 플레이어 유닛이 물 위나 공중에 있는지 보고
// 육지 지면으로 옮긴다. 지형별 좌표 테이블을 쓰지 않아 모드 맵에서도 같게 동작한다.
//
// 결과는 RPT 에 한 줄로 남는다.
//   ${SAFE_SPAWN_LOG_PREFIX} result=moved reason=air from=[..] to=[..] land=true damage=0
// 보정이 끝나기를 기다리려면 이렇게 쓴다.
//   waitUntil { (missionNamespace getVariable ["${SAFE_SPAWN_VAR}", "pending"]) != "pending" };
//
// 이 파일은 엔진이 preprocessFile 하므로 주석을 써도 된다.

missionNamespace setVariable ["${SAFE_SPAWN_VAR}", "pending"];

[] spawn {
    private _mode = "${opts.mode}";
    private _want = ${wantLiteral};

    private _t0 = diag_tickTime;
    private _size = worldSize;
    if (!(_size > 0)) then { _size = 8192 };
    private _margin = 200 min (_size / 8);
    private _airLimit = 3;

    // _this = [동, 북]. 좌표를 맵 안쪽으로 물린다.
    private _clamp = {
        [
            ((((_this select 0) max _margin) min (_size - _margin))),
            ((((_this select 1) max _margin) min (_size - _margin)))
        ]
    };

    // _this = [동, 북]. 물이 아니고 해수면 위이며 주변 14m 도 물이 아니면 육지로 본다.
    // VR 은 지형 높이가 0 이고 물이 아니므로 항상 육지가 된다(-0.5 가 그 여유다).
    private _isLand = {
        private _c = [_this select 0, _this select 1];
        private _ok = !(surfaceIsWater _c) && {(getTerrainHeightASL _c) > -0.5};
        if (_ok) then {
            {
                if (_ok && {surfaceIsWater [(_c select 0) + (_x select 0), (_c select 1) + (_x select 1)]}) then {
                    _ok = false;
                };
            } forEach [[14,0],[-14,0],[0,14],[0,-14]];
        };
        _ok
    };

${landHelpers}
    // 데디케이트 서버의 init.sqf 에는 player 가 없다. hasInterface 로 가른다.
    // 서버는 자기에게 local 인 플레이어블 유닛(플레이어 0명일 때의 AI)만 맡는다.
    // 사람이 잡은 슬롯은 그 클라이언트에 local 이라 서버가 건드리지 않는다.
    private _units = [];
    if (hasInterface) then {
        private _deadline = diag_tickTime + 30;
        waitUntil { (!isNull player && {player == player}) || diag_tickTime > _deadline };
        if (!isNull player) then { _units pushBackUnique (vehicle player) };
    };
    if (isServer) then {
        {
            if (local _x) then { _units pushBackUnique (vehicle _x) };
        } forEach (playableUnits + switchableUnits);
    };

    if (_units isEqualTo []) exitWith {
        missionNamespace setVariable ["${SAFE_SPAWN_VAR}", "skip"];
        diag_log text format [
            "${SAFE_SPAWN_LOG_PREFIX} result=skip reason=no-local-unit mode=%1 world=%2 hasInterface=%3 isServer=%4 elapsed=%5",
            _mode, worldName, hasInterface, isServer, round ((diag_tickTime - _t0) * 100) / 100
        ];
    };

    private _overall = "ok";
    {
        private _u = vehicle _x;
        private _from = getPosATL _u;
        private _why = [];
        private _moved = false;
        private _result = "ok";

        if (_u isKindOf "Air") then {
            _result = "skip";
            _why pushBack "air-vehicle";
        } else {
            // 낙하 피해를 막는다. allowDamage 를 쓰면 사용자 initSqf 의 설정을 덮으므로
            // 되돌릴 수 있는 HandleDamage 로 막고 끝나면 뗀다.
            private _eh = _u addEventHandler ["HandleDamage", {0}];

            // 최대 3패스. 다른 초기화 코드가 좌표를 되돌려도 다시 잡는다.
            // for 안의 exitWith 는 루프 전체를 끊으므로 플래그로 제어한다.
            private _settled = false;
            for "_pass" from 1 to 3 do {
                if (!_settled) then {
                    private _p = getPosATL _u;
                    private _p2 = [_p select 0, _p select 1];
                    private _z = _p select 2;

                    private _wet = !(_p2 call _isLand);
                    // isTouchingGround 는 거부권으로만 쓴다. 옥상 스폰을 공중으로 오판하지 않게.
                    private _high = (_z > _airLimit) && {!(isTouchingGround _u)};
                    private _under = _z < -1;

                    if (!(_wet || _high || _under)) then {
                        _settled = true;
                    } else {
                        if (_wet) then { _why pushBackUnique "water" };
                        if (_high) then { _why pushBackUnique "air" };
                        if (_under) then { _why pushBackUnique "underground" };

                        private _dst = _p2;
${landBranch}${slotBranch}
                        // setPos 는 속도를 지우지 않는다. 낙하 중이면 앞뒤로 두 번 지운다.
                        _u setVelocity [0, 0, 0];
                        if (!(_dst call _isLand)) then {
                            // 여전히 물이면 해저가 아니라 해수면에 둔다.
                            _u setPosASL [_dst select 0, _dst select 1, 0];
                        } else {
                            _u setPosATL [_dst select 0, _dst select 1, 0];
                        };
                        _u setVelocity [0, 0, 0];
                        _moved = true;
                        _result = "moved";
                        sleep 0.35;
                    };
                };
            };

            if (_moved) then {
                // 착지까지(최대 3초) 피해 차단을 유지한다.
                private _hold = diag_tickTime + 3;
                waitUntil { (isTouchingGround _u) || diag_tickTime > _hold };
                sleep 0.3;
            };
            _u removeEventHandler ["HandleDamage", _eh];
        };

        private _to = getPosATL _u;
        private _t2 = [_to select 0, _to select 1];
        if ((_mode isEqualTo "land") && {!(_t2 call _isLand)}) then { _result = "failed" };
        if ((_result isEqualTo "moved") && (_overall isEqualTo "ok")) then { _overall = "moved" };
        if (_result isEqualTo "failed") then { _overall = "failed" };

        missionNamespace setVariable ["${SAFE_SPAWN_POS_VAR}", _to];
        diag_log text format [
            "${SAFE_SPAWN_LOG_PREFIX} result=%1 reason=%2 mode=%3 world=%4 worldSize=%5 from=[%6,%7,%8] to=[%9,%10,%11] land=%12 water=%13 damage=%14 elapsed=%15",
            _result,
            (if (_why isEqualTo []) then {"none"} else {_why joinString "+"}),
            _mode, worldName, _size,
            round (_from select 0), round (_from select 1), round ((_from select 2) * 10) / 10,
            round (_to select 0), round (_to select 1), round ((_to select 2) * 10) / 10,
            (_t2 call _isLand), (surfaceIsWater _t2),
            round ((damage _u) * 100) / 100,
            round ((diag_tickTime - _t0) * 100) / 100
        ];
    } forEach _units;

    missionNamespace setVariable ["${SAFE_SPAWN_VAR}", _overall];
};
`;
}

/**
 * 프렐류드와 사용자 init.sqf 를 합친다.
 *
 * 순서는 항상 프렐류드가 먼저다. 사용자 코드를 앞에 두면 사용자의 #define 이
 * 프렐류드 식별자를 치환하고, 사용자 첫 줄의 전처리기 지시어가 열 0 을 잃는다.
 * mode 가 off 면 사용자 코드와 바이트 동일이다.
 */
export function buildInitSqf(
  userInit: string,
  opts: { mode: SafeSpawnMode; want: readonly [number, number] | null; slots?: number },
): string {
  if (opts.mode === 'off') return userInit;
  const prelude = buildSafeSpawnSqf({ mode: opts.mode, want: opts.want, slots: opts.slots });
  return prelude.endsWith('\n') ? prelude + userInit : `${prelude}\n${userInit}`;
}
