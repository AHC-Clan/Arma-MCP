// sqfWrap.test.ts — 서버가 조립하는 SQF 래퍼의 불변식.
//
// 여기서 지키는 계약:
//  1) 조립 결과에 주석이 없다. exec 경로는 compile 만 하므로 주석 하나가 남으면
//     전체가 조용히 <nil> 로 파손된다.
//  2) 개행에 의존하지 않는다. SafeArray.cpp 가 \r\n\t 를 공백으로 바꾼다.
//  3) 사용자 코드는 문자열 리터럴로 정확히 왕복한다(따옴표 doubling 포함).
//  4) ack 파서가 값 안의 `|` 에 흔들리지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWatchSqf,
  buildWatchStopSqf,
  parseWatchAck,
  buildVerifySqf,
  parseVerifyAck,
} from '../src/exec/sqfWrap.js';
import { sanitizeSqf } from '../src/exec/sanitize.js';

const base = {
  condition: 'count allUnits > 0',
  sample: '',
  watchId: 'w_test_1',
  intervalMs: 250,
  timeoutMs: 30000,
  maxSamples: 8,
};

test('buildWatchSqf: 주석 없음 + 개행 없음', () => {
  const sqf = buildWatchSqf(base);
  // sanitize 가 아무것도 제거하지 않아야 한다 = 주석이 애초에 없다.
  assert.equal(sanitizeSqf(sqf, 'strip').changed, false);
  assert.equal(sanitizeSqf(sqf, 'strip').removedComments, 0);
  assert.ok(!/\r|\n|\t/.test(sqf), '개행/탭이 들어가면 안 된다');
});

test('buildWatchSqf: 샘플이 넘치면 앞 maxSamples-1 개와 마지막 값을 돌려준다', () => {
  // 충족 순간의 값은 마지막 반복의 샘플이다. 앞에서부터만 쌓으면 이 값이 버려진다.
  const sqf = buildWatchSqf({ ...base, sample: 'E2E_DONE', maxSamples: 8 });
  assert.ok(sqf.includes('if (count _sam < (_maxs - 1)) then'), '앞쪽은 maxSamples-1 개까지 쌓는다');
  assert.ok(sqf.includes('_b set ["last", _t select [0,'), '매 틱 마지막 값을 기억한다');
  assert.ok(
    sqf.includes('if (8 > 0 && _drop > 0) then { _sam pushBack (_b getOrDefault ["last",""]); _drop = _drop - 1 };'),
    '넘쳤으면 마지막 값을 붙이고 버린 개수에서 뺀다',
  );
  // maxSamples 0 이면 마지막 값도 붙이지 않는다.
  assert.ok(buildWatchSqf({ ...base, sample: 'x', maxSamples: 0 }).includes('if (0 > 0 && _drop > 0)'));
  assert.equal(sanitizeSqf(sqf, 'strip').changed, false);
});

test('buildWatchSqf: 사용자 코드는 문자열 리터럴로 정확히 왕복한다', () => {
  // 따옴표가 들어간 조건식 — SQF 리터럴에서는 doubling 으로 이스케이프된다.
  const sqf = buildWatchSqf({
    ...base,
    condition: 'str (missionNamespace getVariable ["x", 0]) == "done"',
    sample: 'name (allPlayers select 0)',
  });
  assert.ok(
    sqf.includes('"str (missionNamespace getVariable [""x"", 0]) == ""done"""'),
    '따옴표는 doubling 으로 이스케이프되어야 한다',
  );
  assert.ok(sqf.includes('"name (allPlayers select 0)"'));
  // 이스케이프 후에도 주석 판정에 걸리지 않는다.
  assert.equal(sanitizeSqf(sqf, 'strip').changed, false);
});

test('buildWatchSqf: 문자열 안의 // 가 주석으로 오인되지 않는다', () => {
  // 조립 전에 조각을 먼저 sanitize 하는 게 계약이지만, 리터럴 내부의 // 는
  // 정당한 값이므로 조립 후 sanitize 에서도 살아남아야 한다.
  const url = 'someVar == "http://example.com"';
  const sqf = buildWatchSqf({ ...base, condition: url });
  assert.ok(sqf.includes('http://example.com'));
  assert.equal(sanitizeSqf(sqf, 'strip').changed, false);
});

test('buildWatchSqf: 숫자 파라미터가 초 단위로 들어가고 하드 예산이 더 길다', () => {
  const sqf = buildWatchSqf({ ...base, intervalMs: 500, timeoutMs: 10000 });
  assert.ok(sqf.includes(', 0.5, 10, 8]'), 'interval=0.5s, deadline=10s');
  // 인게임 하드 예산 = deadline + 2초. 루프가 항상 먼저 끝나야 구조화된 reason 이 나온다.
  assert.ok(sqf.includes('diag_tickTime + 12'), '하드 예산은 deadline+2s');
});

test('buildWatchSqf: 루프 본문에 exitWith 를 쓰지 않는다', () => {
  // while/forEach 안의 exitWith 는 의미가 모호하다 — 종료는 센티널 문자열로.
  const sqf = buildWatchSqf(base);
  assert.ok(!sqf.includes('exitWith'), '워치 래퍼에는 exitWith 가 없어야 한다');
  assert.ok(sqf.includes('uiSleep'), 'sleep 이 아니라 uiSleep (setAccTime 면역)');
});

test('buildWatchStopSqf: 단일/전체 정지', () => {
  const one = buildWatchStopSqf('w_test_1');
  assert.ok(one.includes('"w_test_1"'));
  assert.ok(one.includes('set ["stop", true]'));
  assert.equal(sanitizeSqf(one, 'strip').changed, false);

  const all = buildWatchStopSqf(null);
  assert.ok(all.includes('keys AHC_MCP_watch'));
  assert.ok(all.includes('forEach'));
  assert.equal(sanitizeSqf(all, 'strip').changed, false);
});

test('parseWatchAck: 정상 ack', () => {
  const p = parseWatchAck('WATCH|met|3|1240|2|0|SCALAR: 1 ~ SCALAR: 2');
  assert.ok(p);
  assert.equal(p.met, true);
  assert.equal(p.reason, 'met');
  assert.equal(p.iterations, 3);
  assert.equal(p.gameElapsedMs, 1240);
  assert.equal(p.sampleCount, 2);
  assert.equal(p.samplesDropped, 0);
  assert.deepEqual(p.samples, ['SCALAR: 1', 'SCALAR: 2']);
});

test('parseWatchAck: 샘플 값에 | 가 있어도 앞 필드가 어긋나지 않는다', () => {
  // trail 은 마지막 필드이므로 앞 5개만 `|` 로 끊고 나머지는 통째로 가져간다.
  const p = parseWatchAck('WATCH|timeout|20|5000|1|3|STRING: "a|b|c"');
  assert.ok(p);
  assert.equal(p.reason, 'timeout');
  assert.equal(p.met, false);
  assert.equal(p.iterations, 20);
  assert.equal(p.samplesDropped, 3);
  assert.deepEqual(p.samples, ['STRING: "a|b|c"']);
});

test('parseWatchAck: threw / 빈 trail / 형식 불일치', () => {
  const threw = parseWatchAck('WATCH|threw:cond|2|80|0|0|');
  assert.ok(threw);
  assert.equal(threw.reason, 'threw:cond');
  assert.equal(threw.met, false);
  assert.deepEqual(threw.samples, []);

  const typed = parseWatchAck('WATCH|type:SCALAR|1|40|0|0|');
  assert.equal(typed?.reason, 'type:SCALAR');

  assert.equal(parseWatchAck(null), null);
  assert.equal(parseWatchAck('SCALAR: 2'), null);
  assert.equal(parseWatchAck('WATCH|met|1'), null, '필드가 모자라면 null');
});

test('buildVerifySqf: 주석·개행 없음 + 자식 spawn 2개', () => {
  const sqf = buildVerifySqf({ code: 'doStuff', verify: 'count allUnits' });
  assert.equal(sanitizeSqf(sqf, 'strip').changed, false);
  assert.ok(!/\r|\n|\t/.test(sqf));
  assert.equal((sqf.match(/spawn \{/g) ?? []).length, 2);
  // 본문의 _this 는 [] 로 고정한다 — 래핑 여부와 무관하게 예측 가능해야 한다.
  assert.ok(sqf.includes('[] call _c'));
});

test('parseVerifyAck: 길이 접두로 두 값을 정확히 가른다', () => {
  const main = 'BOOL: true';
  const ack = 'SCALAR: 3';
  const p = parseVerifyAck(`MCPV|42|${main.length}|${main}${ack}`);
  assert.ok(p);
  assert.equal(p.main, main);
  assert.equal(p.verify, ack);
  assert.equal(p.gameElapsedMs, 42);
});

test('parseVerifyAck: 값 안의 | 와 한글이 경계를 흔들지 않는다', () => {
  // 구분자 기반 분할이었다면 여기서 어긋난다.
  const main = 'STRING: "a|b|c"';
  const ack = 'STRING: "완료|확인"';
  const p = parseVerifyAck(`MCPV|7|${[...main].length}|${main}${ack}`);
  assert.ok(p);
  assert.equal(p.main, main);
  assert.equal(p.verify, ack);
});

test('parseVerifyAck: 형식 불일치는 null', () => {
  assert.equal(parseVerifyAck(null), null);
  assert.equal(parseVerifyAck('SCALAR: 2'), null);
  assert.equal(parseVerifyAck('MCPV|12'), null);
});
