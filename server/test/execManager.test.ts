// execManager.test.ts — exec 완료 경로(first/expectN/quiet/timeout) 단위 테스트.
//
// 실소켓 없이 fake Gateway(EventEmitter + send 캡처)로 ExecManager 만 검증한다.
// makeManager 의 rptDir 은 빈 임시 디렉토리 → RPT 커서 없음 → RPT 스캔 경로 미진입.
// RPT 스캔 경로는 파일 끝의 makeManagerWithRpt 테스트가 따로 다룬다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecManager } from '../src/exec/execManager.js';
import type { Gateway } from '../src/ipc/gateway.js';

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

function makeManager(getExpected?: () => number | null): { gw: FakeGateway; mgr: ExecManager } {
  const gw = new FakeGateway();
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-exec-'));
  const mgr = new ExecManager(gw as unknown as Gateway, rptDir, DEFAULTS, getExpected);
  return { gw, mgr };
}

// run() 은 전송 전에 RPT 커서 조회(fs/promises IO)를 거치므로 setImmediate 1회로는
// 프레임 전송을 보장할 수 없다 — 전송 프레임 수가 n 에 도달할 때까지 양보한다.
async function flush(gw: FakeGateway, n = 1): Promise<void> {
  const deadline = Date.now() + 2000;
  while (gw.sent.length < n && Date.now() < deadline) {
    await new Promise((r) => setImmediate(r));
  }
}

function emitResult(gw: FakeGateway, machine: string): void {
  const reqId = String(gw.sent[gw.sent.length - 1]?.reqId ?? '');
  gw.emit('execResult', { v: 1, type: 'execResult', reqId, machine, result: 'SCALAR: 2' });
}

function emitResultFor(gw: FakeGateway, reqId: string, machine: string): void {
  gw.emit('execResult', { v: 1, type: 'execResult', reqId, machine, result: 'SCALAR: 2' });
}

test('server 모드: 첫 결과로 즉시 완료 (completedBy=first)', async () => {
  const { gw, mgr } = makeManager();
  const t0 = Date.now();
  const p = mgr.run({ code: '1+1' });
  await flush(gw);
  emitResult(gw, 'server');
  const out = await p;
  assert.equal(out.ok, true);
  assert.equal(out.completedBy, 'first');
  assert.equal(out.timedOut, false);
  assert.ok(Date.now() - t0 < 1000, '첫 결과 후 즉시 완료돼야 한다');
});

test('label 미지정: 기본 agent 라벨 전송', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1' });
  await flush(gw);
  assert.equal(gw.sent[0]?.label, 'agent');
  emitResult(gw, 'server');
  await p;
});

test('label 명시: 사용자 라벨을 그대로 전송', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1', label: 'mission-author' });
  await flush(gw);
  assert.equal(gw.sent[0]?.label, 'mission-author');
  emitResult(gw, 'server');
  await p;
});

test('label 길이: 60자로 절단해 전송', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1', label: 'x'.repeat(61) });
  await flush(gw);
  assert.equal(gw.sent[0]?.label, 'x'.repeat(60));
  emitResult(gw, 'server');
  await p;
});

test('세션 context: reqId와 감사 라벨에 shortId를 포함', async () => {
  const { gw, mgr } = makeManager();
  const abortController = new AbortController();
  const p = mgr.run({
    code: '1+1',
    label: 'mission-author',
    context: {
      sessionId: 'session-one',
      sessionShortId: 'a1b2c3d4',
      signal: abortController.signal,
    },
  });
  await flush(gw);
  assert.match(String(gw.sent[0]?.reqId), /^a1b2c3d4-[0-9a-f]{12}$/);
  assert.equal(gw.sent[0]?.label, '[a1b2c3d4] mission-author');
  emitResult(gw, 'server');
  await p;
});

test('세션 취소: 해당 세션 pending만 종료하고 다른 세션 결과는 유지', async () => {
  const { gw, mgr } = makeManager();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = mgr.run({
    code: '1+1',
    context: {
      sessionId: 'session-one',
      sessionShortId: '11111111',
      signal: firstAbort.signal,
    },
  });
  const second = mgr.run({
    code: '2+2',
    context: {
      sessionId: 'session-two',
      sessionShortId: '22222222',
      signal: secondAbort.signal,
    },
  });
  await flush(gw, 2);
  const firstReqId = String(gw.sent[0]?.reqId);
  const secondReqId = String(gw.sent[1]?.reqId);

  firstAbort.abort();
  emitResultFor(gw, firstReqId, 'late-first'); // 취소 뒤 늦은 결과는 폐기.
  emitResultFor(gw, secondReqId, 'server');

  const [firstOut, secondOut] = await Promise.all([first, second]);
  assert.equal(firstOut.ok, false);
  assert.equal(firstOut.completedBy, 'cancelled');
  assert.equal(firstOut.error, 'client session closed');
  assert.equal(firstOut.results.length, 0);
  assert.equal(secondOut.ok, true);
  assert.equal(secondOut.completedBy, 'first');
  assert.equal(mgr.pendingCount(), 0);
});

test('세션 context: 선택된 RPT 소스와 세션 커서를 결과에 기록', async () => {
  const { gw, mgr } = makeManager();
  let cursorSeen: unknown = undefined;
  const p = mgr.run({
    code: '1+1',
    checkRpt: false,
    context: {
      sessionId: 'session-one',
      sessionShortId: 'a1b2c3d4',
      onRptCursor: (cursor) => {
        cursorSeen = cursor;
      },
      rptSource: 'server',
    },
  });
  await flush(gw);
  emitResult(gw, 'server');
  const out = await p;
  assert.equal(cursorSeen, null);
  assert.equal(out.resolvedSource, 'server');
});

test('all 모드: 명시 expectN 도달 시 즉시 완료 (completedBy=expectN)', async () => {
  const { gw, mgr } = makeManager();
  const t0 = Date.now();
  const p = mgr.run({ code: '1+1', mode: 'all', expectN: 2 });
  await flush(gw);
  emitResult(gw, 'server');
  emitResult(gw, 'Alice');
  const out = await p;
  assert.equal(out.results.length, 2);
  assert.equal(out.completedBy, 'expectN');
  assert.ok(Date.now() - t0 < 1000);
});

test('all 모드: expectN 미지정 + 유도값 도달 시 즉시 완료', async () => {
  const { gw, mgr } = makeManager(() => 2);
  const t0 = Date.now();
  const p = mgr.run({ code: '1+1', mode: 'all' });
  await flush(gw);
  emitResult(gw, 'server');
  emitResult(gw, 'Alice');
  const out = await p;
  assert.equal(out.results.length, 2);
  assert.equal(out.completedBy, 'expectN');
  assert.ok(Date.now() - t0 < 1000);
});

test('all 모드: expectN 없음 → quiet-window 로 조기 완료 (completedBy=quiet)', async () => {
  const { gw, mgr } = makeManager();
  const t0 = Date.now();
  const p = mgr.run({ code: '1+1', mode: 'all', allQuietMs: 150 });
  await flush(gw);
  emitResult(gw, 'server');
  const out = await p;
  const dur = Date.now() - t0;
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.completedBy, 'quiet');
  assert.equal(out.timedOut, false);
  assert.ok(dur >= 100 && dur < 1500, `quiet 창(~150ms) 내 완료 (실제 ${dur}ms)`);
});

test('all 모드: 결과 수신마다 quiet 창 재설정', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1', mode: 'all', allQuietMs: 200 });
  await flush(gw);
  emitResult(gw, 'server');
  await new Promise((r) => setTimeout(r, 120));
  emitResult(gw, 'Alice'); // 창 안에서 두 번째 결과 → 창 연장
  const out = await p;
  assert.equal(out.results.length, 2, 'quiet 창 연장으로 두 결과 모두 수집');
  assert.equal(out.completedBy, 'quiet');
});

test('all 모드: allQuietMs=0 이면 타임아웃까지 수집 (기존 동작)', async () => {
  const { gw, mgr } = makeManager();
  const t0 = Date.now();
  const p = mgr.run({ code: '1+1', mode: 'all', allQuietMs: 0, timeoutMs: 500 });
  await flush(gw);
  emitResult(gw, 'server');
  const out = await p;
  const dur = Date.now() - t0;
  assert.equal(out.ok, true);
  assert.equal(out.completedBy, 'timeout');
  assert.equal(out.timedOut, true);
  assert.ok(dur >= 450, `타임아웃 창 전체 대기 (실제 ${dur}ms)`);
});

test('미접속: 즉시 game not connected', async () => {
  const { gw, mgr } = makeManager();
  gw.connected = false;
  const t0 = Date.now();
  const out = await mgr.run({ code: '1+1' });
  assert.equal(out.ok, false);
  assert.match(String(out.error), /not connected/);
  assert.ok(Date.now() - t0 < 200);
});

test('단절: pending 즉시 실패 (completedBy=disconnect)', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1' });
  await flush(gw);
  gw.emit('disconnected');
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.completedBy, 'disconnect');
});

// ── RPT 오류 근거를 같은 호출에 담기 ──
//
// 아래 테스트는 rptDir 에 실제 클라 RPT 파일을 두어 커서가 잡히게 한다.
// 줄 모양은 애드온 fn_execResultIn.sqf 의 감사 줄과 실제 RPT 에서 옮겼다.

const SILENT_TIMEOUT_NOTE =
  '결과가 오지 않았다. 하드 SQF 오류로 스크립트가 중단됐을 수 있어 실행 구간 RPT 오류 블록을 담았다.';

const ERROR_BLOCK =
  '10:00:02 Error in expression <_undef + 1>\r\n' +
  '10:00:02   Error position: <_undef + 1>\r\n' +
  '10:00:02   Error Undefined variable in expression: _undef\r\n';

function makeManagerWithRpt(): { gw: FakeGateway; mgr: ExecManager; rpt: string } {
  const gw = new FakeGateway();
  const rptDir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-exec-rpt-'));
  const rpt = path.join(rptDir, 'Arma3_x64_2026-09-23_10-00-00.rpt');
  writeFileSync(rpt, '10:00:00 "[ArmaMCP] init server bridge on VR"\r\n', 'utf8');
  const mgr = new ExecManager(gw as unknown as Gateway, rptDir, DEFAULTS);
  return { gw, mgr, rpt };
}

function auditLine(reqId: string, machine: string, result: string): string {
  return `10:00:03 "[ArmaMCP] [EXEC] result <- ${machine} (reqId=${reqId}): ${result}"\r\n`;
}

function emitRaw(gw: FakeGateway, reqId: string, machine: string, result: string): void {
  gw.emit('execResult', { v: 1, type: 'execResult', reqId, machine, result });
}

const NIL = "<nil> (if unexpected, check RPT for 'Error in expression')";

test('결과 없는 타임아웃: 실행 구간 RPT 오류 블록과 노트를 담는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '[] call {throw "boom"}; 1', timeoutMs: 500 });
  await flush(gw);
  appendFileSync(rpt, ERROR_BLOCK);
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.results.length, 0);
  assert.equal(out.rptErrors.length, 1);
  assert.match(out.rptErrors[0]!.block[0]!, /Error in expression <_undef \+ 1>/);
  assert.equal(out.note, SILENT_TIMEOUT_NOTE);
  assert.ok(out.rptAttribution);
});

test('mode all 타임아웃: 결과가 왔으면 결과 없음 노트를 달지 않는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({
    code: '1+1',
    mode: 'all',
    allQuietMs: 0,
    timeoutMs: 500,
    checkRpt: true,
  });
  await flush(gw);
  appendFileSync(rpt, ERROR_BLOCK);
  emitResult(gw, 'server');
  appendFileSync(rpt, auditLine(String(gw.sent[0]?.reqId), 'server', 'SCALAR: 2'));
  const out = await p;
  assert.equal(out.timedOut, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.rptErrors.length, 1, 'checkRpt 스캔은 그대로 한다');
  assert.equal(out.note, undefined);
});

test('server nil: 감사 줄이 늦게 기록돼도 기다렸다가 그 앞의 오류 블록을 담는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '_undef + 1' });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  // 전송 감사 줄은 "reqId=<id> " 로 끝나 결과 감사 줄로 오인하면 안 된다.
  appendFileSync(
    rpt,
    `10:00:01 "[ArmaMCP] [EXEC] mode=server target= reqId=${reqId} label=agent code=_undef + 1"\r\n`,
  );
  const t0 = Date.now();
  setTimeout(() => appendFileSync(rpt, ERROR_BLOCK + auditLine(reqId, 'server', NIL)), 300);
  emitRaw(gw, reqId, 'server', NIL);
  const out = await p;
  const waited = Date.now() - t0;
  assert.equal(out.ok, true);
  assert.equal(out.results[0]?.parsed.kind, 'nil');
  assert.equal(out.rptErrors.length, 1, '감사 줄 앞에 기록된 블록을 담아야 한다');
  assert.match(out.rptErrors[0]!.block.join('\n'), /Undefined variable/);
  assert.equal(out.note, undefined);
  assert.ok(waited >= 250 && waited < 1400, `감사 줄까지 기다린다 (실제 ${waited}ms)`);
});

// 실게임 RPT 에서 옮긴 순서. 결과 프레임이 데몬에 닿은 시점에는 RPT 가 아직 한 줄도 자라지 않았고,
// 전송 감사 줄과 오류 블록과 결과 감사 줄이 그 뒤에 한꺼번에 기록된다.
function lateRptBurst(reqId: string, dispatch: string, machine: string): string {
  return (
    `17:49:27 "[ArmaMCP] [EXEC] ${dispatch} reqId=${reqId} label=[900097e4] agent sum=Y7NoX65qz2s code=_undef + 1"\r\n` +
    '17:49:27 Error in expression <_undef + 1>\r\n' +
    '17:49:27   Error position: <_undef + 1>\r\n' +
    '17:49:27   Error 표현식에 정의되지 않은 변수(_undef)가 있습니다.\r\n' +
    `17:49:27 "[ArmaMCP] [EXEC] result <- ${machine} (reqId=${reqId}): ${NIL}"\r\n`
  );
}

test('server nil: 결과 시점에 RPT 가 자라지 않았어도 감사 줄을 기다려 오류 블록을 담는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '_undef + 1' });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  const t0 = Date.now();
  setTimeout(() => appendFileSync(rpt, lateRptBurst(reqId, 'mode=server target=', 'server')), 300);
  emitRaw(gw, reqId, 'server', NIL);
  const out = await p;
  const waited = Date.now() - t0;
  assert.equal(out.results[0]?.parsed.kind, 'nil');
  assert.equal(out.rptErrors.length, 1, '결과보다 늦게 기록된 블록을 담아야 한다');
  assert.match(out.rptErrors[0]!.block[0]!, /Error in expression <_undef \+ 1>/);
  assert.equal(out.note, undefined);
  assert.ok(out.rptAttribution);
  assert.ok(waited >= 250 && waited < 1400, `감사 줄까지 기다린다 (실제 ${waited}ms)`);
});

test('all nil: 결과 시점에 RPT 가 자라지 않았어도 감사 줄을 기다려 오류 블록을 담는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '_undef + 1', mode: 'all', expectN: 1 });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  setTimeout(() => appendFileSync(rpt, lateRptBurst(reqId, 'mode=all target=', 'Patch')), 300);
  emitRaw(gw, reqId, 'Patch', NIL);
  const out = await p;
  assert.equal(out.results[0]?.machine, 'Patch');
  assert.equal(out.rptErrors.length, 1, '결과보다 늦게 기록된 블록을 담아야 한다');
  assert.equal(out.note, undefined);
});

test('server nil: RPT 가 끝까지 자라지 않으면(-noLogs) 상한 1.5초까지만 기다린다', async () => {
  const { gw, mgr } = makeManagerWithRpt();
  const p = mgr.run({ code: 'nil' });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  const t0 = Date.now();
  emitRaw(gw, reqId, 'server', NIL);
  const out = await p;
  const waited = Date.now() - t0;
  assert.ok(waited >= 1400 && waited < 2500, `상한에서 멈춘다 (실제 ${waited}ms)`);
  assert.equal(out.rptErrors.length, 0);
  assert.match(String(out.note), /정상 nil/);
});

test('sp all nil: machine 이 플레이어 이름이어도 감사 줄을 기다려 그 앞의 블록을 담는다', async () => {
  // sp 와 호스트 게임에서 fn_execRunRemote 는 machine 을 name player 로 적는다.
  // 감사 줄은 같은 RPT 에 오류 블록 뒤로 남는다.
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '_undef + 1', mode: 'all', expectN: 1 });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  appendFileSync(rpt, `10:00:01 "[ArmaMCP] [EXEC] ALL dispatched reqId=${reqId}"\r\n`);
  const t0 = Date.now();
  setTimeout(() => appendFileSync(rpt, ERROR_BLOCK + auditLine(reqId, 'Player', NIL)), 300);
  emitRaw(gw, reqId, 'Player', NIL);
  const out = await p;
  const waited = Date.now() - t0;
  assert.equal(out.results[0]?.machine, 'Player');
  assert.equal(out.rptErrors.length, 1, '감사 줄 앞에 기록된 블록을 담아야 한다');
  assert.equal(out.note, undefined);
  assert.ok(waited >= 250 && waited < 1400, `감사 줄까지 기다린다 (실제 ${waited}ms)`);
});

test('client nil: 원격 클라 결과도 서버 RPT 의 감사 줄이 보이면 바로 돌아온다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: 'nil', mode: 'client', target: 'Alice' });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  appendFileSync(rpt, `10:00:01 "[ArmaMCP] [EXEC] -> Alice reqId=${reqId}"\r\n`);
  const t0 = Date.now();
  setTimeout(() => appendFileSync(rpt, auditLine(reqId, 'Alice', NIL)), 100);
  emitRaw(gw, reqId, 'Alice', NIL);
  const out = await p;
  const waited = Date.now() - t0;
  assert.ok(waited >= 80 && waited < 1000, `감사 줄까지만 기다린다 (실제 ${waited}ms)`);
  assert.equal(out.results[0]?.machine, 'Alice');
  assert.match(String(out.note), /정상 nil/);
});

test('checkRpt 값 결과: 감사 줄을 기다려 그 앞의 소프트 오류 블록을 담는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const p = mgr.run({ code: '_undef + 1; 2', checkRpt: true });
  await flush(gw);
  const reqId = String(gw.sent[0]?.reqId);
  appendFileSync(
    rpt,
    `10:00:01 "[ArmaMCP] [EXEC] mode=server target= reqId=${reqId} label=agent code=_undef + 1; 2"\r\n`,
  );
  setTimeout(() => appendFileSync(rpt, ERROR_BLOCK + auditLine(reqId, 'server', 'SCALAR: 2')), 300);
  emitRaw(gw, reqId, 'server', 'SCALAR: 2');
  const out = await p;
  assert.equal(out.results[0]?.parsed.kind, 'value');
  assert.equal(out.rptErrors.length, 1, '감사 줄 앞에 기록된 블록을 담아야 한다');
  assert.ok(out.rptAttribution);
});

test('rptCursor: 보내기 직전의 RPT 위치를 결과에 싣는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  const sizeBefore = statSync(rpt).size;
  const p = mgr.run({ code: '1+1' });
  await flush(gw);
  // 보낸 뒤에 자란 RPT 는 커서에 들어가지 않는다.
  appendFileSync(rpt, '10:00:05 "later line"\r\n');
  emitResult(gw, 'server');
  const out = await p;
  assert.equal(out.ok, true);
  assert.deepEqual(out.rptCursor, { file: rpt, offset: sizeBefore });
});

test('rptCursor: RPT 가 없거나 커서를 잡기 전에 멈추면 null 이다', async () => {
  const { gw, mgr } = makeManager();
  const p = mgr.run({ code: '1+1' });
  await flush(gw);
  emitResult(gw, 'server');
  assert.equal((await p).rptCursor, null, '빈 RPT 폴더');

  const empty = await makeManagerWithRpt().mgr.run({ code: '   ' });
  assert.equal(empty.error, 'empty code');
  assert.equal(empty.rptCursor, null);
});

test('rptCursor: 게임이 붙지 않아 보내지 못해도 잡은 커서는 싣는다', async () => {
  const { gw, mgr, rpt } = makeManagerWithRpt();
  gw.connected = false;
  const out = await mgr.run({ code: '1+1' });
  assert.equal(out.error, 'game not connected');
  assert.deepEqual(out.rptCursor, { file: rpt, offset: statSync(rpt).size });
});
