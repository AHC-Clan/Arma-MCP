// sqfWrap.ts — 서버가 조립하는 SQF 래퍼 빌더 + 결과 파서.
//
// 왜 래핑하는가: fn_execRun 의 가드는 `call` 레벨이라 엔진 타입 오류(`round <배열>`,
// `taskState "<문자열>"`)를 잡지 못한다. 그런 오류는 스폰된 스크립트 자체를 종료시키므로
// fn_execResultIn 이 실행되지 않고 결과 프레임이 아예 나가지 않는다 — 서버는 전체
// timeoutMs 를 태운 뒤 "no result (timed out)" 을 보고한다(실측 10건, 건당 30초).
// 자식 spawn 안에서 돌리면 죽는 것은 자식뿐이고, 부모는 결과 상자가 비었다는 사실로
// 실패를 즉시 판정할 수 있다.
//
// 조립 규칙 (sqfLiteral.ts 와 동일):
//  - 주석 금지. exec 경로는 compile 만 하고 preprocess 하지 않는다.
//  - 개행 의존 금지. SafeArray.cpp 가 \r\n\t 를 공백으로 바꾼 뒤 parseSimpleArray 에 넘긴다.
//  - 사용자 코드는 SQF 문자열 리터럴로 심고 인게임에서 compile 한다. 리터럴로 심기 전에
//    반드시 먼저 sanitize 해야 한다 — 나중에 하면 sanitizeSqf 가 리터럴 내부를 건너뛰므로
//    주석이 살아남아 compile 이 조용히 <nil> 로 파손된다.
//
// 인게임 2.10+ 기능 의존: createHashMap / set / getOrDefault / deleteAt / keys.
// 그 외는 전부 2.02 이하 명령이다.

import { sqfNumber, sqfString } from '../mcp/sqfLiteral.js';

/** 워치 상태 레지스트리 전역 이름 — 정지 신호도 여기로 들어간다. */
export const WATCH_REGISTRY = 'AHC_MCP_watch';

/** 결과 문자열이 500자 인게임 캡에 걸리지 않게 잡은 샘플 1건 길이. */
const SAMPLE_CHARS = 40;
/** 마지막 샘플은 조금 더 길게 보여준다(원인 추적용). */
const LAST_SAMPLE_CHARS = 60;

export interface WatchSqfArgs {
  /** 이미 sanitize 된 조건식 소스. */
  condition: string;
  /** 이미 sanitize 된 샘플식 소스. 빈 문자열이면 샘플링하지 않는다. */
  sample: string;
  /** 이 워치를 식별할 키(정지 신호용). */
  watchId: string;
  intervalMs: number;
  timeoutMs: number;
  maxSamples: number;
}

/**
 * 인게임 폴링 루프. 조건이 참이 되면 즉시, 아니면 타임아웃/정지 신호에 한 번만 반환한다.
 *
 * 반복마다 spawn 하지 않고 루프 전체를 한 번만 spawn 한다 — 자식은 공유 HASHMAP(참조
 * 의미)에 진행 상황을 쓰고, 부모는 scriptDone 으로 종료를 감지한다. 조건식이 하드 에러를
 * 내면 자식이 죽어 out 이 비므로 부모가 1~2프레임 만에 threw 로 판정한다.
 *
 * sleep 이 아니라 uiSleep 을 쓴다 — 라이브 미션의 setAccTime 변경에 영향받지 않는다.
 * 루프 본문에는 exitWith 를 쓰지 않는다(while/forEach 안에서 의미가 모호하다) —
 * 종료는 while 조건의 센티널 문자열로 처리한다.
 */
export function buildWatchSqf(a: WatchSqfArgs): string {
  const wid = sqfString(a.watchId);
  const cond = sqfString(a.condition);
  const smp = sqfString(a.sample);
  const has = a.sample ? 'true' : 'false';
  const ivl = sqfNumber(a.intervalMs / 1000);
  const deadline = sqfNumber(a.timeoutMs / 1000);
  // 인게임 하드 예산은 논리 마감보다 2초 길게 — 항상 루프가 먼저 끝나 구조화된
  // reason 이 돌아오고, 서버 타임아웃(반환값 없음)으로 떨어지지 않는다.
  const budget = sqfNumber(a.timeoutMs / 1000 + 2);
  const maxs = sqfNumber(a.maxSamples);

  return [
    `if (isNil "${WATCH_REGISTRY}") then { ${WATCH_REGISTRY} = createHashMap };`,
    `private _st = createHashMap;`,
    `${WATCH_REGISTRY} set [${wid}, _st];`,
    `private _b = createHashMap;`,
    `private _t0 = diag_tickTime;`,
    `private _h = [_b, _st, ${cond}, ${smp}, ${has}, ${ivl}, ${deadline}, ${maxs}] spawn {`,
    `params ["_b","_st","_cs","_ss","_has","_ivl","_dl","_maxs"];`,
    `private _c = compile _cs;`,
    `private _s = if (_has) then { compile _ss } else { {} };`,
    `private _end = diag_tickTime + _dl;`,
    `private _n = 0; private _out = ""; private _sam = [];`,
    `_b set ["sam", _sam];`,
    `while { _out isEqualTo "" && diag_tickTime < _end && !(_st getOrDefault ["stop", false]) } do {`,
    `_n = _n + 1; _b set ["n", _n];`,
    `if (_has) then {`,
    `_b set ["ph","sample"];`,
    `private _sv = [] call _s;`,
    `private _t = if (isNil "_sv") then { "<nil>" } else { format ["%1: %2", typeName _sv, str _sv] };`,
    `_b set ["last", _t select [0,${LAST_SAMPLE_CHARS}]];`,
    `if (count _sam < (_maxs - 1)) then { _sam pushBack (_t select [0,${SAMPLE_CHARS}]) }`,
    `else { _b set ["drop", (_b getOrDefault ["drop",0]) + 1] };`,
    `};`,
    `_b set ["ph","cond"];`,
    `private _cv = [] call _c;`,
    `if (isNil "_cv") then { _out = "nil" } else {`,
    `if !(_cv isEqualType true) then { _out = "type:" + typeName _cv } else {`,
    `if (_cv) then { _out = "met" } else { uiSleep _ivl };`,
    `};`,
    `};`,
    `};`,
    `if (_out isEqualTo "") then {`,
    `_out = if (_st getOrDefault ["stop", false]) then { "stopped" } else { "timeout" };`,
    `};`,
    `_b set ["out", _out];`,
    `};`,
    `private _hard = diag_tickTime + ${budget};`,
    `waitUntil { scriptDone _h || diag_tickTime > _hard };`,
    `if (!scriptDone _h) then { terminate _h };`,
    `${WATCH_REGISTRY} deleteAt ${wid};`,
    // 앞 maxSamples-1 개와 마지막 값을 돌려준다. 충족 순간의 값이 마지막 샘플이다.
    `private _sam = +(_b getOrDefault ["sam",[]]);`,
    `private _drop = _b getOrDefault ["drop",0];`,
    `if (${maxs} > 0 && _drop > 0) then { _sam pushBack (_b getOrDefault ["last",""]); _drop = _drop - 1 };`,
    `private _txt = "";`,
    `{ _txt = _txt + (if (_txt isEqualTo "") then {""} else {" ~ "}) + _x } forEach _sam;`,
    `format ["WATCH|%1|%2|%3|%4|%5|%6",`,
    `_b getOrDefault ["out", "threw:" + (_b getOrDefault ["ph","?"])],`,
    `_b getOrDefault ["n",0],`,
    `round ((diag_tickTime - _t0) * 1000),`,
    `count _sam,`,
    `_drop,`,
    `_txt]`,
  ].join(' ');
}

/** 특정 워치(또는 전체)에 정지 신호를 넣는다. 대상이 없어도 오류가 아니다. */
export function buildWatchStopSqf(watchId: string | null): string {
  if (watchId === null) {
    return [
      `if (isNil "${WATCH_REGISTRY}") exitWith { "OK:0" };`,
      `private _k = keys ${WATCH_REGISTRY};`,
      `{ (${WATCH_REGISTRY} get _x) set ["stop", true] } forEach _k;`,
      `format ["OK:%1", count _k]`,
    ].join(' ');
  }
  return [
    `if (isNil "${WATCH_REGISTRY}") exitWith { "OK:0" };`,
    `private _t = ${WATCH_REGISTRY} getOrDefault [${sqfString(watchId)}, createHashMap];`,
    `_t set ["stop", true];`,
    `format ["OK:%1", count ${WATCH_REGISTRY}]`,
  ].join(' ');
}

/** verify 래퍼가 각 단계에 주는 기본 제한(초). 넘기면 그 단계만 ABORT 로 접는다. */
const VERIFY_STEP_SEC = 5;
/** 인게임 500자 캡 안에 두 값 + 헤더가 들어가게 잡은 상한. */
const VERIFY_MAIN_CHARS = 380;
const VERIFY_ACK_CHARS = 100;

export interface VerifySqfArgs {
  /** 이미 sanitize 된 본문 소스. */
  code: string;
  /** 이미 sanitize 된 증거식 소스. */
  verify: string;
  /** 각 단계 제한(초). 기본 5. */
  stepSec?: number;
}

/**
 * 본문과 증거식을 각각 자식 spawn 에서 돌리고 두 결과를 한 프레임으로 되돌린다.
 *
 * 왜 필요한가: 지금까지 관측된 30초 타임아웃 10건은 전부 마지막 검증식의 타입 오류였다.
 * (`round <배열>`, `taskState "<문자열>"`) 그런 오류는 fn_execRun 의 call 가드를 뚫고
 * 스폰된 스크립트 전체를 죽이므로 결과 프레임이 아예 나가지 않는다 — 변이는 이미
 * 성공했는데도 서버는 전체 timeoutMs 를 태운다. 자식 spawn 이면 죽는 건 자식뿐이다.
 *
 * 부수 효과로 본문도 격리되므로, 본문의 타입 오류 역시 풀 타임아웃을 태우지 않는다.
 *
 * 두 단계는 별개 스크립트라 지역변수를 공유하지 않는다. 교차 상태는 전역으로 넘겨야 한다.
 * 래핑된 본문 안에서 `_this` 는 `[]` 다(`[] call _c` 로 고정) — 예측 가능하게 두기 위함이다.
 */
export function buildVerifySqf(a: VerifySqfArgs): string {
  const sec = sqfNumber(a.stepSec ?? VERIFY_STEP_SEC);
  const step = (src: string, key: string): string =>
    [
      `private _r_${key} = [_b, ${sqfString(src)}, "${key}"] spawn {`,
      `params ["_b","_s","_k"];`,
      `private _c = compile _s;`,
      `if (isNil "_c") exitWith { _b set [_k, "ERROR: parse failed (see RPT)"] };`,
      `if !(_c isEqualType {}) exitWith { _b set [_k, "ERROR: parse failed (see RPT)"] };`,
      `private _r = [] call _c;`,
      `_b set [_k, if (isNil "_r") then { "<nil> (if unexpected, check RPT for ""Error in expression"")" }`,
      `else { format ["%1: %2", typeName _r, str _r] }];`,
      `};`,
      `if !([_r_${key}, ${sec}] call _w) then { _b set ["${key}", "ERROR: step timeout"] };`,
    ].join(' ');

  return [
    `private _b = createHashMap;`,
    `private _t0 = diag_tickTime;`,
    `private _w = { params ["_h","_sec"]; private _d = diag_tickTime + _sec;`,
    `waitUntil { scriptDone _h || diag_tickTime > _d };`,
    `if (scriptDone _h) then { true } else { terminate _h; false } };`,
    step(a.code, 'm'),
    step(a.verify, 'v'),
    `private _m = (_b getOrDefault ["m", "ERROR: aborted (see RPT)"]) select [0,${VERIFY_MAIN_CHARS}];`,
    `private _v = (_b getOrDefault ["v", "ERROR: aborted (see RPT)"]) select [0,${VERIFY_ACK_CHARS}];`,
    // 길이 접두 — 두 값 모두 `|` 를 포함할 수 있으므로 구분자로 나눌 수 없다.
    `format ["MCPV|%1|%2|%3%4", round ((diag_tickTime - _t0) * 1000), count toArray _m, _m, _v]`,
  ].join(' ');
}

export interface VerifyParsed {
  main: string;
  verify: string;
  gameElapsedMs: number;
  mainTruncated: boolean;
  verifyTruncated: boolean;
}

/**
 * `MCPV|elapsedMs|mainCodePoints|<main><verify>` 를 되꺼낸다.
 *
 * 본문 길이는 코드포인트 수다 — String.slice(=UTF-16 단위)로 자르면 astral 문자에서
 * 어긋난다. 한글은 BMP 라 실무상 같지만 일반적으로 옳은 쪽을 쓴다.
 */
export function parseVerifyAck(ack: string | null): VerifyParsed | null {
  if (!ack || !ack.startsWith('MCPV|')) return null;
  const rest = ack.slice('MCPV|'.length);
  const firstBar = rest.indexOf('|');
  if (firstBar < 0) return null;
  const secondBar = rest.indexOf('|', firstBar + 1);
  if (secondBar < 0) return null;
  const elapsed = Number.parseInt(rest.slice(0, firstBar), 10);
  const mainLen = Number.parseInt(rest.slice(firstBar + 1, secondBar), 10);
  if (!Number.isFinite(mainLen) || mainLen < 0) return null;
  const body = Array.from(rest.slice(secondBar + 1));
  const main = body.slice(0, mainLen).join('');
  const verify = body.slice(mainLen).join('');
  return {
    main,
    verify,
    gameElapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
    mainTruncated: Array.from(main).length >= VERIFY_MAIN_CHARS,
    verifyTruncated: Array.from(verify).length >= VERIFY_ACK_CHARS,
  };
}

export type WatchReason =
  | 'met'
  | 'timeout'
  | 'stopped'
  | 'nil'
  | 'threw:cond'
  | 'threw:sample'
  | 'hung'
  | string;

export interface WatchParsed {
  met: boolean;
  reason: WatchReason;
  iterations: number;
  gameElapsedMs: number;
  sampleCount: number;
  samplesDropped: number;
  samples: string[];
}

/**
 * `WATCH|out|n|elapsedMs|sampleCount|drop|trail` 을 되꺼낸다.
 * trail 은 마지막 필드이므로 " ~ " 로만 다시 나눈다 — 샘플 값에 `|` 가 들어가도 안전하다.
 */
export function parseWatchAck(ack: string | null): WatchParsed | null {
  if (!ack || !ack.startsWith('WATCH|')) return null;
  const rest = ack.slice('WATCH|'.length);
  const parts: string[] = [];
  let cursor = 0;
  // 앞 5개 필드는 `|` 를 포함하지 않는 토큰/정수다. 나머지 전체가 trail.
  for (let f = 0; f < 5; f += 1) {
    const at = rest.indexOf('|', cursor);
    if (at < 0) return null;
    parts.push(rest.slice(cursor, at));
    cursor = at + 1;
  }
  const trail = rest.slice(cursor);
  const num = (s: string | undefined): number => {
    const v = Number.parseInt(s ?? '', 10);
    return Number.isFinite(v) ? v : 0;
  };
  const reason = parts[0] ?? 'hung';
  return {
    met: reason === 'met',
    reason,
    iterations: num(parts[1]),
    gameElapsedMs: num(parts[2]),
    sampleCount: num(parts[3]),
    samplesDropped: num(parts[4]),
    samples: trail === '' ? [] : trail.split(' ~ '),
  };
}
