import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadConfig } from '../src/config.js';
import {
  BridgeReadinessTracker,
  MpLauncher,
  SERVER_READY_BY_BRIDGE,
  SERVER_READY_PATTERN,
  killSucceeded,
  nameFlagIn,
  waitServerReady,
  type MpProcFns,
} from '../src/launch/mpLauncher.js';
import { waitForPattern } from '../src/rpt/rptReader.js';
import { SERVER_RPT_RE } from '../src/rpt/rptFiles.js';
import type { PathUnlockResult } from '../src/procs.js';
import type { Gateway } from '../src/ipc/gateway.js';
import type { MissionSnapshot, TelemetryStore } from '../src/game/telemetry.js';

// dryRun 경로만 단위 테스트(부작용 없음). 실제 spawn 은 실기기 E2E 로 검증.

function setup(extraCfg: Record<string, unknown> = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-mp-'));
  const mission = path.join(base, 'missions', 'demo.VR');
  mkdirSync(mission, { recursive: true });
  writeFileSync(path.join(mission, 'mission.sqm'), 'sqm', 'utf8');

  const profilesDir = path.join(base, 'profiles');
  const mpMissionsDir = path.join(base, 'MPMissions');
  const cfgPath = path.join(base, 'cfg.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      arma: {
        exePath: 'C:\\game\\arma3_x64.exe',
        baseArgs: ['-skipIntro', '-noSplash'],
        selfModPath: 'D:\\mods\\@arma_mcp',
      },
      mp: { port: 2402, profilesDir, mpMissionsDir },
      ...extraCfg,
    }),
    'utf8',
  );
  const cfg = loadConfig(cfgPath);
  const rptDir = path.join(base, 'rpt'); // 비어 있음 — modset='explicit' 만 사용
  mkdirSync(rptDir, { recursive: true });
  return { cfg, rptDir, mission, profilesDir, mpMissionsDir };
}

test('launchMp dryRun: 서버/클라 인자·server.cfg 조립, 부작용 없음', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'explicit',
    mods: ['D:\\mods\\@cba'],
    dryRun: true,
  });

  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.mission.template, 'demo.VR');

  // 서버 인자.
  assert.match(res.server.argString, /-config=".*server\.cfg"/);
  assert.match(res.server.argString, /-port=2402/);
  assert.ok(res.server.argString.includes(`-profiles="${s.profilesDir}"`));
  assert.doesNotMatch(res.server.argString, /-autoInit/);
  // selfModPath 보장 — 서버에도 @arma_mcp 로드.
  assert.ok(res.server.argString.includes('-mod="D:\\mods\\@cba;D:\\mods\\@arma_mcp"'));

  // 클라 인자: baseArgs + -connect (+-autotest 없음).
  assert.ok(res.client);
  assert.match(res.client!.argString, /^-skipIntro -noSplash /);
  assert.match(res.client!.argString, /-connect=127\.0\.0\.1 -port=2402/);
  assert.doesNotMatch(res.client!.argString, /-autotest/);
  assert.ok(res.client!.argString.includes('-mod="D:\\mods\\@cba;D:\\mods\\@arma_mcp"'));

  // server.cfg 본문.
  assert.match(res.serverCfgText!, /template = "demo\.VR";/);
  assert.match(res.serverCfgText!, /persistent = 0;/);

  // 부작용 없음: 배치·profiles 디렉토리 미생성.
  assert.equal(existsSync(s.mpMissionsDir), false);
  assert.equal(existsSync(s.profilesDir), false);
});

test('launchMp dryRun: autoInit 이면 -autoInit + persistent=1', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    autoInit: true,
    dryRun: true,
  });
  assert.match(res.server.argString, /-autoInit/);
  assert.match(res.serverCfgText!, /persistent = 1;/);
});

test('launchMp dryRun: autoInit 이면 서버가 로비 역할을 기본 배정하고, 로비 대기는 그대로 둔다', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const auto = await mp.launchMp({ mission: s.mission, modset: 'none', autoInit: true, dryRun: true });
  assert.equal(auto.ok, true, auto.error);
  assert.deepEqual(auto.autoSlot, { entries: [], cfgLines: true });
  assert.match(auto.serverCfgText!, /^skipLobby = 1;$/m);
  // 지정이 없으면 훅은 아무 값도 돌려주지 않아 서버 기본 배정이다.
  assert.match(auto.serverCfgText!, /OnAutoSelectRole = "private _want = \[\];/);

  const lobby = await mp.launchMp({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(lobby.autoSlot, undefined);
  assert.doesNotMatch(lobby.serverCfgText!, /skipLobby|OnAutoSelectRole/);

  const off = await mp.launchMp({ mission: s.mission, modset: 'none', autoInit: true, autoSlot: false, dryRun: true });
  assert.equal(off.autoSlot, undefined);
  assert.doesNotMatch(off.serverCfgText!, /skipLobby|OnAutoSelectRole/);
});

test('launchMp dryRun: 지정 역할은 클라 순서로 훅에 들어간다', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    autoInit: true,
    autoSlotRoles: ['Medic'],
    dryRun: true,
  });
  assert.equal(res.ok, true, res.error);
  // default 스택 클라 1 은 -name 이 없어 이름 '' 항목이다.
  assert.deepEqual(res.autoSlot?.entries, [{ name: '', role: 'Medic' }]);
  assert.match(res.serverCfgText!, /private _want = \[\['', 'Medic'\]\];/);
});

test('launchMp: 로비 대기에 autoSlot 이나 roles 를 주거나 roles 가 클라보다 많으면 띄우지 않는다', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const lobbySlot = await mp.launchMp({ mission: s.mission, modset: 'none', autoSlot: true, dryRun: true });
  assert.equal(lobbySlot.ok, false);
  assert.match(lobbySlot.error!, /autoInit 서버에서만/);

  const lobbyRoles = await mp.launchMp({ mission: s.mission, modset: 'none', autoSlotRoles: ['Medic'], dryRun: true });
  assert.equal(lobbyRoles.ok, false);
  assert.match(lobbyRoles.error!, /roles 는 서버가 역할을 배정할 때만/);

  const offRoles = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    autoInit: true,
    autoSlot: false,
    autoSlotRoles: ['Medic'],
    dryRun: true,
  });
  assert.equal(offRoles.ok, false);
  assert.match(offRoles.error!, /roles 는 서버가 역할을 배정할 때만/);

  const tooMany = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    autoInit: true,
    autoSlotRoles: ['Medic', 'Rifleman'],
    dryRun: true,
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error!, /roles 는 2 개인데 clients 는 1/);
});

test('launchMp dryRun: serverOnly 면 client 없음', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    serverOnly: true,
    dryRun: true,
  });
  assert.equal(res.client, undefined);
});

test('launchServer dryRun: serverOnly + autoInit 을 호출자가 바꿀 수 없게 고정', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchServer({
    mission: s.mission,
    modset: 'none',
    dryRun: true,
  });
  assert.equal(res.ok, true);
  assert.equal(res.client, undefined);
  assert.match(res.server.argString, /-autoInit/);
  assert.match(res.serverCfgText!, /persistent = 1;/);
  assert.match(res.warning!, /respawn|플레이어 0명/);
  // 나중에 붙는 클라도 로비 없이 서버 기본 배정으로 들어간다.
  assert.deepEqual(res.autoSlot, { entries: [], cfgLines: true });
  assert.match(res.serverCfgText!, /^skipLobby = 1;$/m);

  const off = await mp.launchServer({ mission: s.mission, modset: 'none', autoSlot: false, dryRun: true });
  assert.equal(off.autoSlot, undefined);
  assert.doesNotMatch(off.serverCfgText!, /skipLobby|OnAutoSelectRole/);
});

test('launchServer dryRun: INSTANT respawn 미션은 persistence 경고가 없다', async () => {
  const s = setup();
  writeFileSync(path.join(s.mission, 'description.ext'), 'respawn = 2;\n', 'utf8');
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchServer({
    mission: s.mission,
    modset: 'none',
    dryRun: true,
  });
  assert.equal(res.warning, undefined);
});

test('launchMp dryRun: password 는 클라 인자와 server.cfg 양쪽에', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    password: 'pw123',
    dryRun: true,
  });
  assert.match(res.client!.argString, /-password=pw123/);
  assert.match(res.serverCfgText!, /password = "pw123";/);
});

test('launchMp: 미션 미존재는 명시 에러', async () => {
  const s = setup();
  const mp = new MpLauncher(s.cfg, s.rptDir);
  const res = await mp.launchMp({ mission: 'C:\\no\\such\\mission.VR', dryRun: true });
  assert.equal(res.ok, false);
  assert.match(res.error!, /mission not found/);
});

test('bridge readiness rejects stale generation and accepts a complete new dedicated link', async () => {
  const events = new EventEmitter();
  let generation = 7;
  const gateway = events as unknown as Gateway;
  Object.assign(gateway, { generation: () => generation });

  const snapshot: MissionSnapshot = {
    world: 'Altis',
    mission: 'demo',
    briefing: '',
    dedicated: true,
    multiplayer: true,
    cba: false,
    ace: false,
    aceVersion: '',
    aceComponents: [],
    missionTime: 0,
    date: [],
    fps: 40,
    players: [],
    playerCount: 0,
    receivedAt: Date.now(),
  };
  const telemetry = { current: () => snapshot } as unknown as TelemetryStore;
  const tracker = new BridgeReadinessTracker(gateway, telemetry, 7, Date.now() - 1, 'demo.Altis');

  events.emit('hello', { type: 'hello' });
  events.emit('sessionInfo', {
    type: 'sessionInfo',
    dedicated: true,
    world: 'Altis',
    mission: 'demo',
  });
  events.emit('telemetry', { type: 'telemetry' });
  const stale = await tracker.wait(1);
  assert.equal(stale.ready, false);
  assert.equal(stale.generation, 7);

  generation = 8;
  events.emit('connected', { via: 'pipe' });
  events.emit('hello', { type: 'hello' });
  events.emit('sessionInfo', {
    type: 'sessionInfo',
    dedicated: true,
    world: 'Stratis',
    mission: 'demo',
  });
  snapshot.world = 'Stratis';
  snapshot.receivedAt = Date.now();
  events.emit('telemetry', { type: 'telemetry' });
  const wrongWorld = await tracker.wait(1);
  assert.equal(wrongWorld.ready, false);
  assert.equal(wrongWorld.actual.world, 'Stratis');

  generation = 9;
  events.emit('connected', { via: 'pipe' });
  events.emit('hello', { type: 'hello' });
  events.emit('sessionInfo', {
    type: 'sessionInfo',
    dedicated: true,
    world: 'Altis',
    mission: 'demo',
  });
  snapshot.world = 'Altis';
  snapshot.receivedAt = Date.now();
  events.emit('telemetry', { type: 'telemetry' });
  const fresh = await tracker.wait(100);
  tracker.dispose();

  assert.equal(fresh.ready, true);
  assert.equal(fresh.baselineGeneration, 7);
  assert.equal(fresh.generation, 9);
  assert.deepEqual(fresh.expected, { template: 'demo.Altis', world: 'Altis' });
  assert.deepEqual(fresh.actual, { mission: 'demo', world: 'Altis', dedicated: true });
  assert.equal(fresh.telemetrySnapshot?.playerCount, 0);
});

// ── 서버 준비 판정 ──

// 실제 데디 서버 RPT(arma3server_x64_2026-09-23_15-21-22.rpt)에서 옮긴 줄이다.
// "Host identity created" 는 서버 콘솔에만 찍히고 RPT 에는 없다(엔진 분석, 서버 RPT 39개에 0줄).
// 0.4.1 이하는 그 줄만 기다려 준비 판정이 매번 시간 초과로 끝났다.
const REAL_GAME_PORT_LINE =
  '15:21:27 Initializing Steam server - Game Port: 2302, Steam Query Port: 2303';
const REAL_APPID_LINE = '15:21:27 Steam AppId in current environment: 107410';
const REAL_STEAM_CONNECTED_LINE =
  '15:21:30 Connected to Steam servers. Temporary Steam ID: 90293271827753988';

test('SERVER_READY_PATTERN: 실제 서버 RPT 의 Game Port 줄과 Steam 접속 줄에 맞는다', () => {
  const re = new RegExp(SERVER_READY_PATTERN, 'i');
  assert.match(REAL_GAME_PORT_LINE, re);
  assert.match('14:50:29 Initializing Steam server - Game Port: 2302, Steam Query Port: 2303', re);
  assert.match(REAL_STEAM_CONNECTED_LINE, re);
  assert.match('14:50:32 Connected to Steam servers', re);
  // 콘솔 전용 줄은 기다리지 않는다.
  assert.doesNotMatch('10:00:00 Host identity created.', re);
  assert.doesNotMatch('10:00:05 Player a_c1 connecting.', re);
  assert.doesNotMatch(REAL_APPID_LINE, re);
  assert.doesNotMatch('Steam AppId: 107410', re);
});

test('SERVER_READY_PATTERN: waitForPattern 이 교대 패턴으로 첫 부팅 줄을 찾는다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-mp-ready-'));
  const rpt = path.join(dir, 'arma3server_x64_2026-09-23_15-21-22.rpt');
  writeFileSync(
    rpt,
    [
      '15:21:26 Dedicated host created.',
      REAL_GAME_PORT_LINE,
      REAL_APPID_LINE,
      REAL_STEAM_CONNECTED_LINE,
      '',
    ].join('\r\n'),
    'utf8',
  );
  const res = await waitForPattern(dir, {
    pattern: SERVER_READY_PATTERN,
    file: rpt,
    fromEnd: false,
    timeoutMs: 1000,
    pollMs: 50,
    rptRe: SERVER_RPT_RE,
  });
  assert.equal(res.found, true);
  assert.match(res.line!, /Game Port: 2302/);
});

// ── killMp: 종료 확인과 잠금 해제 대기 ──

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FakeProcLog {
  waits: { image: string; timeoutMs: number; pollMs: number | undefined }[];
  unlockCalls: { paths: readonly string[]; timeoutMs: number }[];
  maxConcurrentWaits: number;
}

function fakeProcs(opts: {
  running: string[];
  serverImage?: string | null;
  waitResult?: (image: string) => boolean;
  waitDelayMs?: number;
  unlock?: (paths: readonly string[]) => PathUnlockResult[];
}): { fns: Partial<MpProcFns>; log: FakeProcLog } {
  const running = new Set(opts.running);
  const log: FakeProcLog = { waits: [], unlockCalls: [], maxConcurrentWaits: 0 };
  let inFlight = 0;
  const fns: Partial<MpProcFns> = {
    findRunningServerImage: async () => opts.serverImage ?? null,
    isProcRunningAsync: async (image) => running.has(image),
    killProcAsync: async (image) =>
      running.has(image)
        ? { killed: true, detail: `${image} 강제 종료` }
        : { killed: false, detail: `${image} 미실행` },
    waitProcGone: async (image, timeoutMs, pollMs) => {
      log.waits.push({ image, timeoutMs, pollMs });
      inFlight += 1;
      log.maxConcurrentWaits = Math.max(log.maxConcurrentWaits, inFlight);
      await sleep(opts.waitDelayMs ?? 30);
      inFlight -= 1;
      return opts.waitResult ? opts.waitResult(image) : true;
    },
    waitPathsWritable: async (paths, o) => {
      log.unlockCalls.push({ paths, timeoutMs: o.timeoutMs });
      return opts.unlock
        ? opts.unlock(paths)
        : paths.map((p) => ({ path: p, ok: true, waitedMs: 0 }));
    },
  };
  return { fns, log };
}

test('killMp: 종료한 프로세스가 사라질 때까지 기본 15초 상한으로 기다린다', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({ running: ['arma3_x64.exe'], waitDelayMs: 60 });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('all');

  assert.equal(res.client?.killed, true);
  assert.equal(res.client?.gone, true);
  assert.ok(res.client!.waitedMs >= 50, `실제로 기다려야 한다 (${res.client!.waitedMs}ms)`);
  // 서버는 실행 중이 아니었다. 기다릴 것도 없다.
  assert.deepEqual(res.server, {
    killed: false,
    gone: true,
    waitedMs: 0,
    detail: 'arma3server_x64.exe 미실행',
  });
  assert.deepEqual(log.waits, [{ image: 'arma3_x64.exe', timeoutMs: 15000, pollMs: 150 }]);
  assert.equal(res.unlock, undefined);
  assert.equal(killSucceeded(res), true);
});

test('killMp: 클라와 서버 종료 대기는 병렬로 돈다', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({
    running: ['arma3_x64.exe', 'arma3serverprofiling_x64.exe'],
    serverImage: 'arma3serverprofiling_x64.exe',
    waitDelayMs: 50,
  });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('all', { waitMs: 5000 });
  assert.equal(res.client?.gone, true);
  assert.equal(res.server?.gone, true);
  assert.equal(log.maxConcurrentWaits, 2);
  assert.deepEqual(
    log.waits.map((w) => `${w.image}:${w.timeoutMs}`).sort(),
    ['arma3_x64.exe:5000', 'arma3serverprofiling_x64.exe:5000'],
  );
});

test('killMp: 상한 안에 사라지지 않으면 gone:false 이고 성공이 아니다', async () => {
  const s = setup();
  const { fns } = fakeProcs({ running: ['arma3_x64.exe'], waitResult: () => false });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', { waitMs: 200 });
  assert.equal(res.client?.killed, true);
  assert.equal(res.client?.gone, false);
  assert.equal(res.server, undefined);
  assert.equal(killSucceeded(res), false);
});

test('killMp: waitMs 0 이면 기다리지 않고 gone 을 적지 않는다', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({ running: ['arma3_x64.exe'] });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', { waitMs: 0 });
  assert.deepEqual(res.client, { killed: true, detail: 'arma3_x64.exe 강제 종료', waitedMs: 0 });
  assert.equal(log.waits.length, 0);
  assert.equal(killSucceeded(res), true);
});

test('killMp: 종료 뒤 unlockPaths 를 남은 시간 안에서 기다리고 결과를 싣는다', async () => {
  const s = setup();
  const locked = 'D:\\mods\\@demo\\addons';
  const { fns, log } = fakeProcs({
    running: ['arma3_x64.exe'],
    waitDelayMs: 40,
    unlock: (paths) =>
      paths.map((p) =>
        p === locked
          ? {
              path: p,
              ok: false,
              waitedMs: 100,
              code: 'EBUSY',
              reason: '시간 안에 잠금이 풀리지 않음: demo.pbo',
            }
          : { path: p, ok: true, waitedMs: 5 },
      ),
  });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', {
    waitMs: 1000,
    unlockPaths: [locked, 'D:\\mods\\@free'],
  });

  assert.equal(log.unlockCalls.length, 1);
  assert.deepEqual(log.unlockCalls[0]!.paths, [locked, 'D:\\mods\\@free']);
  // 프로세스 대기에 쓴 시간만큼 줄어든 예산을 받는다.
  const budget = log.unlockCalls[0]!.timeoutMs;
  assert.ok(budget > 0 && budget <= 1000 - 30, `남은 예산 ${budget}ms`);
  assert.equal(res.unlock?.length, 2);
  assert.equal(res.unlock?.[0]?.code, 'EBUSY');
  assert.equal(res.client?.gone, true);
  assert.equal(killSucceeded(res), false);
});

const TASKKILL_DENIED = {
  killed: false,
  detail: 'taskkill 실패: 액세스가 거부되었습니다.',
};

test('killMp: taskkill 이 실패하고 상한까지 프로세스가 남아 있으면 gone:false', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({ running: ['arma3_x64.exe'], waitResult: () => false });
  fns.killProcAsync = async () => TASKKILL_DENIED;
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', { waitMs: 300 });
  assert.equal(res.client?.killed, false);
  assert.equal(res.client?.gone, false);
  assert.equal(res.client?.detail, TASKKILL_DENIED.detail);
  assert.deepEqual(log.waits, [{ image: 'arma3_x64.exe', timeoutMs: 300, pollMs: 150 }]);
  assert.equal(killSucceeded(res), false);
});

test('killMp: 끝나는 중이라 taskkill 이 실패해도 상한 안에 사라지면 gone:true', async () => {
  // 앞선 taskkill 로 이미 끝나는 중인 프로세스에는 TerminateProcess 가 실패한다.
  // 그래도 약속한 대기 시간 동안 사라지는지 봐야 한다.
  const s = setup();
  const { fns, log } = fakeProcs({ running: ['arma3_x64.exe'], waitDelayMs: 60 });
  fns.killProcAsync = async () => ({
    killed: false,
    detail: 'taskkill 실패: 실행 중인 인스턴스가 없습니다.',
  });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', { waitMs: 5000 });
  assert.equal(res.client?.killed, false);
  assert.equal(res.client?.gone, true);
  assert.ok(res.client!.waitedMs >= 50, `실제로 기다려야 한다 (${res.client!.waitedMs}ms)`);
  assert.deepEqual(log.waits, [{ image: 'arma3_x64.exe', timeoutMs: 5000, pollMs: 150 }]);
  assert.equal(killSucceeded(res), true);
});

test('killMp: waitMs 0 에서 taskkill 이 실패하고 프로세스가 남아 있으면 gone:false', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({ running: ['arma3_x64.exe'] });
  fns.killProcAsync = async () => TASKKILL_DENIED;
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  const res = await mp.killMp('client', { waitMs: 0 });
  assert.deepEqual(res.client, { ...TASKKILL_DENIED, gone: false, waitedMs: 0 });
  assert.equal(log.waits.length, 0);
  assert.equal(killSucceeded(res), false);
});

test('killMp: 실행 중이 아니면 waitMs 0 이어도 gone:true 이고 기다리지 않는다', async () => {
  const s = setup();
  const { fns, log } = fakeProcs({ running: [] });
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  for (const waitMs of [0, 1000]) {
    const res = await mp.killMp('client', { waitMs });
    assert.deepEqual(res.client, {
      killed: false,
      detail: 'arma3_x64.exe 미실행',
      gone: true,
      waitedMs: 0,
    });
    assert.equal(killSucceeded(res), true);
  }
  assert.equal(log.waits.length, 0);
});

test('killMp: signal 을 프로세스 대기와 잠금 대기에 넘긴다', async () => {
  // arma_kill 이 취소되면 이 신호로 두 대기를 멈추고 lease 를 푼다.
  const s = setup();
  const { fns } = fakeProcs({ running: ['arma3_x64.exe'] });
  const seen: Array<AbortSignal | undefined> = [];
  fns.waitProcGone = async (_image, _timeoutMs, _pollMs, signal) => {
    seen.push(signal);
    return true;
  };
  fns.waitPathsWritable = async (paths, o) => {
    seen.push(o.signal);
    return paths.map((p) => ({ path: p, ok: true, waitedMs: 0 }));
  };
  const controller = new AbortController();
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, fns);
  await mp.killMp('client', {
    waitMs: 1000,
    unlockPaths: ['D:\mods\@demo'],
    signal: controller.signal,
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((signal) => signal === controller.signal));
});

// loopback 서버(클라 둘 이상)는 Steam 서버 초기화를 건너뛰어 준비 줄이 RPT 에 없다.
test('waitServerReady: RPT 준비 줄과 서버 브리지 중 먼저 오는 쪽으로 판정한다', async () => {
  const never = (signal: AbortSignal) =>
    new Promise<{ found: boolean; file: string; elapsedMs: number; aborted?: boolean }>((resolve) => {
      signal.addEventListener('abort', () => resolve({ found: false, file: 'x.rpt', elapsedMs: 0, aborted: true }), {
        once: true,
      });
    });
  const miss = async () => ({ found: false, file: 'x.rpt', elapsedMs: 5 });
  const hit = async () => ({ found: true, file: 'x.rpt', line: 'Connected to Steam servers', elapsedMs: 3 });
  const ready = { wait: async () => ({ ready: true, elapsedMs: 9 }) } as never;
  const notReady = { wait: async () => ({ ready: false, elapsedMs: 9 }) } as never;
  const signal = new AbortController().signal;

  // 1) RPT 줄이 끝내 없어도 브리지가 붙으면 준비다. 기다리던 RPT 대기는 멈춘다.
  const byBridge = await waitServerReady(never, ready, 1000, signal);
  assert.equal(byBridge.found, true);
  assert.equal(byBridge.via, 'bridge');
  assert.equal(byBridge.line, SERVER_READY_BY_BRIDGE);

  // 2) RPT 줄이 먼저 오면 그 줄이다.
  const byRpt = await waitServerReady(hit, notReady, 1000, signal);
  assert.equal(byRpt.via, 'rpt');
  assert.equal(byRpt.line, 'Connected to Steam servers');

  // 3) RPT 가 먼저 놓쳐도 브리지를 기다린다.
  const late = await waitServerReady(miss, ready, 1000, signal);
  assert.equal(late.via, 'bridge');

  // 4) 둘 다 놓치면 RPT 쪽 결과다.
  const none = await waitServerReady(miss, notReady, 1000, signal);
  assert.equal(none.found, false);
  assert.equal(none.file, 'x.rpt');

  // 5) 브리지가 없는 실행(autoInit 아님)은 RPT 만 본다.
  const rptOnly = await waitServerReady(miss, undefined, 1000, signal);
  assert.equal(rptOnly.found, false);
});

test('launchMp dryRun: 설정이 로비 배정 줄을 이미 정했으면 데몬 줄을 넣지 않고 알린다', async () => {
  const s = setup();
  const own = setup({
    mp: { port: 2402, profilesDir: s.profilesDir, mpMissionsDir: s.mpMissionsDir, extraCfgLines: ['skipLobby = 0;'] },
  });
  const mp = new MpLauncher(own.cfg, own.rptDir);
  const res = await mp.launchMp({
    mission: own.mission,
    modset: 'none',
    autoInit: true,
    autoSlotRoles: ['Medic'],
    dryRun: true,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.autoSlot?.cfgLines, false);
  assert.deepEqual(res.autoSlot?.userCfgLines, ['skipLobby = 0;']);
  assert.doesNotMatch(res.serverCfgText ?? '', /OnAutoSelectRole/);
  // skipLobby 는 설정 줄 하나만 남는다(같은 키 두 번은 server.cfg 오류다).
  assert.equal((res.serverCfgText ?? '').match(/skipLobby/g)?.length, 1);
  assert.match(res.warning ?? '', /extraCfgLines 가 정한 로비 배정 줄/);
});

test('nameFlagIn: 인자 글에서 -name 값을 읽는다', () => {
  assert.equal(nameFlagIn('-skipIntro -name=lobby_c1 -window'), 'lobby_c1');
  assert.equal(nameFlagIn('-name="My Name" -x'), 'My Name');
  assert.equal(nameFlagIn('-profiles="C:\p" -connect=127.0.0.1'), null);
});
