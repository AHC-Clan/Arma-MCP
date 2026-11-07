// zeusTool.test.ts: arma_zeus_find, arma_zeus_module 의 흐름(게임 불필요).
//
// FakeGateway 가 보낸 exec 프레임의 코드를 보고 바로 결과를 돌려준다. 실제 ExecManager 를 쓰므로
// 머신 선택, 페이지 이어 받기, 관찰 대기까지 서버 쪽 경로가 그대로 돈다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecManager } from '../src/exec/execManager.js';
import { createSessionContext } from '../src/mcp/session.js';
import { runZeusFind, runZeusModule } from '../src/mcp/tools/zeus.js';
import type { Gateway } from '../src/ipc/gateway.js';
import type { Deps } from '../src/mcp/deps.js';

type Reply = { machine?: string; result: string } | null;

class FakeGateway extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  connected = true;
  constructor(private reply: (frame: Record<string, unknown>) => Reply) {
    super();
  }
  send(frame: Record<string, unknown>): boolean {
    this.sent.push(frame);
    const r = this.reply(frame);
    if (r) {
      setImmediate(() =>
        this.emit('execResult', {
          v: 1,
          type: 'execResult',
          reqId: frame.reqId,
          machine: r.machine ?? 'server',
          result: r.result,
        }),
      );
    }
    return true;
  }
  isConnected(): boolean {
    return this.connected;
  }
}

function makeDeps(
  reply: (code: string, frame: Record<string, unknown>) => Reply,
  snap: { multiplayer: boolean; dedicated: boolean } = { multiplayer: true, dedicated: true },
): { gateway: FakeGateway; deps: Deps } {
  const gateway = new FakeGateway((f) => reply(String(f.code ?? ''), f));
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-zeus-tool-'));
  const exec = new ExecManager(
    gateway as unknown as Gateway,
    rptDir,
    { defaultTimeoutMs: 5000, maxCodeBytes: 131072 },
    () => null,
  );
  const session = createSessionContext('relay', 'abcd1234-0000-0000-0000-000000000000');
  session.lastExecCursor = { file: 'preserve-this-cursor.rpt', offset: 42 };
  const deps = {
    exec,
    session,
    gateway,
    telemetry: { current: () => ({ ...snap, playerCount: 1 }) },
    rptSources: { resolve: () => ({ source: 'server', dir: rptDir, re: /\.rpt$/i }) },
  } as unknown as Deps;
  return { gateway, deps };
}

const DETECT_ONE_REMOTE = 'ARRAY: [true,true,[["Patch",false]]]';
const isDetect = (c: string): boolean => c.endsWith('[isMultiplayer, isDedicated, _z]');
const isPage = (c: string): boolean => c.startsWith('private _p = (missionNamespace getVariable ["AHC_MCP_pg"');

const UNIT_ROW = (label: string, ref: string): string =>
  `["unit","${ref}","${label}","${label}","B_Soldier_F","James","","Alpha 1-1","","WEST","045123",4512,1234,5,"",100,-1]`;

test('find: Zeus 플레이어 머신(client 모드)에서 읽고 페이지 3쪽을 이어 받는다', async () => {
  const { gateway, deps } = makeDeps((code) => {
    if (isDetect(code)) return { result: DETECT_ONE_REMOTE };
    if (isPage(code)) {
      const i = Number(/_p param \[(\d+),/.exec(code)?.[1]);
      return { machine: 'Patch', result: `ARRAY: [3,[${UNIT_ROW(`소총수${i}`, `2:${i}`)}]]` };
    }
    return {
      machine: 'Patch',
      result: `ARRAY: [3,3,[${UNIT_ROW('소총수0', '2:0')}],["Korean",true,true]]`,
    };
  });

  const res = await runZeusFind(deps, { query: '소총수', kind: 'unit' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.machine, 'Patch');
  assert.equal(res.language, 'Korean');
  assert.equal(res.total, 3);
  const results = res.results as Record<string, unknown>[];
  assert.deepEqual(
    results.map((r) => r.label),
    ['소총수0', '소총수1', '소총수2'],
  );
  assert.equal(results[0]?.sqf, '("2:0" call BIS_fnc_objectFromNetId)');
  assert.equal(results[0]?.group, 'Alpha 1-1');
  assert.equal(results[0]?.zeus, true);
  assert.equal(results[0]?.local, true);

  assert.equal(gateway.sent[0]?.mode, 'server');
  for (const f of gateway.sent.slice(1)) {
    assert.equal(f.mode, 'client');
    assert.equal(f.target, 'Patch');
  }
  const pages = gateway.sent.filter((f) => isPage(String(f.code)));
  assert.equal(pages.length, 2);
  assert.ok(!String(pages[0]?.code).includes('deleteAt'));
  assert.ok(String(pages[1]?.code).includes('deleteAt'), '마지막 쪽에서 보관 키를 지운다');
  assert.deepEqual(deps.session.lastExecCursor, { file: 'preserve-this-cursor.rpt', offset: 42 });
});

test('find: SP 는 감지 뒤 server 모드 한 대에서 읽는다', async () => {
  const { gateway, deps } = makeDeps(
    (code) => {
      if (isDetect(code)) return { result: 'ARRAY: [false,false,[["Patch",true]]]' };
      return { machine: 'Patch', result: 'ARRAY: [0,1,[],["Korean",false,true]]' };
    },
    { multiplayer: false, dedicated: false },
  );
  const res = await runZeusFind(deps, { source: 'palette', query: '번개', kind: 'module' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.total, 0);
  assert.ok(gateway.sent.every((f) => f.mode === 'server'));
});

test('find: sqf 는 변수명이 있어도 netId 식이고, 그룹과 마커는 각자의 식', async () => {
  const rows = [
    '["vehicle","2:9","헌터","헌터","B_MRAP_01_F","","myTank","","","CIV","000000",1,2,17,0,100,-1]',
    '["group","2:12","Alpha 1-2","","","James","","Alpha 1-2","","WEST","000000",1,2,1,4,100,-1]',
    '["marker","mk_1","LZ","LZ","mil_dot","","","","","","000000",1,2,0,"",100,-1]',
  ].join(',');
  const { deps } = makeDeps((code) =>
    isDetect(code)
      ? { result: 'ARRAY: [true,true,[]]' }
      : { result: `ARRAY: [3,1,[${rows}],["English",false,false]]` },
  );
  const res = await runZeusFind(deps, {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const [veh, grp, mk] = res.results as Record<string, unknown>[];
  assert.equal(veh?.sqf, '("2:9" call BIS_fnc_objectFromNetId)');
  assert.equal(veh?.var, 'myTank');
  assert.equal(veh?.crew, 0);
  assert.equal(grp?.sqf, '("2:12" call BIS_fnc_groupFromNetId)');
  assert.equal(grp?.units, 4);
  assert.equal(grp?.leader, 'James');
  assert.equal(mk?.sqf, '"mk_1"');
  assert.match(String(res.note), /서버 언어/);
});

test('find: 결과가 500자에서 잘렸으면 예산 오류로 알린다', async () => {
  const { deps } = makeDeps((code) =>
    isDetect(code)
      ? { result: 'ARRAY: [true,true,[]]' }
      : { result: 'ARRAY: [1,1,[["unit" ...(truncated)' },
  );
  const res = await runZeusFind(deps, { query: 'x' });
  assert.equal(res.ok, false);
  assert.match(String(res.error), /500자/);
});

test('find: source 에 맞지 않는 kind 와 미연결을 거른다', async () => {
  const { gateway, deps } = makeDeps(() => null);
  const bad = await runZeusFind(deps, { source: 'palette', kind: 'marker' });
  assert.equal(bad.ok, false);
  assert.match(String(bad.error), /marker/);
  gateway.connected = false;
  const off = await runZeusFind(deps, {});
  assert.deepEqual(off, { ok: false, error: 'game not connected' });
  assert.equal(gateway.sent.length, 0);
});

test('selected: Zeus 플레이어가 여럿이면 on 을 요구하고 아무것도 보내지 않는다', async () => {
  const { gateway, deps } = makeDeps((code) =>
    isDetect(code) ? { result: 'ARRAY: [true,true,[["A",false],["B",false]]]' } : null,
  );
  const res = await runZeusFind(deps, { source: 'selected' });
  assert.equal(res.ok, false);
  assert.deepEqual(res.zeusPlayers, ['A', 'B']);
  assert.equal(gateway.sent.length, 1);
});

test('module: 이름이 여러 모듈에 걸리면 만들지 않고 후보를 돌려준다', async () => {
  const { gateway, deps } = makeDeps((code) => {
    if (isDetect(code)) return { result: DETECT_ONE_REMOTE };
    return {
      machine: 'Patch',
      result: 'ARRAY: ["AMBIG",2,[["PH_Mission_TeleportSelect","4_텔레포트(선택)"],["PH_Mission_TeleportZeus","5_텔레포트(제우스)"]]]',
    };
  });
  const res = await runZeusModule(deps, { module: '텔레포트' }, new AbortController().signal);
  assert.equal(res.ok, false);
  assert.deepEqual(res.candidates, [
    { class: 'PH_Mission_TeleportSelect', label: '4_텔레포트(선택)' },
    { class: 'PH_Mission_TeleportZeus', label: '5_텔레포트(제우스)' },
  ]);
  assert.equal(gateway.sent.length, 2, '관찰 exec 를 보내지 않는다');
});

test('module: 만든 뒤 창이 늘면 outcome=dialog, 로직이 지워졌으면 curator 추가를 건너뛴다', async () => {
  const { gateway, deps } = makeDeps((code) => {
    if (isDetect(code)) return { result: DETECT_ONE_REMOTE };
    if (code.includes('AHC_MCP_zm deleteAt')) {
      return { machine: 'Patch', result: 'ARRAY: ["OK",false,true,1,false,true,""]' };
    }
    return {
      machine: 'Patch',
      result: 'ARRAY: ["OK","PH_Mission_VarName","2_변수명 지정","[AHC] 미션 도구","2:77",[100,200],5,"object"]',
    };
  });
  const res = await runZeusModule(
    deps,
    { module: '변수명 지정', target: '2:9', observeMs: 0 },
    new AbortController().signal,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.outcome, 'dialog');
  assert.equal(res.dialogOpened, true);
  assert.deepEqual(res.module, {
    class: 'PH_Mission_VarName',
    label: '2_변수명 지정',
    category: '[AHC] 미션 도구',
    canAttach: true,
    attributeDialog: false,
    opensDialog: true,
  });
  assert.equal(res.targetKind, 'object');
  assert.equal(res.curatorAdded, undefined);
  assert.equal(gateway.sent.length, 3);
  assert.equal(gateway.sent[2]?.target, 'Patch');
});

test('module: 로직이 남으면 서버에서 그 플레이어의 curator 에 넣는다', async () => {
  const { gateway, deps } = makeDeps((code) => {
    if (isDetect(code)) return { result: DETECT_ONE_REMOTE };
    if (code.includes('AHC_MCP_zm deleteAt')) {
      return { machine: 'Patch', result: 'ARRAY: ["OK",true,false,0,false,true,"2:77"]' };
    }
    if (code.includes('addCuratorEditableObjects')) return { result: 'ARRAY: ["OK",1]' };
    return {
      machine: 'Patch',
      result: 'ARRAY: ["OK","ModuleSector_F","섹터","목표",'
        + '"2:77",[100,200],2,""]',
    };
  });
  const res = await runZeusModule(deps, { module: 'ModuleSector_F', pos: [100, 200], observeMs: 0 }, new AbortController().signal);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.outcome, 'persistent');
  assert.equal(res.logicRef, '2:77');
  assert.equal(res.curatorAdded, 1);
  const add = gateway.sent.find((f) => String(f.code).includes('addCuratorEditableObjects'));
  assert.equal(add?.mode, 'server');
  assert.ok(String(add?.code).includes('"Patch"'));
  assert.match(String(res.note), /속성 창/);
});

test('module: 관찰 대기 중 세션이 닫히면 바로 끝낸다', async () => {
  const { deps } = makeDeps((code) => {
    if (isDetect(code)) return { result: DETECT_ONE_REMOTE };
    return { machine: 'Patch', result: 'ARRAY: ["OK","ModuleLightning_F","번개","효과","2:5",[1,2],0,""]' };
  });
  const ac = new AbortController();
  const pending = runZeusModule(deps, { module: 'ModuleLightning_F', observeMs: 10000 }, ac.signal);
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.ok(Date.now() - t0 < 5000);
});
