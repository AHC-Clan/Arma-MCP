import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { Launcher, type LaunchResult } from '../src/launch/launcher.js';
import { MpLauncher } from '../src/launch/mpLauncher.js';
import {
  PlayOrchestrator,
  evaluateInGame,
  expectedWorldFromMission,
  type InGameExpectation,
  type PlayOptions,
  type PlayResult,
} from '../src/launch/playOrchestrator.js';
import { OperationCoordinator } from '../src/launch/operationCoordinator.js';
import {
  listProfileNames,
  loadLaunchProfiles,
  saveLaunchProfile,
} from '../src/launch/launchProfiles.js';
import { NO_NEW_RPT, runPlayFollowUps } from '../src/launch/playFollowUps.js';
import type { ExecOptions, ExecOutcome } from '../src/exec/execManager.js';
import type { Deps } from '../src/mcp/deps.js';
import { createSessionContext } from '../src/mcp/session.js';
import { handlePlay } from '../src/mcp/tools/play.js';
import {
  TelemetryStore,
  clientStateName,
  type ClientInfo,
  type MissionSnapshot,
} from '../src/game/telemetry.js';
import type { Gateway } from '../src/ipc/gateway.js';

// dryRun 경로와 순수 함수만 단위 테스트한다. 실제 spawn 은 실게임 E2E 로 검증한다.

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-play-'));
  const missionsDir = path.join(base, 'missions');
  const mission = path.join(missionsDir, 'demo.VR');
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
        missionsDir,
        // 사용자 홈의 실제 프로필 파일을 건드리지 않게 임시 경로로 둔다.
        profilesFile: path.join(base, 'launch-profiles.json'),
      },
      mp: { port: 2402, profilesDir, mpMissionsDir },
    }),
    'utf8',
  );
  const cfg = loadConfig(cfgPath);
  const rptDir = path.join(base, 'rpt');
  mkdirSync(rptDir, { recursive: true });

  const gateway = { isConnected: () => false, send: () => false } as unknown as Gateway;
  const telemetry = new TelemetryStore();
  const play = new PlayOrchestrator(
    cfg,
    rptDir,
    new Launcher(cfg, rptDir),
    new MpLauncher(cfg, rptDir),
    gateway,
    telemetry,
  );
  return { base, cfg, rptDir, mission, missionsDir, profilesDir, mpMissionsDir, play };
}

const EXPLICIT = { modset: 'explicit' as const, mods: ['D:\\mods\\@cba'] };

// --- 미션 준비 ---

test('sp dryRun scaffolds a mission and points -autotest at it', async () => {
  const s = setup();
  const res = await s.play.play({ mode: 'sp', world: 'Altis', dryRun: true, ...EXPLICIT });
  assert.equal(res.dryRun, true);
  assert.equal(res.mission.origin, 'scaffolded');
  assert.equal(res.mission.world, 'Altis');
  assert.equal(res.mission.template, 'mcp_play.Altis');
  assert.ok(existsSync(res.mission.path!));
  assert.match(res.launch!.argString, /-autotest="/);
  // 즉석 생성 미션에는 보정 프렐류드가 들어간다.
  const init = readFileSync(path.join(res.mission.path!, 'init.sqf'), 'utf8');
  assert.match(init, /\[arma-mcp\]\[safeSpawn\]/);
});

test('a given mission is used as is, without scaffolding', async () => {
  const s = setup();
  const res = await s.play.play({ mode: 'sp', mission: s.mission, dryRun: true, ...EXPLICIT });
  assert.equal(res.mission.origin, 'given');
  assert.equal(res.mission.world, 'VR');
  assert.equal(res.mission.files, undefined);
});

test('a missing mission fails without launching', async () => {
  const s = setup();
  const res = await s.play.play({
    mode: 'sp',
    mission: path.join(s.base, 'nope.VR'),
    dryRun: true,
    ...EXPLICIT,
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /mission not found/);
});

// --- MP 인자 ---

test('mp dryRun always runs the server with -autoInit and persistent=1', async () => {
  const s = setup();
  const res = await s.play.play({ mode: 'mp', mission: s.mission, dryRun: true, ...EXPLICIT });
  const mp = res.launch as import('../src/launch/mpLauncher.js').MpLaunchResult;
  assert.match(mp.server.argString, /-autoInit/);
  assert.match(mp.serverCfgText!, /persistent = 1;/);
  assert.match(mp.client!.argString, /-connect=127\.0\.0\.1 -port=2402/);
  // 부작용 없음.
  assert.equal(existsSync(s.mpMissionsDir), false);
  assert.equal(existsSync(s.profilesDir), false);
});

test('autoSlot defaults on: server.cfg gets skipLobby and the role hook, the client is untouched', async () => {
  const s = setup();
  const res = await s.play.play({ mode: 'mp', mission: s.mission, dryRun: true, ...EXPLICIT });
  const mp = res.launch as import('../src/launch/mpLauncher.js').MpLaunchResult;
  assert.match(mp.serverCfgText!, /^skipLobby = 1;$/m);
  assert.match(mp.serverCfgText!, /^OnAutoSelectRole = "private _want = \[\];/m);
  // 클라 인자와 애드온은 그대로다. 배정은 서버가 한다.
  assert.doesNotMatch(mp.client!.argString, /-init=/);
  assert.doesNotMatch(mp.server.argString, /-init=/);
  assert.equal(res.autoSlot!.requested, true);
  assert.deepEqual(res.autoSlot!.clients, [{ index: 1, requested: 'auto', state: 'no-evidence' }]);
});

test('autoSlot=false leaves the lobby to a person', async () => {
  const s = setup();
  const res = await s.play.play({
    mode: 'mp',
    mission: s.mission,
    autoSlot: false,
    dryRun: true,
    ...EXPLICIT,
  });
  const mp = res.launch as import('../src/launch/mpLauncher.js').MpLaunchResult;
  assert.doesNotMatch(mp.serverCfgText!, /skipLobby|OnAutoSelectRole/);
  assert.equal(mp.autoSlot, undefined);
  assert.equal(res.autoSlot!.state, 'disabled');
  assert.equal(res.autoSlot!.humanNeeded, true);
  assert.equal(res.autoSlot!.clients[0]!.state, 'disabled');
});

test('lobbyProbe is no longer used: ignored with a warning', async () => {
  const s = setup();
  const res = await s.play.play({ mode: 'mp', mission: s.mission, lobbyProbe: true, dryRun: true, ...EXPLICIT });
  assert.ok(res.warnings.some((w) => w.includes('lobbyProbe')));
  assert.equal(res.autoSlot!.requested, true);
});

test('roles go into the server hook by client name; an unnamed client 1 is the "" entry', async () => {
  const s = setup();
  const text = await s.play.play({
    mode: 'mp',
    mission: s.mission,
    roles: ['  Squad Leader '],
    dryRun: true,
    ...EXPLICIT,
  });
  const mp = text.launch as import('../src/launch/mpLauncher.js').MpLaunchResult;
  // default 스택 클라 1 은 -name 이 없다. 훅은 다른 지정에 없는 이름을 이 항목으로 본다.
  assert.match(mp.serverCfgText!, /private _want = \[\['', 'Squad Leader'\]\];/);
  assert.deepEqual(mp.autoSlot!.entries, [{ name: '', role: 'Squad Leader' }]);
  assert.equal(text.autoSlot!.clients[0]!.requested, 'Squad Leader');

  const row = await s.play.play({ mode: 'mp', mission: s.mission, roles: [3], dryRun: true, ...EXPLICIT });
  assert.match((row.launch as typeof mp).serverCfgText!, /private _want = \[\['', 3\]\];/);
  assert.equal(row.autoSlot!.clients[0]!.requested, '#3');
  const auto = await s.play.play({ mode: 'mp', mission: s.mission, roles: [null], dryRun: true, ...EXPLICIT });
  assert.match((auto.launch as typeof mp).serverCfgText!, /private _want = \[\];/);
});

test('bad roles fail before anything launches', async () => {
  const s = setup();
  const tooMany = await s.play.play({
    mode: 'mp',
    mission: s.mission,
    clients: 1,
    roles: ['a', 'b'],
    dryRun: true,
    ...EXPLICIT,
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.phase, 'none');
  assert.match(tooMany.error!, /roles 는 2 개인데 clients 는 1/);
  assert.equal(tooMany.launch, undefined);

  const negative = await s.play.play({ mode: 'mp', mission: s.mission, roles: [-1], dryRun: true, ...EXPLICIT });
  assert.equal(negative.ok, false);
  assert.match(negative.error!, /roles\[0\]: 역할 번호/);

  const sp = await s.play.play({ mode: 'sp', mission: s.mission, roles: ['x'], dryRun: true, ...EXPLICIT });
  assert.ok(sp.warnings.some((w) => w.includes('roles')));
});

test('a mission that sets skipLobby = 0 keeps its lobby, and the result says so', async () => {
  const s = setup();
  writeFileSync(path.join(s.mission, 'description.ext'), 'respawn = 3;\nskipLobby = 0;\n', 'utf8');
  const res = await s.play.play({ mode: 'mp', mission: s.mission, roles: ['x'], dryRun: true, ...EXPLICIT });
  const mp = res.launch as import('../src/launch/mpLauncher.js').MpLaunchResult;
  assert.equal(mp.autoSlot!.missionSkipLobby, 0);
  assert.ok(res.warnings.some((w) => w.includes('skipLobby = 0')));
  assert.equal(res.autoSlot!.state, 'mission-lobby');
  assert.equal(res.autoSlot!.humanNeeded, true);
});

test('user client args survive and stay ahead of -mod', async () => {
  const s = setup();
  const res = await s.play.play({
    mode: 'mp',
    mission: s.mission,
    clientExtraArgs: ['-showScriptErrors'],
    dryRun: true,
    ...EXPLICIT,
  });
  const arg = (res.launch as import('../src/launch/mpLauncher.js').MpLaunchResult).client!
    .argString;
  assert.ok(arg.includes('-showScriptErrors'));
  assert.ok(arg.indexOf('-showScriptErrors') < arg.indexOf('-mod='));
});

test('arguments meant for the other mode are reported, not obeyed', async () => {
  const s = setup();
  const res = await s.play.play({
    mode: 'sp',
    mission: s.mission,
    port: 2999,
    dryRun: true,
    ...EXPLICIT,
  });
  assert.ok(res.warnings.some((w) => w.includes('port')));
  assert.doesNotMatch(res.launch!.argString, /2999/);
});

test('expectedWorldFromMission reads the folder extension', () => {
  assert.equal(expectedWorldFromMission('C:\\m\\mcp_test.Altis'), 'Altis');
  assert.equal(expectedWorldFromMission('mcp_test.VR'), 'VR');
  assert.equal(expectedWorldFromMission('noextension'), '');
});

// --- 인게임 판정 ---

function snapshot(over: Partial<MissionSnapshot> = {}): MissionSnapshot {
  return {
    world: 'Altis',
    mission: 'mcp_play',
    briefing: '',
    dedicated: true,
    multiplayer: true,
    cba: false,
    ace: false,
    aceVersion: '',
    aceComponents: [],
    tacmap: null,
    tacmapZeusTool: null,
    missionTime: 12,
    date: [],
    fps: 60,
    players: [],
    playerCount: 0,
    hcCount: 0,
    clients: null,
    receivedAt: Date.now(),
    ...over,
  };
}

function client(over: Partial<ClientInfo> = {}): ClientInfo {
  const state = over.state ?? 10;
  return {
    name: 'MCP',
    state,
    stateName: clientStateName(state),
    isHC: false,
    hasUnit: true,
    ...over,
  };
}

function mpExpect(over: Partial<InGameExpectation> = {}): InGameExpectation {
  return {
    world: 'Altis',
    dedicated: true,
    minPlayers: 1,
    startedAt: Date.now() - 60_000,
    freshnessLimitMs: 15_000,
    requireSimProgress: false,
    prevMissionTime: null,
    ...over,
  };
}

test('no telemetry is not in-game', () => {
  const v = evaluateInGame(snapshot({ receivedAt: 0 }), mpExpect());
  assert.equal(v.inGame, false);
  assert.equal(v.evidence, 'none');
});

test('telemetry from before this launch is not in-game', () => {
  const v = evaluateInGame(snapshot({ receivedAt: Date.now() - 120_000 }), mpExpect());
  assert.equal(v.inGame, false);
  assert.match(v.reason!, /이전 미션/);
});

test('stale telemetry is not in-game', () => {
  const v = evaluateInGame(
    snapshot({ receivedAt: Date.now() - 30_000 }),
    mpExpect({ startedAt: Date.now() - 60_000 }),
  );
  assert.equal(v.inGame, false);
  assert.match(v.reason!, /낡았다/);
});

test('a different world is not in-game', () => {
  const v = evaluateInGame(snapshot({ world: 'Stratis', playerCount: 1 }), mpExpect());
  assert.equal(v.inGame, false);
  assert.match(v.reason!, /world 불일치/);
});

test('a non-dedicated snapshot does not satisfy an mp wait', () => {
  const v = evaluateInGame(snapshot({ dedicated: false, playerCount: 1 }), mpExpect());
  assert.equal(v.inGame, false);
  assert.match(v.reason!, /전용 서버/);
});

test('an old PBO without clients falls back to playerCount', () => {
  const v = evaluateInGame(snapshot({ clients: null, playerCount: 1 }), mpExpect());
  assert.equal(v.inGame, true);
  assert.equal(v.evidence, 'playerCount');
});

test('a lobby client state is not in-game even with a slot', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 1,
      clients: [client({ state: 6 })],   // ROLE ASSIGNED
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, false);
  assert.equal(v.evidence, 'clients');
  assert.equal(v.playing, 0);
});

test('the briefing screen is not yet in-game', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 1,
      clients: [client({ state: 9 })],   // BRIEFING SHOWN
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, false);
  assert.equal(v.playing, 0);
});

test('a finished mission does not count as in-game', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 1,
      clients: [client({ state: 11 })],   // GAME FINISHED
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, false);
  assert.equal(v.playing, 0);
});

test('a playing client with a unit is in-game', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 1,
      clients: [client({ state: 10 })],   // BRIEFING READ
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, true);
  assert.equal(v.evidence, 'clients');
  assert.equal(v.playing, 1);
});

test('an old PBO without a usable state falls back to hasUnit', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 1,
      clients: [client({ state: -1, stateName: 'UNKNOWN' })],
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, true);
  assert.equal(v.evidence, 'clients');
  assert.equal(v.playing, 1);
});

test('a headless client does not count as a player', () => {
  const v = evaluateInGame(
    snapshot({
      playerCount: 0,
      hcCount: 1,
      clients: [client({ name: 'HC', state: 10, isHC: true })],
    }),
    mpExpect(),
  );
  assert.equal(v.inGame, false);
  assert.equal(v.playing, 0);
});

test('sp waits for the simulation to actually advance', () => {
  const spExpect = mpExpect({
    dedicated: false,
    minPlayers: 0,
    requireSimProgress: true,
    prevMissionTime: null,
  });
  const noPrev = evaluateInGame(snapshot({ dedicated: false, missionTime: 5 }), spExpect);
  assert.equal(noPrev.inGame, false);
  assert.equal(noPrev.evidence, 'simProgress');

  const stalled = evaluateInGame(
    snapshot({ dedicated: false, missionTime: 5 }),
    { ...spExpect, prevMissionTime: 5 },
  );
  assert.equal(stalled.inGame, false);

  const running = evaluateInGame(
    snapshot({ dedicated: false, missionTime: 7 }),
    { ...spExpect, prevMissionTime: 5 },
  );
  assert.equal(running.inGame, true);
  assert.equal(running.evidence, 'simProgress');
});

// --- 텔레메트리 파싱 ---

test('the telemetry store keeps clients as null until the addon sends it', () => {
  const store = new TelemetryStore();
  const frames: Record<string, (m: Record<string, unknown>) => void> = {};
  const fakeGateway = {
    on: (name: string, cb: (m: Record<string, unknown>) => void) => {
      frames[name] = cb;
    },
  } as unknown as Gateway;
  store.bind(fakeGateway);

  frames.telemetry!({ world: 'Altis', mission: 'm', playerCount: 0 });
  assert.equal(store.current().clients, null);

  frames.telemetry!({
    world: 'Altis',
    mission: 'm',
    playerCount: 1,
    clients: [['MCP', 10, 0, 1]],
  });
  assert.deepEqual(store.current().clients, [
    { name: 'MCP', state: 10, stateName: 'BRIEFING READ', isHC: false, hasUnit: true },
  ]);
});

test('a non-numeric client state from an old PBO parses as unknown', () => {
  const store = new TelemetryStore();
  const frames: Record<string, (m: Record<string, unknown>) => void> = {};
  const fakeGateway = {
    on: (name: string, cb: (m: Record<string, unknown>) => void) => {
      frames[name] = cb;
    },
  } as unknown as Gateway;
  store.bind(fakeGateway);

  frames.telemetry!({
    world: 'Altis',
    mission: 'm',
    playerCount: 1,
    clients: [['MCP', 'GAME PLAYING', 0, 1]],
  });
  assert.deepEqual(store.current().clients, [
    { name: 'MCP', state: -1, stateName: 'UNKNOWN', isHC: false, hasUnit: true },
  ]);
});

test('an out-of-table client state keeps its number', () => {
  assert.equal(clientStateName(13), 'STATE 13');
  assert.equal(clientStateName(-1), 'UNKNOWN');
  assert.equal(clientStateName(6), 'ROLE ASSIGNED');
});

// --- 프로필, ready, then (게임 없이 가짜 실행 결과로) ---

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_RPT = path.join(here, 'fixtures', 'sample.rpt');
const SELF_MOD = 'D:\\mods\\@arma_mcp';

/** fixture RPT 를 이번 실행이 만든 새 RPT 인 것처럼 임시 폴더에 복사한다. */
function newRptCopy(dir: string, name = 'Arma3_x64_2026-09-23_10-00-00.rpt'): string {
  const file = path.join(dir, name);
  copyFileSync(FIXTURE_RPT, file);
  return file;
}

function spResult(mission: string, newRptPath?: string, over: Partial<PlayResult> = {}): PlayResult {
  const launch: LaunchResult = {
    ok: true,
    launched: true,
    dryRun: false,
    pid: 4242,
    modSource: 'explicit',
    modCount: 2,
    mods: ['D:\\mods\\@cba', SELF_MOD],
    argString: '',
    prevNewestRpt: '(none)',
    newRpt: newRptPath ? { name: path.basename(newRptPath), path: newRptPath } : undefined,
  };
  return {
    ok: true,
    mode: 'sp',
    dryRun: false,
    phase: 'in-game',
    steps: [],
    mission: { origin: 'given', ref: mission, template: path.basename(mission), world: 'VR' },
    launch,
    warnings: [],
    totalMs: 1000,
    ...over,
  };
}

function execOutcome(over: Partial<ExecOutcome> = {}): ExecOutcome {
  return {
    ok: true,
    timedOut: false,
    completedBy: 'first',
    durationMs: 5,
    reqId: 'abcd1234-000000000001',
    results: [
      { machine: 'server', result: 'SCALAR: 2', parsed: { kind: 'value', type: 'SCALAR', value: '2' } },
    ],
    rptErrors: [],
    rptCursor: null,
    sanitized: false,
    ...over,
  };
}

interface FakePlay {
  deps: Deps;
  coordinator: OperationCoordinator;
  execCalls: ExecOptions[];
  playCalls: PlayOptions[];
  kills: string[];
}

/** handlePlay 와 runPlayFollowUps 가 쓰는 만큼의 Deps. 프로세스 종료는 기록만 한다. */
function fakePlayDeps(
  s: ReturnType<typeof setup>,
  opts: { result?: PlayResult; exec?: ExecOutcome } = {},
): FakePlay {
  const coordinator = new OperationCoordinator();
  const execCalls: ExecOptions[] = [];
  const playCalls: PlayOptions[] = [];
  const kills: string[] = [];
  const deps = {
    cfg: s.cfg,
    operationCoordinator: coordinator,
    session: createSessionContext('relay'),
    playOrchestrator: opts.result
      ? {
          play: async (o: PlayOptions) => {
            playCalls.push(o);
            return opts.result;
          },
        }
      : s.play,
    exec: {
      run: async (o: ExecOptions) => {
        execCalls.push(o);
        if (!opts.exec) throw new Error('exec 를 부르면 안 된다');
        return opts.exec;
      },
    },
    rptSources: { resolve: () => ({ source: 'client', dir: s.rptDir, re: /\.rpt$/i }) },
    launcher: {
      killRunning: async () => {
        kills.push('launcher');
        return { killed: true, detail: '' };
      },
    },
    mpLauncher: {
      killMp: async () => {
        kills.push('mp');
        return {};
      },
    },
  } as unknown as Deps;
  return { deps, coordinator, execCalls, playCalls, kills };
}

function parsed(res: { content: { type: string; text: string }[] }): Record<string, any> {
  return JSON.parse(res.content[0]!.text);
}

test('dryRun 에 profile 을 주면 합친 인자를 보여 주고 저장하지 않는다', async () => {
  const s = setup();
  await saveLaunchProfile(s.cfg.arma.profilesFile, 'wc', {
    mode: 'sp',
    mission: s.mission,
    mods: ['D:\\mods\\@cba'],
    clientExtraArgs: ['-showScriptErrors'],
    ready: { rpt: 'MYMOD ready' },
    savedAt: '2026-09-23T00:00:00.000Z',
  });
  const f = fakePlayDeps(s);
  const out = parsed(
    await handlePlay(f.deps, { profile: 'wc', dryRun: true, saveProfile: 'copy', password: 'pw' }),
  );

  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.mission.origin, 'given');
  assert.equal(out.profile.name, 'wc');
  assert.equal(out.profile.merged.mission, s.mission);
  assert.equal(out.profile.merged.modset, 'explicit');
  assert.deepEqual(out.profile.merged.mods, ['D:\\mods\\@cba']);
  assert.deepEqual(out.profile.merged.ready, { rpt: 'MYMOD ready' });
  assert.equal(out.profile.merged.password, '(숨김)');
  assert.match(out.profile.notSaved, /dryRun/);
  // 프로필 값이 실제 인자로 들어갔다.
  assert.match(out.launch.argString, /-showScriptErrors/);
  assert.match(out.launch.argString, /@cba/);
  assert.match(out.launch.argString, /-autotest="/);
  // dryRun 은 ready 를 기다리지도 RPT 를 요약하지도 않는다.
  assert.equal(out.ready, undefined);
  assert.equal(out.rpt, undefined);
  assert.deepEqual(await listProfileNames(s.cfg.arma.profilesFile), ['wc']);
  assert.equal(f.coordinator.snapshot(), null);
});

test('모르는 profile 은 실행 전에 있는 이름을 알려 주며 실패한다', async () => {
  const s = setup();
  await saveLaunchProfile(s.cfg.arma.profilesFile, 'wc', {
    mode: 'sp',
    mission: s.mission,
    savedAt: '2026-09-23T00:00:00.000Z',
  });
  const f = fakePlayDeps(s, { result: spResult(s.mission) });
  const out = parsed(await handlePlay(f.deps, { profile: 'nope' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /nope/);
  assert.match(out.error, /있는 프로필: wc/);
  assert.deepEqual(out.profiles, ['wc']);
  assert.equal(f.playCalls.length, 0);
  assert.equal(f.coordinator.snapshot(), null);
});

test('깨진 프로필 파일은 파일 경로를 담아 실행 전에 실패한다', async () => {
  const s = setup();
  writeFileSync(s.cfg.arma.profilesFile, '{ broken', 'utf8');
  const f = fakePlayDeps(s, { result: spResult(s.mission) });
  const out = parsed(await handlePlay(f.deps, { profile: 'wc' }));
  assert.equal(out.ok, false);
  assert.ok(String(out.error).includes(s.cfg.arma.profilesFile));
  assert.equal(f.playCalls.length, 0);
});

test('sp 에서 ready.source server 는 게임을 띄우기 전에 거절한다', async () => {
  const s = setup();
  const f = fakePlayDeps(s, { result: spResult(s.mission) });
  const out = parsed(
    await handlePlay(f.deps, { mission: s.mission, ready: { rpt: 'x', source: 'server' } }),
  );
  assert.equal(out.ok, false);
  assert.match(out.error, /mp 모드에서만/);
  assert.equal(f.playCalls.length, 0);

  const bad = parsed(await handlePlay(f.deps, { mission: s.mission, ready: { rpt: '(' } }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /정규식/);
  assert.equal(f.playCalls.length, 0);
});

test('then.mode client 에 target 이 없으면 게임을 띄우기 전에 거절한다', async () => {
  const s = setup();
  const f = fakePlayDeps(s, { result: spResult(s.mission), exec: execOutcome() });
  for (const target of [undefined, '']) {
    const out = parsed(
      await handlePlay(f.deps, {
        mission: s.mission,
        then: { code: 'hint "x"', mode: 'client', ...(target === undefined ? {} : { target }) },
      }),
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /then\.mode 'client'/);
    assert.match(out.error, /target/);
  }
  assert.equal(f.playCalls.length, 0);
  assert.equal(f.execCalls.length, 0);
  assert.equal(f.coordinator.snapshot(), null);

  // target 을 주면 그대로 실행한다.
  const rpt = newRptCopy(s.rptDir);
  const ok = fakePlayDeps(s, { result: spResult(s.mission, rpt), exec: execOutcome() });
  const out = parsed(
    await handlePlay(ok.deps, {
      mission: s.mission,
      then: { code: 'hint "x"', mode: 'client', target: 'Alice' },
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(ok.playCalls.length, 1);
  assert.equal(ok.execCalls[0]?.target, 'Alice');
});

test('sp 로 부른 mp 프로필의 서버 ready 는 인자 오류가 되지 않는다', async () => {
  const s = setup();
  await saveLaunchProfile(s.cfg.arma.profilesFile, 'mpx', {
    mode: 'mp',
    mission: s.mission,
    ready: { rpt: 'srv ready', source: 'server' },
    savedAt: '2026-09-23T00:00:00.000Z',
  });
  const f = fakePlayDeps(s);
  const out = parsed(await handlePlay(f.deps, { profile: 'mpx', mode: 'sp', dryRun: true }));
  assert.equal(out.ok, true, String(out.error));
  assert.equal(out.mode, 'sp');
  assert.equal(out.profile.merged.ready, undefined);
});

test('ready 는 이번 실행의 새 RPT 에서 마커를 찾고 rpt 요약을 붙인다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const f = fakePlayDeps(s);
  const follow = await runPlayFollowUps(f.deps, spResult(s.mission, rpt), {
    ready: { rpt: 'init server bridge on \\w+' },
  });
  assert.equal(follow.ok, true);
  assert.equal(follow.ready!.ok, true);
  assert.equal(follow.ready!.file, rpt);
  assert.match(follow.ready!.line!, /init server bridge on Altis/);
  assert.equal(follow.ready!.lineNumber, 6);
  assert.equal(follow.rpt.client!.file, rpt);
  assert.equal(follow.rpt.client!.errorBlocks, 2);
  assert.equal(follow.rpt.client!.first.length, 2);
  assert.match(follow.rpt.client!.first[0]!.block[0]!, /_undef \+ 1/);
  assert.equal(follow.rpt.client!.warningMessages, 1);
  assert.equal(follow.rpt.server, undefined);
});

test('ready 는 나중에 찍히는 마커를 기다린다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const f = fakePlayDeps(s);
  const timer = setTimeout(() => appendFileSync(rpt, ' 9:00:09 [MYMOD] ready for tests\n'), 300);
  try {
    const follow = await runPlayFollowUps(f.deps, spResult(s.mission, rpt), {
      ready: { rpt: '\\[MYMOD\\] ready', timeoutMs: 5000 },
    });
    assert.equal(follow.ready!.ok, true);
    assert.match(follow.ready!.line!, /ready for tests/);
    assert.ok(follow.ready!.elapsedMs >= 200);
  } finally {
    clearTimeout(timer);
  }
});

test('새 RPT 가 없으면 이전 RPT 에 마커가 있어도 newRpt 없음으로 실패한다', async () => {
  const s = setup();
  // 이전 실행의 RPT 에는 마커가 이미 있다. 이것을 준비 완료로 읽으면 안 된다.
  newRptCopy(s.rptDir, 'Arma3_x64_2026-09-22_09-00-00.rpt');
  const f = fakePlayDeps(s, { exec: execOutcome() });
  const started = Date.now();
  const follow = await runPlayFollowUps(f.deps, spResult(s.mission), {
    ready: { rpt: 'init server bridge' },
    then: { code: '1 + 1' },
  });
  assert.ok(Date.now() - started < 1000);
  assert.equal(follow.ok, false);
  assert.equal(follow.ready!.ok, false);
  assert.equal(follow.ready!.reason, NO_NEW_RPT);
  assert.match(follow.error!, /newRpt 없음/);
  assert.equal(follow.then!.skipped, true);
  assert.equal(f.execCalls.length, 0);
  assert.deepEqual(follow.rpt, {});
});

test('then 이 실패하면 ok 는 false 이고 게임은 끄지 않는다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const f = fakePlayDeps(s, {
    result: spResult(s.mission, rpt),
    exec: execOutcome({
      ok: false,
      error: 'no result (timed out)',
      timedOut: true,
      completedBy: 'timeout',
      results: [],
    }),
  });
  const out = parsed(
    await handlePlay(f.deps, {
      mission: s.mission,
      ready: { rpt: 'init server bridge' },
      then: { code: '// setup\n[] call MY_fnc_setup' },
    }),
  );

  assert.equal(out.ok, false);
  assert.match(out.error, /then 실패: no result/);
  assert.equal(out.phase, 'in-game');
  assert.equal(out.ready.ok, true);
  assert.equal(out.then.ok, false);
  assert.equal(out.then.exec.timedOut, true);
  assert.match(out.nextSteps, /그대로 두었다/);
  assert.equal(out.rpt.client.errorBlocks, 2);
  // 어떤 종료도 부르지 않았다.
  assert.deepEqual(f.kills, []);
  // arma_exec 와 같은 경로로 갔다. 주석 제거는 ExecManager.run 안에서 한다.
  assert.equal(f.execCalls.length, 1);
  assert.equal(f.execCalls[0]!.code, '// setup\n[] call MY_fnc_setup');
  assert.equal(f.execCalls[0]!.timeoutMs, 10000);
  assert.equal(f.execCalls[0]!.context?.sessionShortId, f.deps.session.shortId);
  assert.equal(f.coordinator.snapshot(), null);
});

test('then 의 ERROR 결과와 RPT 오류 블록도 실패로 본다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const errored = fakePlayDeps(s, {
    exec: execOutcome({
      results: [{ machine: 'server', result: 'ERROR: boom', parsed: { kind: 'error', value: 'boom' } }],
    }),
  });
  const a = await runPlayFollowUps(errored.deps, spResult(s.mission, rpt), {
    then: { code: 'x' },
  });
  assert.equal(a.ok, false);
  assert.equal(a.then!.reason, 'ERROR: boom');

  const nilWithBlocks = fakePlayDeps(s, {
    exec: execOutcome({
      results: [{ machine: 'server', result: '<nil>', parsed: { kind: 'nil' } }],
      rptErrors: [{ line: 1, block: ['Error in expression <x>'] }],
    }),
  });
  const b = await runPlayFollowUps(nilWithBlocks.deps, spResult(s.mission, rpt), {
    then: { code: 'x' },
  });
  assert.equal(b.ok, false);
  assert.match(b.then!.reason!, /RPT/);

  const fine = fakePlayDeps(s, { exec: execOutcome() });
  const c = await runPlayFollowUps(fine.deps, spResult(s.mission, rpt), { then: { code: 'x' } });
  assert.equal(c.ok, true);
  assert.equal(c.then!.ok, true);
});

test('인게임에 못 들어간 실행은 ready 와 then 을 건너뛰고 rpt 요약만 붙인다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const failed = spResult(s.mission, rpt, { ok: false, error: 'timeout', phase: 'launched' });
  const f = fakePlayDeps(s, { result: failed, exec: execOutcome() });
  const out = parsed(
    await handlePlay(f.deps, {
      mission: s.mission,
      ready: { rpt: 'init' },
      then: { code: '1' },
      saveProfile: 'wc',
    }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.error, 'timeout');
  assert.equal(out.ready.skipped, true);
  assert.equal(out.then.skipped, true);
  assert.equal(out.rpt.client.errorBlocks, 2);
  assert.match(out.profile.notSaved, /인게임/);
  assert.equal(f.execCalls.length, 0);
  assert.deepEqual(await listProfileNames(s.cfg.arma.profilesFile), []);
});

test('saveProfile 은 성공한 실행의 해석된 값만 저장한다', async () => {
  const s = setup();
  const rpt = newRptCopy(s.rptDir);
  const f = fakePlayDeps(s, { result: spResult(s.mission, rpt), exec: execOutcome() });
  const out = parsed(
    await handlePlay(f.deps, {
      mission: s.mission,
      modset: 'rpt',
      killRunning: true,
      clientExtraArgs: ['-showScriptErrors'],
      ready: { rpt: 'init server bridge', timeoutMs: 5000 },
      then: { code: 'hint "setup"' },
      saveProfile: 'wc',
    }),
  );
  assert.equal(out.ok, true);
  assert.equal(out.profile.saved, 'wc');

  const saved = (await loadLaunchProfiles(s.cfg.arma.profilesFile)).profiles.wc!;
  assert.equal(saved.mode, 'sp');
  assert.equal(saved.mission, path.resolve(s.mission));
  // RPT 에서 읽어 온 모드 목록을 적고, 런처가 늘 붙이는 selfModPath 는 뺀다.
  assert.deepEqual(saved.mods, ['D:\\mods\\@cba']);
  assert.equal(saved.modset, undefined);
  assert.deepEqual(saved.clientExtraArgs, ['-showScriptErrors']);
  assert.deepEqual(saved.ready, { rpt: 'init server bridge', timeoutMs: 5000 });
  const text = readFileSync(s.cfg.arma.profilesFile, 'utf8');
  assert.doesNotMatch(text, /killRunning|password|then|hint/);
});

test('ready 가 실패하면 프로필을 저장하지 않는다', async () => {
  const s = setup();
  const f = fakePlayDeps(s, { result: spResult(s.mission) });
  const out = parsed(
    await handlePlay(f.deps, {
      mission: s.mission,
      ready: { rpt: 'never' },
      saveProfile: 'wc',
    }),
  );
  assert.equal(out.ok, false);
  assert.equal(out.ready.reason, NO_NEW_RPT);
  assert.match(out.profile.notSaved, /ready/);
  assert.deepEqual(await listProfileNames(s.cfg.arma.profilesFile), []);
});

test('다른 세션이 lease 를 쥐고 있으면 주인을 알려 주고 실행하지 않는다', async () => {
  const s = setup();
  const f = fakePlayDeps(s, { result: spResult(s.mission) });
  const other = createSessionContext('remote-http');
  const held = f.coordinator.tryAcquire('arma_launch_mp', {
    session: other.shortId,
    transport: other.transport,
  });
  assert.equal(held.acquired, true);
  const out = parsed(await handlePlay(f.deps, { mission: s.mission }));
  assert.equal(out.ok, false);
  assert.equal(out.error, 'another launch operation is already in progress');
  assert.deepEqual(out.busy.owner, { session: other.shortId, transport: 'remote-http' });
  assert.equal(out.busy.mine, undefined);
  assert.equal(f.playCalls.length, 0);
  if (held.acquired) held.lease.release();

  // 자기 세션이 쥔 lease 면 mine 이 붙는다.
  const mine = f.coordinator.tryAcquire('arma_scaffold_mission', {
    session: f.deps.session.shortId,
    transport: f.deps.session.transport,
  });
  const again = parsed(await handlePlay(f.deps, { mission: s.mission }));
  assert.equal(again.busy.mine, true);
  if (mine.acquired) mine.lease.release();
});

test('arma_play 는 호출 세션을 lease 주인으로 남긴다', async () => {
  const s = setup();
  const f = fakePlayDeps(s);
  let seen: unknown;
  (f.deps as { playOrchestrator: unknown }).playOrchestrator = {
    play: async () => {
      seen = f.coordinator.snapshot();
      return spResult(s.mission, undefined, { dryRun: true });
    },
  };
  await handlePlay(f.deps, { mission: s.mission, dryRun: true });
  assert.deepEqual((seen as { owner: unknown }).owner, {
    session: f.deps.session.shortId,
    transport: 'relay',
  });
});
