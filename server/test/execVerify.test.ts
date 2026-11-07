// execVerify.test.ts — arma_exec.verify 의 격리 계약.
//
// 지키는 것:
//  - verify 를 주지 않으면 와이어로 나가는 code 가 sanitize 결과와 바이트 동일하다
//    (평문 경로 불변 — execManager.test.ts 가 무수정으로 도는 이유).
//  - verify 를 주면 본문/증거가 각각 자식 spawn 으로 감싸이고, 한쪽 실패가 다른 쪽 결과를
//    억누르지 않는다.
//  - 사용자 코드는 조립 전에 sanitize 된다. 나중에 하면 문자열 리터럴 내부의 주석이
//    살아남아 인게임 compile 이 조용히 <nil> 로 파손된다.
//
// run() 은 전송 전에 비동기 RPT 커서 조회를 하므로 setImmediate 1회로는 부족하다 —
// execManager.test.ts 와 같은 flush() 규율을 따른다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecManager } from '../src/exec/execManager.js';
import type { Gateway } from '../src/ipc/gateway.js';
import { sanitizeSqf } from '../src/exec/sanitize.js';

class FakeGateway extends EventEmitter {
  sent: Record<string, unknown>[] = [];
  connected = true;
  send(obj: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    this.sent.push(obj);
    return true;
  }
}

const DEFAULTS = { defaultTimeoutMs: 5000, maxCodeBytes: 131072 };

function makeManager(): { gw: FakeGateway; mgr: ExecManager } {
  const gw = new FakeGateway();
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-verify-'));
  return { gw, mgr: new ExecManager(gw as unknown as Gateway, rptDir, DEFAULTS) };
}

async function flush(gw: FakeGateway, n = 1): Promise<void> {
  const deadline = Date.now() + 2000;
  while (gw.sent.length < n && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
}

function reply(gw: FakeGateway, result: string): void {
  const reqId = String(gw.sent[gw.sent.length - 1]?.reqId ?? '');
  gw.emit('execResult', { v: 1, type: 'execResult', reqId, machine: 'server', result });
}

test('verify 미지정: 와이어 code 가 sanitize 결과와 바이트 동일', async () => {
  const { gw, mgr } = makeManager();
  const src = 'systemChat "hi"; true';
  const p = mgr.run({ code: src });
  await flush(gw);
  assert.equal(gw.sent[0]?.code, sanitizeSqf(src, 'strip').code);
  reply(gw, 'BOOL: true');
  const out = await p;
  assert.equal(out.verify, undefined, 'verify 를 안 줬으면 필드도 없다');
  assert.equal(out.results[0]?.result, 'BOOL: true');
});

test('verify 지정: 본문과 증거가 각각 자식 spawn 으로 감싸인다', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: 'doStuff', verify: 'count allUnits' });
  await flush(gw);
  const code = String(gw.sent[0]?.code);
  assert.ok(code.startsWith('private _b = createHashMap;'), '해시맵 상자로 시작');
  assert.ok(code.includes('"doStuff"'), '본문이 문자열 리터럴로 들어간다');
  assert.ok(code.includes('"count allUnits"'), '증거식이 문자열 리터럴로 들어간다');
  assert.equal((code.match(/spawn \{/g) ?? []).length, 2, '자식 spawn 이 정확히 2개');
  assert.ok(code.includes('MCPV|'), '길이 접두 프레임으로 되돌린다');
  assert.equal(sanitizeSqf(code, 'strip').changed, false, '조립 결과에 주석 없음');
  reply(gw, 'STRING: "MCPV|12|10|BOOL: true SCALAR: 3"');
  await p;
});

test('증거식이 죽어도 본문 결과는 돌아온다', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: 'doStuff', verify: 'round allUnits' });
  await flush(gw);
  // 인게임: 본문은 BOOL: true, 증거는 자식이 죽어 ERROR 로 접힘.
  const main = 'BOOL: true';
  const ack = 'ERROR: aborted (see RPT)';
  reply(gw, `STRING: "MCPV|40|${main.length}|${main}${ack}"`);
  const out = await p;
  assert.equal(out.ok, true, '변이는 성공했으므로 ok 는 true 를 유지한다');
  assert.equal(out.results[0]?.result, main, 'results 는 평소 모양(본문 값)으로 되돌아온다');
  assert.equal(out.results[0]?.parsed.kind, 'value');
  assert.equal(out.verify?.result, ack);
  assert.equal(out.verify?.parsed.kind, 'error');
  assert.match(String(out.note), /검증식/, '원인 안내가 붙는다');
});

test('본문이 죽어도 증거 결과는 돌아온다', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: 'round allUnits', verify: 'true' });
  await flush(gw);
  const main = 'ERROR: step timeout';
  const ack = 'BOOL: true';
  reply(gw, `STRING: "MCPV|5000|${main.length}|${main}${ack}"`);
  const out = await p;
  assert.equal(out.results[0]?.result, main);
  assert.equal(out.results[0]?.parsed.kind, 'error');
  assert.equal(out.verify?.result, ack);
  assert.equal(out.verify?.parsed.kind, 'value');
});

test('사용자 코드의 주석은 리터럴로 감싸기 전에 제거된다', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: 'a = 1; // 설명\n b = 2', verify: 'b // 확인' });
  await flush(gw);
  const code = String(gw.sent[0]?.code);
  assert.ok(!code.includes('설명'), '본문 주석이 리터럴 안에 살아남으면 안 된다');
  assert.ok(!code.includes('확인'), '증거식 주석도 마찬가지');
  reply(gw, 'STRING: "MCPV|1|4|OK: SCALAR: 2"');
  const out = await p;
  assert.equal(out.sanitized, true, '주석 제거 사실이 보고된다');
});

test('verify 는 server 모드에서만 적용된다', async () => {
  const { gw, mgr } = makeManager();
  // all 모드는 머신마다 결과가 오므로 "본문 + 증거" 한 쌍 프레이밍이 성립하지 않는다.
  const p = mgr.run({ code: 'doStuff', mode: 'all', verify: 'count allUnits', expectN: 1 });
  await flush(gw);
  assert.equal(gw.sent[0]?.code, 'doStuff', 'all 모드에서는 래핑하지 않는다');
  reply(gw, 'BOOL: true');
  const out = await p;
  assert.equal(out.verify, undefined);
});
