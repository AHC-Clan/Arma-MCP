// focusGuard.test.ts: 앞에 없는 게임 창에 비활성 알림을 보내는 판단. 헬퍼의 관찰을 손으로 만들어 넣고 명령만 본다.
//
// 실제 게임은 docs/testing.md 의 포커스 가드 시나리오가 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FOCUS_REASSERT_MS, FocusGuard, type FocusCommand, type FocusTarget } from '../src/tiler/focusGuard.js';
import { WindowTiler, type AgentProc, type AgentSnapshot, type AgentWindow, type MoveCommand } from '../src/tiler/windowTiler.js';

const ROOT = path.resolve('C:\\Users\\me\\.arma-mcp\\stacks');
const AREA: [number, number, number, number] = [0, 0, 2560, 1392];
const TERMINAL_PID = 18040;

function harness() {
  let now = 1_000_000;
  const sent: FocusCommand[] = [];
  const logs: string[] = [];
  const guard = new FocusGuard({ send: (c) => sent.push(c), log: (m) => logs.push(m), now: () => now });
  return {
    guard,
    sent,
    logs,
    advance(ms: number) {
      now += ms;
    },
  };
}

function gameWin(h: number, extra: Partial<AgentWindow> = {}): AgentWindow {
  return { h, cls: 'Arma 3', r: [0, 0, 1280, 696], cap: true, min: false, max: false, mv: false, ...extra };
}

function target(pid: number, win: AgentWindow | undefined, label = `game${pid}`): FocusTarget {
  return { key: `${pid}:1`, pid, label, win };
}

function snap(fgPid: number | undefined, btn = false): AgentSnapshot {
  return { area: AREA, human: -1, fg: 1, fgPid, btn, procs: [] };
}

test('FocusGuard: 앞에 없는 창 모드 게임에 처음 보자마자 비활성 알림을 보낸다', () => {
  const h = harness();
  h.guard.onSnapshot(snap(TERMINAL_PID), [target(100, gameWin(5000))]);
  assert.deepEqual(h.sent, [{ hwnd: 5000, pid: 100 }]);
  assert.match(h.logs[0]!, /game100 가 앞에 없어 비활성 알림/);
});

test('FocusGuard: 앞에 있는 게임에는 보내지 않는다', () => {
  const h = harness();
  h.guard.onSnapshot(snap(100), [target(100, gameWin(5000))]);
  h.advance(FOCUS_REASSERT_MS * 3);
  h.guard.onSnapshot(snap(100), [target(100, gameWin(5000))]);
  assert.deepEqual(h.sent, []);
});

test('FocusGuard: 뒤에 있으면 간격마다 다시 보내고 그 사이에는 보내지 않는다', () => {
  const h = harness();
  const t = [target(100, gameWin(5000))];
  h.guard.onSnapshot(snap(TERMINAL_PID), t);
  h.advance(FOCUS_REASSERT_MS - 1);
  h.guard.onSnapshot(snap(TERMINAL_PID), t);
  assert.equal(h.sent.length, 1);
  h.advance(1);
  h.guard.onSnapshot(snap(TERMINAL_PID), t);
  assert.equal(h.sent.length, 2);
  // 처음 한 번만 로그를 남긴다.
  assert.equal(h.logs.length, 1);
});

test('FocusGuard: 앞에서 뒤로 가면 간격을 기다리지 않고 바로 보낸다', () => {
  const h = harness();
  const t = [target(100, gameWin(5000))];
  h.guard.onSnapshot(snap(TERMINAL_PID), t);
  h.advance(250);
  h.guard.onSnapshot(snap(100), t);
  h.advance(250);
  h.guard.onSnapshot(snap(TERMINAL_PID), t);
  // 앞에 있는 동안에는 보내지 않고, 활성 알림도 보내지 않는다.
  assert.equal(h.sent.length, 2);
  assert.ok(h.sent.every((c) => c.hwnd === 5000));
});

test('FocusGuard: 마우스 단추가 눌려 있으면 미루고 떼면 보낸다', () => {
  const h = harness();
  const t = [target(100, gameWin(5000))];
  h.guard.onSnapshot(snap(TERMINAL_PID, true), t);
  assert.deepEqual(h.sent, []);
  h.advance(30);
  h.guard.onSnapshot(snap(TERMINAL_PID, false), t);
  assert.deepEqual(h.sent, [{ hwnd: 5000, pid: 100 }]);
});

test('FocusGuard: 전체 화면, 최소화, 시작 화면, 창 없음은 보지 않는다', () => {
  const h = harness();
  h.guard.onSnapshot(snap(TERMINAL_PID), [
    target(100, gameWin(5000, { cap: false })),
    target(101, gameWin(5001, { min: true })),
    target(102, gameWin(5002, { cls: '#32770' })),
    target(103, undefined),
  ]);
  assert.deepEqual(h.sent, []);
});

test('FocusGuard: 앞 창을 모르는 이전 헬퍼의 관찰에는 아무것도 하지 않는다', () => {
  const h = harness();
  h.guard.onSnapshot(snap(undefined), [target(100, gameWin(5000))]);
  assert.deepEqual(h.sent, []);
});

test('FocusGuard: 게임마다 따로 판단하고 닫힌 게임은 잊는다', () => {
  const h = harness();
  h.guard.onSnapshot(snap(100), [target(100, gameWin(5000)), target(200, gameWin(6000))]);
  assert.deepEqual(h.sent, [{ hwnd: 6000, pid: 200 }]);
  // 200 이 닫혔다가 같은 key 로 다시 보이면 처음 본 게임으로 다룬다.
  h.guard.onSnapshot(snap(100), [target(100, gameWin(5000))]);
  h.advance(100);
  h.guard.onSnapshot(snap(100), [target(100, gameWin(5000)), target(200, gameWin(6000))]);
  assert.equal(h.sent.length, 2);
  assert.equal(h.logs.length, 2);
});

function stackProc(pid: number, start: number, stack: string, w: AgentWindow): AgentProc {
  const cmd = `arma3_x64.exe -profiles="${path.join(ROOT, stack, 'client1')}" -name=${stack}_c1 -window`;
  return { pid, start, cmd, wins: [w] };
}

test('WindowTiler.focusTargets: 대상 스택 게임만 내고 tile=false 면 창을 옮기지 않는다', () => {
  const moves: MoveCommand[] = [];
  const tiler = new WindowTiler({ stacksRoot: ROOT, stacks: ['llm*'], tile: false, move: (m) => moves.push(m), now: () => 1 });
  const procs = [
    stackProc(100, 1, 'llm2', gameWin(5000, { r: [10, 10, 1290, 706] })),
    stackProc(200, 2, 'llm3', gameWin(6000, { r: [50, 50, 1330, 746] })),
    stackProc(300, 3, 'fov', gameWin(7000)),
    { pid: 400, start: 4, cmd: 'arma3_x64.exe -mod=@CBA_A3', wins: [gameWin(8000)] },
  ];
  const s: AgentSnapshot = { area: AREA, human: -1, fg: 1, fgPid: TERMINAL_PID, btn: false, procs };
  tiler.onSnapshot(s);
  const targets = tiler.focusTargets(s);
  assert.deepEqual(
    targets.map((t) => [t.key, t.label, t.win?.h]),
    [
      ['100:1', 'llm2_c1', 5000],
      ['200:2', 'llm3_c1', 6000],
    ],
  );
  assert.deepEqual(moves, []);
  // 옮기지 않아도 상태 조회에는 지금 창 모드인지가 나오고 칸은 없다.
  assert.deepEqual(
    tiler.windows().map((w) => [w.label, w.slot, w.windowed]),
    [
      ['llm2_c1', null, true],
      ['llm3_c1', null, true],
    ],
  );
});

test('WindowTilerService: 관찰을 받으면 헬퍼에 deact 명령을 쓴다', async () => {
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { WindowTilerService } = await import('../src/tiler/tilerService.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'focusguard-'));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written: string[] = [];
  stdin.on('data', (b: Buffer) => written.push(...b.toString('utf8').split('\n').filter(Boolean)));
  const child = Object.assign(new EventEmitter(), { stdin, stdout, pid: 4242, exitCode: null, kill: () => true });
  const service = new WindowTilerService({
    stacksRoot: ROOT,
    stacks: [],
    stateFile: path.join(dir, 'window-tiler.json'),
    spawnAgent: async () => child as never,
  });
  try {
    service.start();
    await new Promise((r) => setImmediate(r));
    const s = { t: 'snap', area: AREA, human: -1, fg: 1, fgPid: TERMINAL_PID, btn: false, procs: [stackProc(100, 1, 'llm4', gameWin(5000))] };
    stdout.write(JSON.stringify(s) + '\n');
    stdout.write(JSON.stringify({ t: 'focus', op: 'deact', h: 5000, ok: true, why: null }) + '\n');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(written, ['deact 5000 100']);
  } finally {
    stdin.on('finish', () => child.emit('exit', 0));
    await service.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
