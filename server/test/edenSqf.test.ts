// edenSqf.test.ts: Eden 툴 조립 SQF 의 계약(게임 불필요).
//
// zeusSqf.test.ts 와 같은 계약이다. 조립 SQF 는 compile 만 되고 preprocess 되지 않아 주석이 섞이면
// 조용히 <nil> 로 깨지고, SafeArray 가 개행을 공백으로 바꾸므로 개행에 기대면 안 된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSqf } from '../src/exec/sanitize.js';
import {
  ASSET_ROW,
  buildAssetsSqf,
  buildCameraRestoreSqf,
  buildCameraSqf,
  buildClassSqf,
  buildEditSqf,
  buildPlaceSqf,
  buildProjectSqf,
  buildSceneSqf,
  buildTerrainSqf,
  buildUndoSqf,
  GEOM,
  ROW,
} from '../src/eden/edenSqf.js';

function assertContract(code: string, endsWith: RegExp): void {
  assert.equal(sanitizeSqf(code, 'strip').changed, false, '조립 SQF 에 주석이 섞였다');
  assert.ok(!/[\r\n]/.test(code), '조립 SQF 가 개행에 기댄다');
  assert.match(code.trimEnd(), endsWith);
  assert.ok(Buffer.byteLength(code) < 16000, `조립 SQF 가 너무 크다: ${Buffer.byteLength(code)}`);
  assert.ok(code.startsWith('if (!is3DEN) exitWith {["NOEDEN"]};'), '에디터 밖에서는 아무것도 하지 않아야 한다');
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

const sceneArgs = {
  ids: [],
  kinds: [],
  query: '',
  layer: '',
  near: null,
  radius: 1e9,
  selected: false,
  limit: 30,
  key: 'es_abcd_x_1',
};

test('scene: 계약을 지키고 사용자 문자열을 이스케이프한다', () => {
  const code = buildSceneSqf({ ...sceneArgs, query: 'say "hi"', layer: '경비"초소', near: [1234.5, 6789.25], radius: 50, kinds: ['vehicle'] });
  assertContract(code, /_out$/);
  assert.ok(code.includes('toLower "say ""hi"""'));
  assert.ok(code.includes('"경비""초소"'));
  assert.ok(code.includes('[1234.5,6789.25]'));
  assert.ok(code.includes('["vehicle"]'));
  assert.ok(code.includes('_cand sort true'));
});

test('scene: 선택만 볼 때는 에디터 선택을 원천으로 쓴다', () => {
  const sel = buildSceneSqf({ ...sceneArgs, selected: true });
  assert.ok(sel.includes('private _src = _S;'));
  const all = buildSceneSqf({ ...sceneArgs, ids: [3, 4.7] });
  assert.ok(all.includes('private _ids = [3,4];'));
});

test('행과 geom 열 순서가 문서와 같다', () => {
  assert.deepEqual([...ROW], ['id', 'kind', 'class', 'name', 'layer', 'geom', 'flags']);
  assert.equal(GEOM.length, 12);
  assert.equal(GEOM[8], 'gapMin');
});

test('class: 크기는 지역 단순 물체로 재고 지운다', () => {
  const code = buildClassSqf({ classes: [['Land_CncBarrier_F', 'Object'], ['hd_dot', 'Marker']], key: 'ec_x' });
  assertContract(code, /_out$/);
  assert.ok(code.includes('createSimpleObject [_c, [0, 0, 2000], true]'));
  assert.ok(code.includes('deleteVehicle _o'));
  assert.ok(code.includes('[["Land_CncBarrier_F","Object"],["hd_dot","Marker"]]'));
  assert.ok(!code.includes('configClasses'), '후보 찾기는 자산 색인(buildAssetsSqf)이 한다');
});

test('assets: 에디터 기준(scope 2) 색인을 게임 동안 캐시하고 Zeus 색인과 섞지 않는다', () => {
  const code = buildAssetsSqf({ query: 'say "hi"', kinds: ['module', 'group'], side: 'WEST', limit: 20, key: 'ea_x' });
  assertContract(code, /_out$/);
  assert.ok(code.includes('toLower "say ""hi"""'));
  assert.ok(code.includes('["module","group"]'));
  assert.ok(code.includes('private _sd = "WEST"'));
  assert.ok(code.includes('"getNumber (_x >> ""scope"") == 2" configClasses (configFile >> "CfgVehicles")'));
  assert.ok(code.includes('uiNamespace setVariable ["AHC_MCP_ea", _ea]'));
  assert.ok(code.includes('CfgGroups') && code.includes('CfgMarkers'));
  assert.ok(!code.includes('AHC_MCP_zp'), 'Zeus palette 색인을 쓰지 않는다');
  assert.ok(!code.includes('curatorAddons'));
  assert.deepEqual([...ASSET_ROW], ['kind', 'class', 'label', 'path', 'side', 'flags', 'score']);
});

test('place: 한 실행 취소 단계 안에서 만들고 높이와 방향을 맞춘다', () => {
  const code = buildPlaceSqf({
    items: [
      { mode: 'Object', class: 'Land_CncBarrier_F', pos: [100.5, 200.25], dir: 90, z: { kind: 'ground' }, name: '' },
      { mode: 'Object', class: 'Land_Can_V3_F', pos: [100, 200], dir: 0, z: { kind: 'on', ref: 12 }, name: 'can"1' },
      { mode: 'Marker', class: 'hd_dot', pos: [1, 2], dir: 45, z: { kind: 'asl', z: 3.5 }, name: '' },
    ],
    select: true,
    neighborRadius: 8,
    key: 'ep_x',
  });
  assertContract(code, /_out$/);
  assert.ok(code.includes('collect3DENHistory {'));
  assert.ok(code.includes('create3DENEntity [_m, _c, [_xy select 0, _xy select 1, 0], true]'));
  assert.ok(code.includes('["Object","Land_CncBarrier_F",[100.5,200.25],90,"ground",0,""]'));
  assert.ok(code.includes('"on",12,"can""1"]'));
  assert.ok(code.includes('"asl",3.5'));
  assert.ok(code.includes('set3DENSelected'));
  assert.ok(code.includes('nearestTerrainObjects'));
  // 원점이 아니라 상자 중심을 pos 에 맞추고, 그 뒤 높이를 맞춘다.
  assert.ok(code.includes('[_e, _k, _w] call _center; [_e, _k, _zk, _zv] call _settle'));
  const quiet = buildPlaceSqf({ items: [], select: false, neighborRadius: 0, key: 'ep_y' });
  assert.ok(!quiet.includes('set3DENSelected'));
  assert.ok(!quiet.includes('nearestTerrainObjects'));
});

test('edit: 옮기기, 돌리기, 이름, 지우기를 한 단계로', () => {
  const code = buildEditSqf({
    ops: [
      { id: 5, pos: [10, 20], dir: null, z: { kind: 'ground' }, name: null, delete: false },
      { id: 6, pos: null, dir: 180, z: { kind: 'keep' }, name: '', delete: false },
      { id: 7, pos: null, dir: null, z: { kind: 'keep' }, name: null, delete: true },
    ],
    neighborRadius: 8,
    key: 'ee_x',
  });
  assertContract(code, /_out$/);
  assert.ok(code.includes('[5,[10,20],-1,"ground",0,0,false]'));
  assert.ok(code.includes('[6,[],180,"keep",0,"",false]'));
  assert.ok(code.includes('[7,[],-1,"keep",0,0,true]'));
  assert.ok(code.includes('delete3DENEntities _del'));
  assert.ok(code.includes('[_e, _k, _w] call _center'), '옮길 때도 상자 중심을 맞춘다');
});

test('카메라, 투영, 지형, 실행 취소', () => {
  assertContract(buildCameraSqf([1, 2, 3], [0, 0, -1], [0, 1, 0]), /\["OK"\]$/);
  assertContract(buildCameraRestoreSqf(), /\["OK"\]$/);
  assertContract(buildProjectSqf([{ id: 3, pos: [1, 2, 3] }]), /\]$/);
  assertContract(buildTerrainSqf(1, 2), /\]$/);
  const undo = buildUndoSqf(99);
  assertContract(undo, /\["OK", 50\]$/);
  assert.ok(undo.includes('do3DENAction "Undo"'));
});
