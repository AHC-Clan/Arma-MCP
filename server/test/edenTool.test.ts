// edenTool.test.ts: arma_eden_* 의 흐름(게임 불필요).
//
// zeusTool.test.ts 와 같은 FakeGateway 다. 보낸 exec 코드를 보고 바로 결과를 돌려준다.
// 실제 ExecManager 를 쓰므로 페이지 이어 받기와 단계 순서가 서버 쪽 경로 그대로 돈다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecManager } from '../src/exec/execManager.js';
import { createSessionContext } from '../src/mcp/session.js';
import { runEdenEdit, runEdenFind, runEdenLook, runEdenPlace, runEdenScene } from '../src/mcp/tools/eden.js';
import type { Gateway } from '../src/ipc/gateway.js';
import type { Deps } from '../src/mcp/deps.js';

class FakeGateway extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  constructor(private reply: (code: string) => string | null) {
    super();
  }
  send(frame: Record<string, unknown>): boolean {
    this.sent.push(frame);
    const r = this.reply(String(frame.code ?? ''));
    if (r) {
      setImmediate(() =>
        this.emit('execResult', { v: 1, type: 'execResult', reqId: frame.reqId, machine: 'server', result: r }),
      );
    }
    return true;
  }
  isConnected(): boolean {
    return true;
  }
}

function makeDeps(reply: (code: string) => string | null, editor: boolean | null = true): { gateway: FakeGateway; deps: Deps } {
  const gateway = new FakeGateway(reply);
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-eden-tool-'));
  const exec = new ExecManager(
    gateway as unknown as Gateway,
    rptDir,
    { defaultTimeoutMs: 5000, maxCodeBytes: 131072 },
    () => null,
  );
  const session = createSessionContext('relay', 'abcd1234-0000-0000-0000-000000000000');
  const deps = {
    exec,
    session,
    gateway,
    cfg: { mcp: { disableTools: [] } },
    telemetry: { current: () => ({ world: 'Stratis', mission: '', editor, multiplayer: false, dedicated: false }) },
    rptSources: { resolve: () => ({ source: 'server', dir: rptDir, re: /\.rpt$/i }) },
  } as unknown as Deps;
  return { gateway, deps };
}

const isScene = (c: string): boolean => c.includes('_cand sort true');
const isClass = (c: string): boolean => c.includes('createSimpleObject');
const isPlace = (c: string): boolean => c.includes('create3DENEntity');
const isEdit = (c: string): boolean => c.includes('delete3DENEntities');
const isAssets = (c: string): boolean => c.includes('AHC_MCP_ea');
const isPage = (c: string): boolean => c.startsWith('private _p = (missionNamespace getVariable ["AHC_MCP_pg"');

/** 상자 2x4x2 m, 바닥 10 m 인 물체 행. */
const ROW = (id: number, x: number, y: number, flags: number, gap = '0.00,0.02'): string =>
  `[${id},"object","Land_CncBarrier_F","","Layer 1","${x.toFixed(2)},${y.toFixed(2)},11.00,0.00,1.00,2.00,1.00,10.00,${gap},0.00,0.00",${flags}]`;

test('에디터가 아니면 게임에 아무것도 보내지 않는다', async () => {
  const { gateway, deps } = makeDeps(() => null, false);
  const r = await runEdenScene(deps, {});
  assert.equal(r.ok, false);
  assert.match(String(r.error), /Eden 에디터에서만/);
  assert.equal(gateway.sent.length, 0);
  const old = makeDeps(() => null, null);
  const r2 = await runEdenPlace(old.deps, { items: [{ class: 'X', at: [0, 0] }] });
  assert.match(String(r2.error), /에디터 표시/);
  assert.equal(old.gateway.sent.length, 0);
});

test('scene: 쪽을 이어 받아 판정을 붙이고 서로 겹친 상자를 알린다', async () => {
  const { gateway, deps } = makeDeps((code) => {
    if (isPage(code)) return `ARRAY: [2,[${ROW(2, 101, 100, 2, '0.40,0.45')}]]`;
    if (isScene(code)) return `ARRAY: [2,2,[${ROW(1, 100, 100, 6)}],[2,1]]`;
    return null;
  });
  const r = await runEdenScene(deps, { near: [100, 100] });
  assert.equal(r.ok, true);
  assert.equal(r.matched, 2);
  const ents = r.entities as Record<string, unknown>[];
  assert.equal(ents.length, 2);
  assert.deepEqual(ents[0], {
    id: 1,
    kind: 'object',
    class: 'Land_CncBarrier_F',
    layer: 'Layer 1',
    at: [100, 100],
    dir: 0,
    size: [2, 4, 2],
    z: { bottom: 10, attr: 0 },
    ground: 'ground',
    selected: true,
  });
  assert.equal(ents[1]!.ground, 'floating 0.4');
  assert.deepEqual(r.overlaps, [{ a: 1, b: 2, depth: 1 }]);
  assert.equal(gateway.sent.length, 2);
});

test('place: ref 를 재고, 클래스를 확인하고, 옆에 놓을 자리를 풀어 한 번에 만든다', async () => {
  let placeCode = '';
  const { deps } = makeDeps((code) => {
    if (isScene(code)) return `ARRAY: [1,1,[${ROW(7, 100, 100, 2)}],[1,0]]`;
    if (isClass(code)) return 'ARRAY: [1,1,[["Land_Can_V3_F",1,"0.10,0.10,0.10",""]],[]]';
    if (isPlace(code)) {
      placeCode = code;
      return `ARRAY: [2,1,[${ROW(20, 100, 102.1, 10)},[0,"map","t_pinus.p3d","","","100.00,102.50,11.00,0.00,0.50,0.50,1.00,10.00,0.00,0.00,0.00,0.00",2]],[1,[]]]`;
    }
    return null;
  });
  const r = await runEdenPlace(deps, { items: [{ class: 'Land_Can_V3_F', beside: { id: 7, side: 'front' } }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  // ref 상자 앞(+Y)으로 반길이 2 + 캔 0.1 = 2.1 m.
  assert.ok(placeCode.includes('["Object","Land_Can_V3_F",[100,102.1],0,"ground",0,""]'), placeCode.slice(0, 400));
  const created = r.created as Record<string, unknown>[];
  assert.equal(created.length, 1);
  assert.equal(created[0]!.id, 20);
  assert.deepEqual(r.overlaps, [{ a: 20, b: 'map:t_pinus.p3d', depth: 1.5 }]);
  assert.match(String(r.note), /실행 취소 한 단계/);
});

test('place: 없는 클래스는 만들지 않고 자산 색인에서 후보를 돌려준다', async () => {
  let assetCode = '';
  const { gateway, deps } = makeDeps((code) => {
    if (isClass(code)) return 'ARRAY: [1,1,[["B_MRAP_01",0,""]],[]]';
    if (isAssets(code)) {
      assetCode = code;
      return 'ARRAY: [2,1,[["vehicle","B_MRAP_01_F","Hunter","NATO > Cars","WEST",0,60],["vehicle","B_MRAP_01_gmg_F","Hunter GMG","NATO > Cars","WEST",0,60]],["Korean",9000]]';
    }
    return null;
  });
  const r = await runEdenPlace(deps, { items: [{ class: 'B_MRAP_01', at: [1, 2] }] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, [{ class: 'B_MRAP_01', candidates: ['B_MRAP_01_F', 'B_MRAP_01_gmg_F'] }]);
  assert.ok(assetCode.includes('toLower "B_MRAP_01"'));
  assert.ok(assetCode.includes('["unit","vehicle","object"]'), '물체 type 은 유닛, 차량, 물체에서 찾는다');
  assert.match(String(r.hint), /arma_eden_find/);
  assert.ok(!gateway.sent.some((f) => isPlace(String(f.code))));
});

test('find: 자산 행을 place 에 넣을 모양으로 돌려준다', async () => {
  const { deps } = makeDeps((code) =>
    isAssets(code)
      ? 'ARRAY: [3,1,[' +
        '["object","Land_CampingTable_F","캠핑 테이블","Things > Furniture","EMPTY",0,40],' +
        '["module","ModuleHideTerrainObjects_F","Hide Terrain Objects","Environment","",1,40],' +
        '["group","West|BLU_F|Infantry|BUS_InfSquad","Rifle Squad","NATO > Infantry","WEST",0,25]' +
        '],["Korean",9000]]'
      : null,
  );
  const r = await runEdenFind(deps, { query: '테이블' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.language, 'Korean');
  const rows = r.results as Record<string, unknown>[];
  assert.deepEqual(rows[0], {
    kind: 'object',
    label: '캠핑 테이블',
    class: 'Land_CampingTable_F',
    path: 'Things > Furniture',
    side: 'EMPTY',
    place: { class: 'Land_CampingTable_F' },
    score: 40,
  });
  assert.equal(rows[1]!.is3DEN, true);
  assert.equal(rows[1]!.zeus, false);
  assert.deepEqual(rows[1]!.place, { class: 'ModuleHideTerrainObjects_F', type: 'logic' });
  assert.equal(rows[2]!.class, 'BUS_InfSquad');
  assert.equal(rows[2]!.sqf, 'configFile >> "CfgGroups" >> "West" >> "BLU_F" >> "Infantry" >> "BUS_InfSquad"');
  assert.equal(rows[2]!.place, undefined);
  assert.match(String(r.note), /create3DENComposition/);
});

test('find: 에디터가 아니거나 인자가 틀리면 보내지 않는다', async () => {
  const mission = makeDeps(() => null, false);
  assert.equal((await runEdenFind(mission.deps, { query: 'x' })).ok, false);
  assert.equal(mission.gateway.sent.length, 0);
  const ed = makeDeps(() => null);
  assert.match(String((await runEdenFind(ed.deps, { side: 'NOPE' as 'WEST' })).error), /side/);
  assert.match(String((await runEdenFind(ed.deps, { kind: 'trigger' as 'unit' })).error), /kind/);
  assert.equal(ed.gateway.sent.length, 0);
});

test('place: 없는 ref id 는 클래스 확인 전에 멈춘다', async () => {
  const { gateway, deps } = makeDeps((code) => (isScene(code) ? 'ARRAY: [0,1,[],[0,0]]' : null));
  const r = await runEdenPlace(deps, { items: [{ class: 'X', on: 99 }] });
  assert.match(String(r.error), /99/);
  assert.equal(gateway.sent.length, 1);
});

test('edit: 지금 자리에서 by 만큼 옮기고 결과를 다시 잰다', async () => {
  let editCode = '';
  const { deps } = makeDeps((code) => {
    if (isScene(code)) return `ARRAY: [1,1,[${ROW(5, 50, 60, 2)}],[1,0]]`;
    if (isEdit(code)) {
      editCode = code;
      return `ARRAY: [1,1,[${ROW(5, 52, 60, 10)}],[1,0,[]]]`;
    }
    return null;
  });
  const r = await runEdenEdit(deps, { ops: [{ id: 5, by: [2, 0], turn: 90 }] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(editCode.includes('[5,[52,60],90,"ground",0,0,false]'), editCode.slice(0, 300));
  assert.equal((r.changed as unknown[]).length, 1);
});

test('edit: undo 는 ops 와 함께 쓰지 않는다', async () => {
  const { deps } = makeDeps((code) => (code.includes('do3DENAction "Undo"') ? 'ARRAY: ["OK", 2]' : null));
  assert.equal((await runEdenEdit(deps, { undo: 2, ops: [{ id: 1, dir: 0 }] })).ok, false);
  const r = await runEdenEdit(deps, { undo: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.undone, 2);
});

test('look: 시점마다 카메라를 옮기고 이름표를 받고, 찍지 못해도 카메라를 되돌린다', async () => {
  const cams: string[] = [];
  let restored = 0;
  const { deps } = makeDeps((code) => {
    if (isScene(code)) return `ARRAY: [1,1,[${ROW(4, 100, 100, 2)}],[1,0]]`;
    if (code.includes('getTerrainHeightASL [')) return 'ARRAY: ["OK", "5.00"]';
    if (code.includes('AHC_MCP_edenCam params')) {
      restored += 1;
      return 'ARRAY: ["OK"]';
    }
    if (code.includes('setVectorDirAndUp')) {
      cams.push(code);
      return 'ARRAY: ["OK"]';
    }
    if (code.includes('worldToScreen')) return 'ARRAY: ["OK", [[4, "0.512", "0.430"]]]';
    return null;
  });
  const r = await runEdenLook(deps, { ids: [4], views: ['iso', 'top'], delayMs: 0 }, new AbortController().signal, {
    isRunning: async () => false,
  });
  assert.equal(cams.length, 2);
  assert.ok(cams[1]!.includes('[0,0,-1]'), '위에서 아래를 본다');
  assert.equal(restored, 1);
  const shots = r.meta.shots as Record<string, unknown>[];
  assert.deepEqual(shots[0]!.labels, [{ id: 4, x: 0.512, y: 0.43 }]);
  assert.equal(r.meta.ok, false, '게임이 없으면 이미지가 없다');
});
