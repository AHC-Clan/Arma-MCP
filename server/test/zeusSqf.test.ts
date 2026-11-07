// zeusSqf.test.ts: Zeus 툴 조립 SQF 의 계약(게임 불필요).
//
// 조립 SQF 는 compile 만 되고 preprocess 되지 않는다. 주석이 섞이면 조용히 <nil> 로 깨지고,
// SafeArray 가 개행을 공백으로 바꾸므로 개행에 기대면 안 된다. 사용자 문자열은 sqfString 으로만 들어간다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSqf } from '../src/exec/sanitize.js';
import { sqfString } from '../src/mcp/sqfLiteral.js';
import {
  buildCuratorAddSqf,
  buildDetectSqf,
  buildFindSqf,
  buildModuleObserveSqf,
  buildModuleRunSqf,
  buildPageSqf,
  buildPaletteSqf,
  MISSION_ROW,
  PAGE_BUDGET,
  PALETTE_ROW,
  type FindSqfArgs,
} from '../src/zeus/zeusSqf.js';

function findArgs(over: Partial<FindSqfArgs> = {}): FindSqfArgs {
  return {
    source: 'mission',
    query: '알파 1-1',
    kinds: [],
    side: '',
    zeusOnly: false,
    near: null,
    limit: 20,
    key: 'zf_abcd1234_x_1',
    ...over,
  };
}

function assertContract(code: string, endsWith: RegExp): void {
  assert.equal(sanitizeSqf(code, 'strip').changed, false, '조립 SQF 에 주석이 섞였다');
  assert.ok(!/[\r\n]/.test(code), '조립 SQF 가 개행에 기댄다');
  assert.match(code.trimEnd(), endsWith);
  assert.ok(Buffer.byteLength(code) < 12000, `조립 SQF 가 너무 크다: ${Buffer.byteLength(code)}`);
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      if (inStr && code[i + 1] === '"') {
        i++;
        continue;
      }
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth--;
    assert.ok(depth >= 0, `괄호가 먼저 닫힌다: ${code.slice(Math.max(0, i - 40), i + 1)}`);
  }
  assert.equal(depth, 0, '괄호 짝이 맞지 않는다');
  assert.equal(inStr, false, '문자열이 닫히지 않았다');
}

test('detect: curator 에 배정된 플레이어 목록을 배열로 돌려준다', () => {
  const code = buildDetectSqf();
  assertContract(code, /\]$/);
  assert.match(code, /allCurators/);
  assert.match(code, /getAssignedCuratorUnit/);
});

test('find mission: 수집과 페이지 나누기를 isNil 안에서 하고 첫 쪽만 돌려준다', () => {
  const code = buildFindSqf(findArgs({ kinds: ['unit', 'group'], side: 'WEST', near: [100, 200] }));
  assertContract(code, /_out$/);
  assert.match(code, /isNil \{/);
  assert.match(code, /allUnits/);
  assert.match(code, /allMissionObjects "Module_F"/);
  assert.match(code, /BIS_fnc_netId/);
  assert.match(code, /AHC_MCP_pg set \["zf_abcd1234_x_1"/);
  assert.ok(code.includes(`> ${PAGE_BUDGET}`), '페이지 예산이 SQF 에 박혀야 한다');
  assert.match(code, /private _K = \["unit","group"\]/);
  assert.match(code, /\[100,200,0\]/);
  assert.equal(MISSION_ROW.indexOf('score'), 15);
  assert.equal(MISSION_ROW.indexOf('dist'), 16);
});

test('find selected: curatorSelected 를 쓰고 Zeus 카메라 거리 정렬을 고를 수 있다', () => {
  const code = buildFindSqf(findArgs({ source: 'selected', query: '', near: 'camera', zeusOnly: true }));
  assertContract(code, /_out$/);
  assert.match(code, /curatorSelected/);
  assert.match(code, /curatorCamera/);
  assert.ok(!code.includes('allMissionObjects'), 'selected 는 맵 전체를 훑지 않는다');
});

test('find: 사용자 문자열은 SQF 문자열 리터럴로만 들어간다', () => {
  const evil = 'x"; deleteVehicle player; "';
  const code = buildFindSqf(findArgs({ query: evil }));
  assertContract(code, /_out$/);
  assert.ok(code.includes(`toLower ${sqfString(evil)}`));
  const comment = buildFindSqf(findArgs({ query: 'a // b /* c' }));
  assert.equal(sanitizeSqf(comment, 'strip').changed, false, '문자열 안의 // 는 주석이 아니다');
});

test('palette: curatorAddons 색인을 미션 동안 캐시하고 모듈 창 여부를 본다', () => {
  const code = buildPaletteSqf({ query: '소총수', kinds: ['unit'], side: '', limit: 10, key: 'zf_k' });
  assertContract(code, /_out$/);
  assert.match(code, /if \(isNil "AHC_MCP_zp"\)/);
  assert.match(code, /curatorAddons _cur/);
  assert.match(code, /scopeCurator/);
  assert.match(code, /CfgGroups/);
  assert.match(code, /zen_dialog_fnc_create/);
  assert.equal(PALETTE_ROW.indexOf('score'), 6);
});

test('page: 마지막 쪽에서만 보관 키를 지운다', () => {
  const mid = buildPageSqf('zf_k', 1, false);
  const last = buildPageSqf('zf_k', 2, true);
  assertContract(mid, /\]$/);
  assertContract(last, /\]$/);
  assert.ok(!mid.includes('deleteAt'));
  assert.match(last, /AHC_MCP_pg deleteAt "zf_k"/);
  assert.match(last, /_p param \[2, \[\]\]/);
});

test('module run: Zeus 배치 순서(그룹 표시, 생성, 커서 대상, 부착)를 isNil 안에서 지킨다', () => {
  const code = buildModuleRunSqf({ module: '주변 10m 완전 치료', target: '2:345', pos: null, dryRun: false, key: 'zm_k' });
  assertContract(code, /_out$/);
  const at = (s: string): number => {
    const i = code.indexOf(s);
    assert.ok(i >= 0, `빠졌다: ${s}`);
    return i;
  };
  const isNil = at('isNil {');
  const mark = at('_g setVariable ["isCuratorModuleGroup", true, true]');
  const create = at('_g createUnit [_cls, _p, [], 0, "CAN_COLLIDE"]');
  const over = at('bis_fnc_curatorObjectPlaced_mouseOver =');
  const attach = at('_m setVariable ["bis_fnc_curatorAttachObject_object", _t, true]');
  const attachTo = at('_m attachTo [_t, [0, 0, 2 + count _ao]]');
  assert.ok(isNil < mark && mark < create && create < over && over < attach && attach < attachTo);
  assert.match(code, /AHC_MCP_zm set \["zm_k"/);
  assert.match(code, /screenToWorld \[0\.5,0\.5\]/);
  assert.match(code, /"AMBIG"/);
});

test('module dryRun: 해석만 하고 아무것도 만들지 않는다', () => {
  const code = buildModuleRunSqf({ module: 'ModuleLightning_F', target: '', pos: [10, 20], dryRun: true, key: 'zm_k' });
  assertContract(code, /_out$/);
  assert.ok(!code.includes('createUnit'));
  assert.ok(!code.includes('createGroup'));
  assert.match(code, /"DRY"/);
  assert.match(code, /\[10,20,0\]/);
});

test('module observe 와 curator 추가', () => {
  const obs = buildModuleObserveSqf('zm_k');
  assertContract(obs, /\]$/);
  assert.match(obs, /AHC_MCP_zm deleteAt "zm_k"/);
  assert.match(obs, /allDisplays/);
  const add = buildCuratorAddSqf('2:345', 'Alice "A"');
  assertContract(add, /\]$/);
  assert.match(add, /addCuratorEditableObjects \[\[_o\], false\]/);
  assert.ok(add.includes(sqfString('Alice "A"')));
});
