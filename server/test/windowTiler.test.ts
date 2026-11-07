// windowTiler.test.ts: 게임 창 4분할 판단. 헬퍼의 관찰을 손으로 만들어 넣고 옮기라는 명령만 본다.
//
// 실제 창은 docs/testing.md 의 창 4분할 시나리오가 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  WindowTiler,
  slotName,
  stackAllowed,
  tileAreas,
  measuredFrame,
  type AgentProc,
  type AgentSnapshot,
  type AgentWindow,
  type MoveCommand,
  type TilerState,
} from '../src/tiler/windowTiler.js';
import { fitAspect, tileClient, tileWindowRect, type Size } from '../src/tiler/tileGeometry.js';

const ROOT = path.resolve('C:\\Users\\me\\.arma-mcp\\stacks');
const AREA: [number, number, number, number] = [0, 0, 2560, 1392];
/** 주 모니터 네 칸에 놓인 바깥 창 사각형. */
const CELLS = [0, 1, 2, 3].map((i) => tileWindowRect({ l: 0, t: 0, r: 2560, b: 1392 }, i));

function harness(stacks: string[] = [], aspect?: Size) {
  let now = 1_000_000;
  const moves: MoveCommand[] = [];
  const logs: string[] = [];
  const tiler = new WindowTiler({
    stacksRoot: ROOT,
    stacks,
    ...(aspect ? { aspect } : {}),
    move: (m) => moves.push(m),
    log: (m) => logs.push(m),
    now: () => now,
  });
  return {
    tiler,
    moves,
    logs,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

function win(h: number, r: [number, number, number, number], extra: Partial<AgentWindow> = {}): AgentWindow {
  return { h, cls: 'Arma 3', r, cap: true, min: false, max: false, mv: false, ...extra };
}

function stackProc(pid: number, start: number, stack: string, client: number, w: AgentWindow | null): AgentProc {
  const cmd = `arma3_x64.exe -profiles="${path.join(ROOT, stack, `client${client}`)}" -name=${stack}_c${client} -window`;
  return { pid, start, cmd, wins: w ? [w] : [] };
}

function snap(procs: AgentProc[], human = -1): AgentSnapshot {
  return { area: AREA, human, procs };
}

// 이 PC 와 같은 배치: 가운데 주 모니터, 오른쪽 같은 크기, 왼쪽 작고 조금 위로 올라간 모니터. 헬퍼가 보낸 순서 그대로다.
const MONS: [number, number, number, number, number][] = [
  [2560, 0, 5120, 1392, 0],
  [0, 0, 2560, 1392, 1],
  [-2560, -87, -512, 1145, 0],
];

function snapMons(procs: AgentProc[], mons = MONS, human = -1): AgentSnapshot {
  return { area: AREA, mons, human, procs };
}

/** 헬퍼는 명령줄을 처음 한 번만 보낸다. 다음 관찰에서는 뺀다. */
function later(procs: AgentProc[]): AgentProc[] {
  return procs.map(({ cmd: _cmd, ...rest }) => rest);
}

const R = (c: { l: number; t: number; r: number; b: number }): [number, number, number, number] => [c.l, c.t, c.r, c.b];

test('fitAspect: 들어가는 가장 큰 크기를 비율 그대로 고른다', () => {
  // 1280x696 칸에서 테두리 16x39 를 뺀 1264x657 에는 16:9 가 1168x657 로 들어간다(높이에 걸린다).
  assert.deepEqual(fitAspect(1264, 657), { width: 1168, height: 657 });
  // 폭에 걸리면 폭에 맞춘다. 16 과 9 의 배수라 픽셀까지 16:9 다.
  assert.deepEqual(fitAspect(1008, 577), { width: 1008, height: 567 });
  assert.deepEqual(fitAspect(1264, 657, { width: 1600, height: 900 }), { width: 1168, height: 657 });
  assert.deepEqual(fitAspect(1264, 657, { width: 1920, height: 1200 }), { width: 1048, height: 655 });
  // 작은 정수로 안 줄어드는 비율은 비례로 고른다.
  assert.deepEqual(fitAspect(1264, 657, { width: 1263, height: 701 }), { width: 1183, height: 657 });
  assert.deepEqual(fitAspect(0, 657), { width: 0, height: 657 });
});

test('tileWindowRect: 2560x1392 의 네 창은 16:9 클라이언트 1168x657 이고 가운데에 붙어 모인다', () => {
  assert.deepEqual(tileClient({ l: 0, t: 0, r: 2560, b: 1392 }), { width: 1168, height: 657 });
  assert.deepEqual(CELLS, [
    { l: 96, t: 0, r: 1280, b: 696 },
    { l: 1280, t: 0, r: 2464, b: 696 },
    { l: 96, t: 696, r: 1280, b: 1392 },
    { l: 1280, t: 696, r: 2464, b: 1392 },
  ]);
  // 1920x1041 작업 영역은 왼쪽 위 칸 960x520 에 맞춘 848x477 네 창이다. 가운데 선은 작업 영역 절반이다.
  const odd = [0, 1, 2, 3].map((i) => tileWindowRect({ l: 0, t: 0, r: 1921, b: 1041 }, i));
  assert.deepEqual(odd, [
    { l: 96, t: 4, r: 960, b: 520 },
    { l: 960, t: 4, r: 1824, b: 520 },
    { l: 96, t: 520, r: 960, b: 1036 },
    { l: 960, t: 520, r: 1824, b: 1036 },
  ]);
  // 헬퍼가 잰 테두리 몫이 다르면 그 몫으로 바깥 창을 정한다.
  const thin = tileWindowRect({ l: 0, t: 0, r: 2560, b: 1392 }, 0, { left: 1, top: 23, right: 1, bottom: 1 });
  assert.deepEqual(thin, { l: 94, t: 6, r: 1280, b: 696 });
});

test('measuredFrame: 클라이언트 영역과 바깥 창의 차이, 못 쟀거나 이상하면 null', () => {
  assert.deepEqual(measuredFrame({ r: [96, 0, 1280, 696], c: [104, 31, 1272, 688] }), { left: 8, top: 31, right: 8, bottom: 8 });
  assert.equal(measuredFrame({ r: [96, 0, 1280, 696] }), null);
  assert.equal(measuredFrame({ r: [0, 0, 100, 100], c: [0, 0, 0, 0] }), null, '최소화된 창의 0 크기 클라이언트');
});

test('stackAllowed: 비면 모두, * 는 아무 글자', () => {
  assert.equal(stackAllowed('cqb', []), true);
  assert.equal(stackAllowed('llm3', ['default', 'llm*']), true);
  assert.equal(stackAllowed('LLM2', ['llm*']), true);
  assert.equal(stackAllowed('cqb', ['default', 'llm*']), false);
});

test('창이 하나뿐이면 옮기지 않는다', () => {
  const h = harness();
  const procs = [stackProc(10, 1, 'llm2', 1, win(100, [300, 200, 1916, 1139]))];
  h.tiler.onSnapshot(snap(procs));
  h.tiler.onSnapshot(snap(later(procs)));
  assert.equal(h.moves.length, 0);
  assert.deepEqual(
    h.tiler.windows().map((w) => [w.label, w.slot]),
    [['llm2_c1', null]],
  );
});

test('창이 둘이 되면 시작 순으로 왼쪽 위, 오른쪽 위에 놓고 닿으면 맞춤으로 끝낸다', () => {
  const h = harness();
  const a = stackProc(10, 1, 'llm2', 1, win(100, [300, 200, 1916, 1139]));
  h.tiler.onSnapshot(snap([a]));
  const b = stackProc(20, 2, 'llm3', 1, win(200, [500, 300, 2116, 1239]));
  h.tiler.onSnapshot(snap([...later([a]), b]));
  assert.deepEqual(h.moves, [
    { hwnd: 100, pid: 10, x: 96, y: 0, width: 1184, height: 696 },
    { hwnd: 200, pid: 20, x: 1280, y: 0, width: 1184, height: 696 },
  ]);
  // 게임이 창 메시지를 늦게 처리하는 동안에는 다시 보내지 않는다.
  h.advance(1000);
  h.tiler.onSnapshot(snap(later([a, b])));
  assert.equal(h.moves.length, 2);
  h.advance(2000);
  const placed = [
    { ...later([a])[0]!, wins: [win(100, R(CELLS[0]!))] },
    { ...later([b])[0]!, wins: [win(200, R(CELLS[1]!))] },
  ];
  h.tiler.onSnapshot(snap(placed));
  assert.ok(h.logs.some((l) => l.startsWith('맞춤: llm2_c1 칸 1')), h.logs.join('\n'));
  h.advance(5000);
  h.tiler.onSnapshot(snap(placed));
  assert.equal(h.moves.length, 2, '맞춘 뒤에는 그대로 둔다');
  assert.deepEqual(
    h.tiler.windows().map((w) => w.slot),
    [0, 1],
  );
});

test('대상 밖 창은 세지도 옮기지도 않는다', () => {
  const h = harness(['default', 'llm*']);
  const user = { pid: 30, start: 1, cmd: 'arma3_x64.exe -skipIntro -mod=@CBA_A3', wins: [win(300, [0, 0, 1600, 900])] };
  const other = stackProc(31, 2, 'cqb', 1, win(301, [0, 0, 1600, 900]));
  const ours = stackProc(32, 3, 'llm2', 1, win(302, [0, 0, 1600, 900]));
  h.tiler.onSnapshot(snap([user, other, ours]));
  assert.equal(h.moves.length, 0, '우리 창은 하나뿐이다');
  assert.ok(h.logs.some((l) => l.includes('pid 30 데몬이 띄운 스택 게임이 아님')));
  assert.ok(h.logs.some((l) => l.includes('pid 31 대상 밖 스택 cqb')));
});

test('-profiles 없는 default 클라는 데몬이 띄웠다고 알린 pid 만 본다', () => {
  const h = harness();
  h.tiler.noteLaunched({ pid: 40, stack: 'default', label: 'default' });
  const mine = { pid: 40, start: h.now(), cmd: 'arma3_x64.exe -window -x=1264 -y=657', wins: [win(400, [10, 10, 1290, 706])] };
  // 같은 pid 라도 띄운 때와 시작 시각이 크게 다르면 다른 프로세스다.
  h.tiler.noteLaunched({ pid: 41, stack: 'default', label: 'default' });
  const reused = { pid: 41, start: h.now() - 3_600_000, cmd: 'arma3_x64.exe', wins: [win(401, [0, 0, 800, 600])] };
  const named = stackProc(42, h.now() + 1, 'llm2', 1, win(402, [100, 100, 1716, 1039]));
  h.tiler.onSnapshot(snap([mine, reused, named]));
  assert.deepEqual(
    h.moves.map((m) => m.pid),
    [40, 42],
  );
});

test('알림을 잃은 default 클라는 -mod 의 스택 경로로 가르고 autotest cfg 이름은 보지 않는다', () => {
  const h = harness();
  const overlay = `"${path.join(ROOT, 'default', 'overlay', '@my_mod')};D:\\Mods\\@CBA_A3"`;
  const withOverlay = { pid: 60, start: 1, cmd: `arma3_x64.exe -window -mod=${overlay}`, wins: [win(600, [0, 0, 1600, 900])] };
  const withAutotest = {
    pid: 61,
    start: 2,
    cmd: 'arma3_x64.exe -window -autotest="C:\\Temp\\arma-mcp-autotest-730c8893d2695b13.cfg" -mod="D:\\Mods\\@CBA_A3"',
    wins: [win(601, [0, 0, 1600, 900])],
  };
  const user = { pid: 62, start: 3, cmd: 'arma3_x64.exe -window -autotest="C:\\Temp\\mine.cfg"', wins: [win(602, [0, 0, 1600, 900])] };
  h.tiler.onSnapshot(snap([withOverlay, withAutotest, user]));
  assert.deepEqual(
    h.tiler.windows().map((w) => [w.pid, w.stack]),
    [[60, 'default']],
    '다른 데몬도 같은 autotest cfg 이름을 쓴다',
  );
});

test('띄웠다는 알림이 관찰보다 늦어도 다음 관찰에서 대상으로 본다', () => {
  const h = harness();
  const other = stackProc(50, 1, 'llm2', 1, win(500, [0, 0, 1600, 900]));
  const def = { pid: 51, start: h.now(), cmd: 'arma3_x64.exe -window', wins: [win(501, [0, 0, 1600, 900])] };
  h.tiler.onSnapshot(snap([other, def]));
  assert.equal(h.moves.length, 0);
  h.tiler.noteLaunched({ pid: 51, stack: 'default', label: 'default' });
  h.tiler.onSnapshot(snap(later([other, def])));
  assert.equal(h.moves.length, 2);
});

test('사람이 옮긴 창은 다시 끌어오지 않고, 게임이 바꾼 자리는 칸으로 되돌린다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!))),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  assert.equal(h.moves.length, 0, '이미 칸에 있으면 옮기지 않는다');
  const moved = (rect: [number, number, number, number], rect2: [number, number, number, number]) => [
    { ...later(procs)[0]!, wins: [win(100, rect)] },
    { ...later(procs)[1]!, wins: [win(200, rect2)] },
  ];
  // llm2 는 사람이 끌어 옮겼고(직전 200 ms 에 마우스), 다음 관찰에서 llm3 는 게임이 크기를 바꿨다.
  h.tiler.onSnapshot(snap(moved([50, 60, 1330, 756], R(CELLS[1]!)), 200));
  h.advance(3000);
  h.tiler.onSnapshot(snap(moved([50, 60, 1330, 756], [1280, 0, 2560, 760]), -1));
  assert.deepEqual(
    h.moves.map((m) => m.pid),
    [20],
  );
  assert.ok(h.logs.some((l) => l.startsWith('손대지 않음: llm2_c1 칸 1')), h.logs.join('\n'));
  h.advance(10_000);
  h.tiler.onSnapshot(snap(moved([50, 60, 1330, 756], R(CELLS[1]!)), -1));
  assert.equal(h.moves.length, 1);
});

test('끄는 중이거나 최대화한 창은 사람이 한 것으로 본다', () => {
  const h = harness();
  const a = stackProc(10, 1, 'llm2', 1, win(100, [0, 0, 1600, 900], { max: true }));
  const b = stackProc(20, 2, 'llm3', 1, win(200, [0, 0, 1600, 900], { mv: true }));
  h.tiler.onSnapshot(snap([a, b]));
  assert.equal(h.moves.length, 0);
  assert.deepEqual(
    h.tiler.windows().map((w) => [w.slot, w.manual]),
    [
      [0, true],
      [1, true],
    ],
  );
});

test('다섯째 창은 칸 없이 두고, 칸이 비면 그 칸을 받는다', () => {
  const h = harness();
  const procs = [1, 2, 3, 4, 5].map((i) => stackProc(i * 10, i, `llm${i}`, 1, win(i * 100, [i, i, 1600 + i, 900 + i])));
  h.tiler.onSnapshot(snap(procs));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x, m.y]),
    [
      [10, 96, 0],
      [20, 1280, 0],
      [30, 96, 696],
      [40, 1280, 696],
    ],
  );
  assert.ok(h.logs.some((l) => l.startsWith('칸이 없음(창 4개 초과): llm5_c1')));
  // 둘째 창이 닫히면 다섯째가 그 칸(오른쪽 위)을 받는다.
  h.advance(9000);
  const rest = later(procs).filter((p) => p.pid !== 20);
  h.tiler.onSnapshot(snap(rest));
  const last = h.moves.at(-1)!;
  assert.deepEqual([last.pid, last.x, last.y], [50, 1280, 0]);
});

test('tileAreas: 주 모니터가 먼저이고 나머지는 왼쪽부터, 목록이 없으면 주 모니터 하나다', () => {
  assert.deepEqual(tileAreas({ area: AREA, mons: MONS }), [
    { l: 0, t: 0, r: 2560, b: 1392 },
    { l: -2560, t: -87, r: -512, b: 1145 },
    { l: 2560, t: 0, r: 5120, b: 1392 },
  ]);
  assert.deepEqual(tileAreas({ area: AREA }), [{ l: 0, t: 0, r: 2560, b: 1392 }]);
  assert.deepEqual(tileAreas({ area: AREA, mons: [] }), [{ l: 0, t: 0, r: 2560, b: 1392 }]);
  assert.equal(slotName(1), '오른쪽 위');
  assert.equal(slotName(6), '모니터 2 왼쪽 아래');
});

test('주 모니터 네 칸이 차면 왼쪽 모니터, 그다음 오른쪽 모니터 네 칸을 받고, 그 뒤는 칸 없이 둔다', () => {
  const h = harness();
  const procs = Array.from({ length: 13 }, (_, i) =>
    stackProc((i + 1) * 10, i + 1, `s${i + 1}`, 1, win((i + 1) * 100, [i, i, 1600 + i, 900 + i])),
  );
  h.tiler.onSnapshot(snapMons(procs));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x, m.y, m.width, m.height]),
    [
      [10, 96, 0, 1184, 696],
      [20, 1280, 0, 1184, 696],
      [30, 96, 696, 1184, 696],
      [40, 1280, 696, 1184, 696],
      // 왼쪽 모니터 2048x1232 는 1024x616 칸이고 16:9 클라이언트 1008x567, 바깥 창 1024x606 이다.
      [50, -2560, -77, 1024, 606],
      [60, -1536, -77, 1024, 606],
      [70, -2560, 529, 1024, 606],
      [80, -1536, 529, 1024, 606],
      [90, 2656, 0, 1184, 696],
      [100, 3840, 0, 1184, 696],
      [110, 2656, 696, 1184, 696],
      [120, 3840, 696, 1184, 696],
    ],
  );
  assert.ok(h.logs.some((l) => l === '칸 배정: s5_c1 (스택 s5) -> 칸 5 모니터 2 왼쪽 위'), h.logs.join('\n'));
  assert.ok(h.logs.some((l) => l.startsWith('칸이 없음(창 12개 초과): s13_c1')), h.logs.join('\n'));
});

test('모니터가 빠지면 그 모니터 칸의 창은 빈 칸을 다시 받는다', () => {
  const h = harness();
  const procs = [1, 2, 3, 4, 5].map((i) => stackProc(i * 10, i, `s${i}`, 1, win(i * 100, [i, i, 1600 + i, 900 + i])));
  h.tiler.onSnapshot(snapMons(procs));
  assert.deepEqual(h.moves.at(-1), { hwnd: 500, pid: 50, x: -2560, y: -77, width: 1024, height: 606 });
  h.advance(9000);
  // 주 모니터만 남기고 뽑았고 둘째 창이 닫혔다. 다섯째 창은 Windows 가 주 모니터로 옮겼다.
  const placed = [1, 3, 4].map((i) => ({ ...later(procs)[i - 1]!, wins: [win(i * 100, R(CELLS[i - 1]!))] }));
  const fifth = { ...later(procs)[4]!, wins: [win(500, [100, 100, 1124, 716])] };
  // 첫 관찰은 옮기기 기다림을 끝내고, 다음 관찰이 칸을 다시 찾는다.
  h.tiler.onSnapshot(snapMons([...placed, fifth], [MONS[1]!]));
  h.tiler.onSnapshot(snapMons([...placed, fifth], [MONS[1]!]));
  assert.ok(h.logs.some((l) => l.startsWith('모니터가 빠져 칸 5 이 없어짐: s5_c1')), h.logs.join('\n'));
  assert.deepEqual(h.moves.at(-1), { hwnd: 500, pid: 50, x: 1280, y: 0, width: 1184, height: 696 });
});

test('다른 모니터를 덮는 테두리 없는 창도 전체 화면으로 적는다', () => {
  const h = harness();
  const a = stackProc(10, 1, 'llm2', 1, win(100, [-2560, -87, -512, 1193], { cap: false }));
  const b = stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[0]!)));
  h.tiler.onSnapshot(snapMons([a, b]));
  assert.ok(h.logs.some((l) => l.startsWith('전체 화면(테두리 없음)이라 못 옮김: llm2_c1')), h.logs.join('\n'));
  assert.equal(h.moves.length, 0);
});

test('전체 화면 창은 옮기지 않고 창 모드가 되면 맞춘다', () => {
  const h = harness();
  const a = stackProc(10, 1, 'llm2', 1, win(100, [0, 0, 2560, 1440], { cap: false }));
  const b = stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[0]!)));
  h.tiler.onSnapshot(snap([a, b]));
  // 전체 화면 창은 칸을 받지 않아 llm3 가 왼쪽 위로 간다.
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x]),
    [],
  );
  assert.equal(h.tiler.windows()[1]!.slot, 0);
  h.tiler.onSnapshot(snap([{ ...later([a])[0]!, wins: [win(100, [200, 200, 1816, 1139])] }, ...later([b])]));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x, m.y]),
    [[10, 1280, 0]],
  );
});

test('목표에 끝내 안 닿으면 8초 뒤 그 자리를 받아들인다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, [0, 0, 1600, 900])),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  assert.equal(h.moves.length, 1);
  const stuck = [{ ...later(procs)[0]!, wins: [win(100, [0, 0, 1280, 720])] }, later(procs)[1]!];
  h.advance(7000);
  h.tiler.onSnapshot(snap(stuck));
  assert.equal(h.moves.length, 1);
  h.advance(1500);
  h.tiler.onSnapshot(snap(stuck));
  assert.ok(h.logs.some((l) => l.startsWith('칸에 다 안 맞음: llm2_c1')), h.logs.join('\n'));
  h.advance(1000);
  h.tiler.onSnapshot(snap(stuck));
  assert.equal(h.moves.length, 1, '받아들인 자리는 다시 옮기지 않는다');
});

test('둘에서 하나로 줄면 남은 창을 그대로 두고, 그 사이 사람이 옮긴 것은 기억한다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!))),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  const solo = { ...later(procs)[0]!, wins: [win(100, [400, 400, 1680, 1096])] };
  h.tiler.onSnapshot(snap([solo], 100));
  assert.equal(h.moves.length, 0);
  const again = stackProc(30, 3, 'llm4', 1, win(300, [0, 0, 1600, 900]));
  h.tiler.onSnapshot(snap([solo, again], -1));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x]),
    [[30, 1280]],
    '사람이 옮긴 llm2 는 그대로이고 새 창이 빈 칸을 받는다',
  );
});

test('상태를 내보내고 다시 받으면 같은 칸과 사람 표시를 이어받는다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[1]!), { max: true })),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  const state = h.tiler.exportState();
  const h2 = harness();
  h2.tiler.importState(JSON.parse(JSON.stringify(state)));
  h2.tiler.onSnapshot(snap(procs));
  assert.deepEqual(
    h2.tiler.windows().map((w) => [w.label, w.slot, w.manual]),
    [
      ['llm2_c1', 0, true],
      ['llm3_c1', 1, false],
    ],
  );
  // 같은 pid 에 다른 시작 시각이면 이어받지 않는다.
  const h3 = harness();
  h3.tiler.importState(JSON.parse(JSON.stringify(state)));
  h3.tiler.onSnapshot(snap([stackProc(10, 99, 'llm2', 1, win(100, [0, 0, 1600, 900]))]));
  assert.deepEqual(
    h3.tiler.windows().map((w) => [w.slot, w.manual]),
    [[null, false]],
  );
});

test('같은 pid 가 다른 프로세스에 다시 쓰이면 닫힌 창으로 보고 칸을 비운다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!))),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  h.tiler.onSnapshot(snap([later(procs)[0]!, { pid: 20, start: 50, cmd: 'notepad', wins: [] }]));
  assert.ok(h.logs.some((l) => l.startsWith('닫힘: llm3_c1 pid 20, 칸 2 비움')), h.logs.join('\n'));
  assert.deepEqual(
    h.tiler.windows().map((w) => w.label),
    ['llm2_c1'],
  );
});

test('띄운 클라를 한 번 맞춘 뒤에는 같은 시작 시각만 그 클라로 본다', () => {
  const h = harness();
  h.tiler.noteLaunched({ pid: 70, stack: 'default', label: 'default' });
  const first = { pid: 70, start: h.now(), cmd: 'arma3_x64.exe -window', wins: [win(700, [0, 0, 1600, 900])] };
  h.tiler.onSnapshot(snap([first]));
  assert.equal(h.tiler.windows().length, 1);
  // 그 게임이 끝나고 10초 뒤 같은 pid 로 사용자 게임이 떴다. 띄운 시각과 30초 안이지만 다른 프로세스다.
  h.advance(10_000);
  const user = { pid: 70, start: h.now(), cmd: 'arma3_x64.exe -window', wins: [win(701, [0, 0, 1600, 900])] };
  h.tiler.onSnapshot(snap([user]));
  assert.equal(h.tiler.windows().length, 0);
});

test('옮기기를 기다리는 사이 사람이 옮기면 그 창은 손대지 않는다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, [300, 300, 1916, 1239])),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  assert.equal(h.moves.length, 1);
  // 게임이 아직 안 옮긴 사이 사람이 Win+방향키로 옮겼다.
  h.advance(1000);
  const snapped = [{ ...later(procs)[0]!, wins: [win(100, [0, 0, 1280, 1392])] }, later(procs)[1]!];
  h.tiler.onSnapshot(snap(snapped, 100));
  assert.equal(h.tiler.windows()[0]!.manual, true);
  // 나중에 게임이 크기를 바꿔도 끌어오지 않는다.
  h.advance(20_000);
  h.tiler.onSnapshot(snap([{ ...later(procs)[0]!, wins: [win(100, [0, 0, 1200, 1300])] }, later(procs)[1]!], -1));
  assert.equal(h.moves.length, 1);
});

test('관찰이 늦게 와도 기다림 시간이 지나면 지금 자리를 받아들인다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, [0, 0, 1600, 900])),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  h.advance(15_000);
  const stuck = [{ ...later(procs)[0]!, wins: [win(100, [0, 0, 1280, 720])] }, later(procs)[1]!];
  h.tiler.onSnapshot(snap(stuck));
  h.tiler.onSnapshot(snap(stuck));
  assert.equal(h.moves.length, 1);
  assert.ok(h.logs.some((l) => l.startsWith('칸에 다 안 맞음: llm2_c1')), h.logs.join('\n'));
});

test('이어받은 창의 자리가 바뀌어 있으면 끌어오지 않는다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!))),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  const state = JSON.parse(JSON.stringify(h.tiler.exportState()));
  // 데몬이 꺼진 사이 사람이 llm2 를 옮겼다. 새 헬퍼는 그 입력을 모른다.
  const h2 = harness();
  h2.tiler.importState(state);
  h2.tiler.onSnapshot(snap([{ ...procs[0]!, wins: [win(100, [500, 500, 1780, 1196])] }, procs[1]!], -1));
  assert.equal(h2.moves.length, 0);
  assert.ok(h2.logs.some((l) => l.includes('그대로 둔다: llm2_c1')), h2.logs.join('\n'));
});

test('첫 관찰 전에 내보내도 이어받은 저장 항목을 잃지 않고, 죽은 항목은 관찰 뒤 버린다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!), { max: true })),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  const state = JSON.parse(JSON.stringify(h.tiler.exportState()));
  const h2 = harness();
  h2.tiler.importState(state);
  assert.deepEqual(
    h2.tiler.exportState().windows.map((w) => [w.pid, w.slot, w.manual]),
    [
      [10, 0, true],
      [20, 1, false],
    ],
  );
  h2.tiler.onSnapshot(snap([procs[1]!]));
  assert.deepEqual(
    h2.tiler.exportState().windows.map((w) => w.pid),
    [20],
  );
});

test('시작 화면 창을 전체 화면으로 적지 않고, 창이 잠깐 없어도 놓기를 쉬지 않는다', () => {
  const h = harness();
  const a = stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!)));
  const splash = stackProc(20, 2, 'llm3', 1, win(200, [1024, 592, 1536, 848], { cap: false, cls: 'splash' }));
  h.tiler.onSnapshot(snap([a, splash]));
  // 시작 화면이 닫히고 게임 창이 아직 없다.
  h.tiler.onSnapshot(snap([later([a])[0]!, { ...later([splash])[0]!, wins: [] }]));
  h.tiler.onSnapshot(snap([later([a])[0]!, { ...later([splash])[0]!, wins: [win(201, [0, 461, 1616, 1400])] }]));
  assert.ok(!h.logs.some((l) => l.startsWith('전체 화면')), h.logs.join('\n'));
  assert.equal(h.logs.filter((l) => l.includes('놓기')).length, 1, h.logs.join('\n'));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x]),
    [[20, 1280]],
  );
});

test('헬퍼가 잰 테두리 몫으로 클라이언트 영역이 16:9 가 되게 놓는다', () => {
  const h = harness();
  // 테두리가 왼쪽, 오른쪽, 아래 1, 위 23 인 창이다.
  const thin = (h0: number, r: [number, number, number, number]) =>
    win(h0, r, { c: [r[0] + 1, r[1] + 23, r[2] - 1, r[3] - 1] });
  const a = stackProc(10, 1, 'llm2', 1, thin(100, [300, 200, 1902, 1124]));
  const b = stackProc(20, 2, 'llm3', 1, thin(200, [500, 300, 2102, 1224]));
  h.tiler.onSnapshot(snap([a, b]));
  assert.deepEqual(h.moves, [
    { hwnd: 100, pid: 10, x: 94, y: 6, width: 1186, height: 690 },
    { hwnd: 200, pid: 20, x: 1280, y: 6, width: 1186, height: 690 },
  ]);
  for (const m of h.moves) assert.equal((m.width - 2) * 9, (m.height - 24) * 16, '클라이언트 영역이 16:9');
});

test('설정 비율(stacks.windowWidth:windowHeight)로 칸 안 창 크기를 정한다', () => {
  const h = harness([], { width: 1920, height: 1200 });
  const a = stackProc(10, 1, 'llm2', 1, win(100, [300, 200, 1916, 1139]));
  const b = stackProc(20, 2, 'llm3', 1, win(200, [500, 300, 2116, 1239]));
  h.tiler.onSnapshot(snap([a, b]));
  // 16:10 클라이언트 1048x655, 바깥 창 1064x694.
  assert.deepEqual(h.moves[0], { hwnd: 100, pid: 10, x: 216, y: 2, width: 1064, height: 694 });
});

test('이전 데몬이 1280x696 칸에 놓은 창은 이어받은 뒤 16:9 칸으로 한 번 다시 맞춘다', () => {
  const OLD = [
    [0, 0, 1280, 696],
    [1280, 0, 2560, 696],
  ] as [number, number, number, number][];
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, OLD[0]!)),
    stackProc(20, 2, 'llm3', 1, win(200, OLD[1]!)),
  ];
  // 0.5.9 데몬이 남긴 상태: aimed 가 없다.
  const old: TilerState = {
    v: 1,
    launched: [],
    windows: [0, 1].map((i) => ({
      pid: (i + 1) * 10,
      start: i + 1,
      slot: i,
      manual: false,
      manualWhy: null,
      wasWindowed: true,
      hasApplied: true,
      applied: { l: OLD[i]![0], t: OLD[i]![1], r: OLD[i]![2], b: OLD[i]![3] },
    })),
  };
  const h = harness();
  h.tiler.importState(old);
  h.tiler.onSnapshot(snap(procs));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x, m.y, m.width, m.height]),
    [
      [10, 96, 0, 1184, 696],
      [20, 1280, 0, 1184, 696],
    ],
  );
  assert.ok(h.logs.some((l) => l.startsWith('옮김(칸이 (0,0 1280x696) 에서 (96,0 1184x696) 로 바뀜): llm2_c1')), h.logs.join('\n'));
  // 맞춘 뒤에는 그대로 둔다.
  h.advance(1000);
  const placed = [0, 1].map((i) => ({ ...later(procs)[i]!, wins: [win((i + 1) * 100, R(CELLS[i]!))] }));
  h.tiler.onSnapshot(snap(placed));
  h.advance(5000);
  h.tiler.onSnapshot(snap(placed));
  assert.equal(h.moves.length, 2);
});

test('사람이 옮긴 창과 데몬이 꺼진 사이 옮겨진 창은 칸이 바뀌어도 다시 맞추지 않는다', () => {
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, [10, 10, 1290, 706])),
    stackProc(20, 2, 'llm3', 1, win(200, [1280, 0, 2560, 696])),
  ];
  const old: TilerState = {
    v: 1,
    launched: [],
    windows: [
      { pid: 10, start: 1, slot: 0, manual: false, manualWhy: null, wasWindowed: true, hasApplied: true, applied: { l: 0, t: 0, r: 1280, b: 696 } },
      { pid: 20, start: 2, slot: 1, manual: true, manualWhy: '최대화', wasWindowed: true, hasApplied: true, applied: { l: 1280, t: 0, r: 2560, b: 696 } },
    ],
  };
  const h = harness();
  h.tiler.importState(old);
  h.tiler.onSnapshot(snap(procs));
  h.advance(3000);
  h.tiler.onSnapshot(snap(later(procs)));
  assert.equal(h.moves.length, 0, h.logs.join('\n'));
});

test('작업 영역이 바뀌면 데몬이 놓은 그대로인 창을 새 칸으로 한 번 다시 맞춘다', () => {
  const h = harness();
  const procs = [
    stackProc(10, 1, 'llm2', 1, win(100, R(CELLS[0]!))),
    stackProc(20, 2, 'llm3', 1, win(200, R(CELLS[1]!))),
  ];
  h.tiler.onSnapshot(snap(procs));
  assert.equal(h.moves.length, 0);
  // 작업 표시줄이 사라져 작업 영역이 2560x1440 이 됐다. 칸 1280x720 에 16:9 클라이언트 1200x675, 바깥 창 1216x714 가 들어간다.
  const tall = (procsNow: AgentProc[]): AgentSnapshot => ({ area: [0, 0, 2560, 1440], human: -1, procs: procsNow });
  h.tiler.onSnapshot(tall(later(procs)));
  assert.deepEqual(
    h.moves.map((m) => [m.pid, m.x, m.y, m.width, m.height]),
    [
      [10, 64, 6, 1216, 714],
      [20, 1280, 6, 1216, 714],
    ],
  );
});

test('plannedClientSizes: 다른 게임 창이 있으면 새 클라가 받을 칸의 16:9 크기, 아니면 null', () => {
  const h = harness();
  assert.equal(h.tiler.plannedClientSizes('llm9', 1), null, '관찰 전에는 모른다');
  const a = stackProc(10, 1, 'llm2', 1, win(100, [300, 200, 1916, 1139]));
  h.tiler.onSnapshot(snapMons([a]));
  // 혼자 뜬 창은 아직 칸이 없다. 새 클라가 뜨면 그 창이 왼쪽 위를 받고 새 클라는 오른쪽 위다.
  assert.deepEqual(h.tiler.plannedClientSizes('llm9', 1), [{ width: 1168, height: 657 }]);
  // 같은 스택의 창은 이번 실행이 끄므로 세지 않는다. 그러면 새 클라 혼자라 놓지 않는다.
  assert.equal(h.tiler.plannedClientSizes('llm2', 1), null);
  // 한 스택의 클라 둘이면 다른 창 없이도 놓는다.
  assert.deepEqual(h.tiler.plannedClientSizes('llm2', 2), [
    { width: 1168, height: 657 },
    { width: 1168, height: 657 },
  ]);
});

test('plannedClientSizes: 주 모니터 칸이 차면 다음 모니터 칸 크기, 모든 칸이 차면 null 항목', () => {
  const h = harness();
  const procs = [1, 2, 3, 4].map((i) => stackProc(i * 10, i, `s${i}`, 1, win(i * 100, [i, i, 1600 + i, 900 + i])));
  h.tiler.onSnapshot(snapMons(procs));
  // 왼쪽 모니터 2048x1232 는 1008x567, 오른쪽은 1168x657 이다.
  const sizes = h.tiler.plannedClientSizes('new', 9);
  assert.deepEqual(sizes?.slice(3, 5), [
    { width: 1008, height: 567 },
    { width: 1168, height: 657 },
  ]);
  assert.equal(sizes?.[8], null);
  // 칸 놓기를 끄거나 대상 밖 스택이면 null 이다.
  const off = new WindowTiler({ stacksRoot: ROOT, stacks: [], tile: false, move: () => {} });
  off.onSnapshot(snapMons(procs));
  assert.equal(off.plannedClientSizes('new', 1), null);
  const only = harness(['s*']);
  only.tiler.onSnapshot(snapMons(procs));
  assert.equal(only.tiler.plannedClientSizes('cqb', 1), null);
});
