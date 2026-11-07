// playOrchestrator.ts — 한 번의 호출로 게임 안에 들어가 있는 상태를 만든다.
//
// arma_launch 는 게임을 띄우고, arma_launch_mp 는 로비까지 간다. 그 뒤가 매번 손이다.
// 여기서는 미션 준비부터 인게임 진입 확인까지를 한 흐름으로 묶는다.
//
// MpLauncher 를 확장하지 않고 새 모듈로 둔 이유가 셋이다.
//  - MpLaunchResult 는 이미 필드가 스무 개를 넘는다. 로비 이후 단계를 얹으면
//    arma_launch_mp 사용자가 안 쓰는 필드를 계속 읽게 된다.
//  - SP 경로는 MpLauncher 와 아무 관련이 없다.
//  - 인게임 판정은 프로세스 스폰이 아니라 텔레메트리 소비다. 성격이 다르다.
//
// 성공 판정은 항상 서버 텔레메트리다. 로비 자동 슬롯이 실패해도 사람이 직접 슬롯을
// 고르면 같은 신호가 오므로, 도구는 기다렸다가 무슨 일이 있었는지 그대로 보고한다.

import path from 'node:path';
import type { Config } from '../config.js';
import type { Gateway } from '../ipc/gateway.js';
import type { ClientInfo, MissionSnapshot, TelemetryStore } from '../game/telemetry.js';
import type { Launcher, LaunchResult } from './launcher.js';
import type { MpLauncher, MpLaunchResult } from './mpLauncher.js';
import { scaffoldMission, defaultScaffoldDir } from './scaffold.js';
import type { SafeSpawnMode } from './safeSpawn.js';
import { searchRpt } from '../rpt/rptReader.js';
import type { StackContext } from '../stack/stackContext.js';
import type { ExecManager } from '../exec/execManager.js';
import {
  AUTO_SELECT_LOG,
  ON_SELECT_ROLE_ERROR,
  READ_PLAYERS_SQF,
  parseAutoSelectLines,
  parseServerPlayers,
  roleSpecText,
  rolesProblem,
  type AutoSelectLogLine,
  type PlayRole,
  type ServerPlayer,
} from './autoSlot.js';
import { log } from '../log.js';

export type PlayMode = 'sp' | 'mp';

export type PlayPhase =
  | 'none'
  | 'mission'
  | 'launched'
  | 'server'
  | 'serverBridge'
  | 'client'
  | 'lobby'
  | 'autoSlot'
  | 'bridge'
  | 'in-game';

/**
 * 인게임으로 인정하는 clientStateNumber. BRIEFING READ 하나다.
 *
 * 엔진 기준과 같다. 월드 시뮬레이션은 MP 에서 서버 상태가 7 이나 8 이고 클라 상태가 10 일 때만
 * 게임 시간을 진행한다(Arma 3 2.22 exe). -noPause 가 비활성 창의 일시정지를 푸는 것도 10 에서다.
 * 9(BRIEFING SHOWN) 이하는 슬롯을 잡았어도 아직 로비나 브리핑이고, 11(GAME FINISHED)
 * 과 12(DEBRIEFING READ)는 미션이 끝난 뒤다. 값 이름은 telemetry.ts 의
 * CLIENT_STATE_NAMES 에 있다.
 */
const IN_GAME_CLIENT_STATE = 10;

/** 서버 RPT 에서 자동 배정 증거로 모으는 줄. 훅의 줄과 엔진의 OnSelectRole 오류 줄이다. */
const AUTO_SLOT_LOG_PATTERN = 'autoSelectRole\\||Error, OnSelectRole';
const AUTO_SLOT_LOG_MAX_MATCHES = 200;
/** 인게임 뒤 서버에서 플레이어 역할을 읽는 exec 의 한도. */
const READ_PLAYERS_TIMEOUT_MS = 5000;

export type { PlayRole } from './autoSlot.js';

const DEFAULT_IN_GAME_TIMEOUT_MS = 180000;
const DEFAULT_SP_BRIDGE_TIMEOUT_MS = 180000;
const POLL_INTERVAL_MS = 250;
/** 텔레메트리 주기가 5초라 즉시 push 를 요청한다. 멱등이라 부작용이 없다. */
const TELEMETRY_NUDGE_INTERVAL_MS = 1000;

export interface PlayOptions {
  mode?: PlayMode;
  mission?: string;
  modset?: 'rpt' | 'explicit' | 'none';
  mods?: string[];
  killRunning?: boolean;
  clientExtraArgs?: string[];
  dryRun?: boolean;
  inGameTimeoutMs?: number;

  // mission 미지정일 때만 쓰는 스캐폴드 인자. arma_scaffold_mission 과 이름이 같다.
  world?: string;
  name?: string;
  playerType?: string;
  position?: readonly number[];
  safeSpawn?: SafeSpawnMode;
  initSqf?: string;

  // SP 전용
  waitForNewRptMs?: number;

  // MP 전용
  port?: number;
  password?: string;
  serverExtraArgs?: string[];
  serverReadyTimeoutMs?: number;
  bridgeReadyTimeoutMs?: number;
  clientConnectTimeoutMs?: number;
  /** 서버가 로비 역할을 배정한다(server.cfg 의 skipLobby 와 OnAutoSelectRole). 기본 true. */
  autoSlot?: boolean;
  /** 쓰지 않는다. 주면 무시하고 경고한다. */
  lobbyProbe?: boolean;
  /** 클라 i 가 받을 역할(roles[i-1]). 모자라는 클라는 서버 기본 배정이다. */
  roles?: PlayRole[];
  expectPlayers?: number;
  /** 붙일 클라 수(mp). 기본은 roles 길이, 그것도 없으면 1. 즉석 미션은 이만큼 슬롯을 만든다. */
  clients?: number;

  /** 새로 빌드한 PBO 나 작은 모드 폴더. 스택 전용 테스트 애드온으로 복사해 붙인다. */
  testMods?: string[];
}

export interface PlayStep {
  name: string;
  ok: boolean;
  elapsedMs: number;
  detail?: string;
}

export interface InGameExpectation {
  /** 미션 폴더 확장자에서 뽑은 기대 world. 빈 문자열이면 검사하지 않는다. */
  world: string;
  dedicated: boolean;
  minPlayers: number;
  /** 이 시각보다 오래된 텔레메트리는 이전 미션의 잔상이다. */
  startedAt: number;
  freshnessLimitMs: number;
  /** SP 용. 시뮬레이션이 실제로 도는지(missionTime 증가)를 본다. */
  requireSimProgress: boolean;
  /** 직전 프레임의 missionTime. null 이면 아직 비교할 프레임이 없다. */
  prevMissionTime: number | null;
}

export interface InGameVerdict {
  inGame: boolean;
  evidence: 'clients' | 'playerCount' | 'simProgress' | 'none';
  reason?: string;
  playing: number;
  playerCount: number;
  hcCount: number;
  clients: ClientInfo[] | null;
  world: string;
  mission: string;
  missionTime: number;
  telemetryAgeMs: number;
}

export interface PlayResult {
  ok: boolean;
  error?: string;
  mode: PlayMode;
  dryRun: boolean;
  phase: PlayPhase;
  steps: PlayStep[];
  mission: {
    origin: 'scaffolded' | 'given';
    ref: string;
    path?: string;
    template?: string;
    world: string;
    files?: string[];
    safeSpawn?: SafeSpawnMode;
    position?: { requested: [number, number, number]; sqm: [number, number, number] };
  };
  autoSlot?: {
    requested: boolean;
    /** 모든 클라가 지정대로 들어갔으면 assigned, 아니면 처음 어긋난 클라의 상태다. */
    state: AutoSlotState;
    /** 로비에서 사람이 골라야 하는지. 서버가 배정하지 못했거나(로비를 강제한 미션) 인게임을 확인하지 못했을 때다. */
    humanNeeded: boolean;
    clients: AutoSlotClient[];
    /** 서버 RPT 의 훅 줄과 엔진의 OnSelectRole 오류 줄. */
    log: string[];
    serverRpt?: string;
  };
  inGame?: InGameVerdict & { confirmed: boolean; waitedMs: number };
  humanWait?: { waited: boolean; waitedMs: number };
  launch?: LaunchResult | MpLaunchResult;
  warnings: string[];
  aborted?: boolean;
  nextSteps?: string;
  totalMs: number;
}

/** 미션 폴더 확장자(<name>.<world>)에서 world 를 뽑는다. */
export function expectedWorldFromMission(missionRef: string): string {
  const base = path.basename(missionRef.replace(/[\\/]+$/, ''));
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1);
}

function sameWorld(actual: string, expected: string): boolean {
  if (!expected) return true;
  return actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

function isInGameState(state: number): boolean {
  // 음수는 애드온이 상태를 안 보낸 것이다(0.4.1 이전 PBO). 그때는 판단 근거가
  // hasUnit 뿐이므로 상태로 걸러내지 않는다.
  if (state < 0) return true;
  return state === IN_GAME_CLIENT_STATE;
}

/**
 * 클라 하나의 자동 배정 상태.
 * assigned 는 지정대로(지정이 없으면 서버 기본 배정으로) 역할을 받은 것, fallback 은 지정한 역할을 못 찾거나
 * 찬 슬롯이라 서버 기본 배정으로 간 것, mission-lobby 는 미션이 skipLobby = 0 으로 로비를 강제한 것이다.
 */
export type AutoSlotState = 'disabled' | 'assigned' | 'fallback' | 'no-evidence' | 'mission-lobby';

/** 클라 하나의 로비 자동 배정 결과. */
export interface AutoSlotClient {
  index: number;
  /** 서버 훅이 이 클라를 알아보는 이름(-name). default 스택 클라 1 은 없다. */
  name?: string;
  /** 지정. auto 는 서버 기본 배정, #n 은 역할 번호, 그 밖은 역할 글자다. */
  requested: string;
  state: AutoSlotState;
  /** 훅이 고른 역할 번호. 기본 배정에 맡겼으면 없다. */
  roleIndex?: number;
  /** 훅이 지정을 무엇으로 찾았는지: number, var(유닛 변수 이름), desc(역할 설명), nomatch, none. */
  match?: string;
  /** 서버에서 읽은 실제 역할 설명(roleDescription). */
  role?: string;
  type?: string;
  side?: string;
  varName?: string;
}

/** 판정에 쓰는 클라 하나. */
export interface AutoSlotClientInput {
  index: number;
  name?: string;
  role: PlayRole;
}

/**
 * 클라마다 훅 줄과 서버 플레이어를 맞춰 자동 배정 상태를 정한다. 순수 함수다.
 *
 * 이름을 아는 클라는 그 이름의 플레이어와 훅 줄을 쓴다. 이름을 모르는 클라(default 스택 클라 1)는
 * 다른 클라 이름에 없는 플레이어를 쓴다. players 가 null 이면 서버에서 읽지 못한 것이다.
 */
export function judgeAutoSlot(opts: {
  requested: boolean;
  clients: readonly AutoSlotClientInput[];
  hook: readonly AutoSelectLogLine[];
  players: readonly ServerPlayer[] | null;
  missionSkipLobby?: number;
  inGame: boolean;
}): { state: AutoSlotState; humanNeeded: boolean; clients: AutoSlotClient[] } {
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
  const known = opts.clients.map((c) => c.name).filter((n): n is string => !!n);
  const clients = opts.clients.map((c): AutoSlotClient => {
    const base: AutoSlotClient = {
      index: c.index,
      ...(c.name ? { name: c.name } : {}),
      requested: roleSpecText(c.role),
      state: 'disabled',
    };
    if (!opts.requested) return base;
    if (opts.missionSkipLobby === 0) return { ...base, state: 'mission-lobby' };

    const player = c.name
      ? opts.players?.find((p) => same(p.name, c.name!))
      : opts.players?.find((p) => !known.some((n) => same(n, p.name)));
    const playerName = player?.name ?? c.name;
    const hook = playerName ? [...opts.hook].reverse().find((h) => same(h.name, playerName)) : undefined;
    const out: AutoSlotClient = {
      ...base,
      ...(!c.name && player ? { name: player.name } : {}),
      ...(hook && hook.pick >= 0 ? { roleIndex: hook.pick } : {}),
      ...(hook ? { match: hook.match } : {}),
      ...(player
        ? { role: player.roleDescription, type: player.type, side: player.side, varName: player.varName }
        : {}),
      state: 'no-evidence',
    };
    if (!player) return out;
    if (c.role === null) return { ...out, state: 'assigned' };
    // 훅이 고른 역할의 설명과 실제 역할이 같으면 지정대로 들어간 것이다. 찬 슬롯이면 엔진이 기본 배정으로 보낸다.
    const tookPick = !!hook && hook.pick >= 0 && same(hook.role, player.roleDescription);
    return { ...out, state: tookPick ? 'assigned' : 'fallback' };
  });
  const firstOff = clients.find((c) => c.state !== 'assigned');
  const state: AutoSlotState = !opts.requested ? 'disabled' : (firstOff?.state ?? 'assigned');
  const humanNeeded = !opts.requested || state === 'mission-lobby' || !opts.inGame;
  return { state, humanNeeded, clients };
}

/** 텔레메트리 스냅샷 하나로 인게임 여부를 판정한다. 순수 함수다. */
export function evaluateInGame(
  snap: MissionSnapshot,
  expect: InGameExpectation,
): InGameVerdict {
  const telemetryAgeMs = snap.receivedAt > 0 ? Date.now() - snap.receivedAt : -1;
  const base = {
    playing: 0,
    playerCount: snap.playerCount,
    hcCount: snap.hcCount,
    clients: snap.clients,
    world: snap.world,
    mission: snap.mission,
    missionTime: snap.missionTime,
    telemetryAgeMs,
  };

  if (snap.receivedAt === 0) {
    return { ...base, inGame: false, evidence: 'none', reason: '아직 텔레메트리가 없다' };
  }
  if (snap.receivedAt < expect.startedAt) {
    return {
      ...base,
      inGame: false,
      evidence: 'none',
      reason: '이 실행보다 오래된 텔레메트리다(이전 미션의 잔상)',
    };
  }
  if (telemetryAgeMs >= expect.freshnessLimitMs) {
    return {
      ...base,
      inGame: false,
      evidence: 'none',
      reason: `텔레메트리가 ${telemetryAgeMs}ms 째 낡았다`,
    };
  }
  if (snap.world.trim().length === 0 || snap.mission.trim().length === 0) {
    return { ...base, inGame: false, evidence: 'none', reason: '활성 미션이 없다' };
  }
  if (!sameWorld(snap.world, expect.world)) {
    return {
      ...base,
      inGame: false,
      evidence: 'none',
      reason: `world 불일치 — 기대 ${expect.world}, 실제 ${snap.world}`,
    };
  }
  if (snap.dedicated !== expect.dedicated) {
    return {
      ...base,
      inGame: false,
      evidence: 'none',
      reason: expect.dedicated
        ? '전용 서버 텔레메트리가 아니다'
        : '전용 서버 텔레메트리다(SP 를 기대했다)',
    };
  }

  // clients 는 로비와 인게임을 구분한다. 구버전 PBO 와 SP 는 보내지 않으므로
  // 그때만 playerCount 로 물러선다.
  let playing: number;
  let evidence: InGameVerdict['evidence'];
  if (Array.isArray(snap.clients)) {
    playing = snap.clients.filter((c) => !c.isHC && c.hasUnit && isInGameState(c.state)).length;
    evidence = 'clients';
  } else {
    playing = snap.playerCount;
    evidence = 'playerCount';
  }

  if (playing < expect.minPlayers) {
    return {
      ...base,
      playing,
      inGame: false,
      evidence,
      reason: `인게임 플레이어 ${playing} 명 — ${expect.minPlayers} 명을 기다린다`,
    };
  }

  if (expect.requireSimProgress) {
    if (expect.prevMissionTime === null) {
      return {
        ...base,
        playing,
        inGame: false,
        evidence: 'simProgress',
        reason: '시뮬레이션 진행을 확인할 이전 프레임이 없다',
      };
    }
    if (snap.missionTime <= expect.prevMissionTime) {
      return {
        ...base,
        playing,
        inGame: false,
        evidence: 'simProgress',
        reason: `missionTime 이 ${expect.prevMissionTime} 에서 늘지 않았다(로딩 또는 브리핑)`,
      };
    }
    return { ...base, playing, inGame: true, evidence: 'simProgress' };
  }

  return { ...base, playing, inGame: true, evidence };
}

/** finish() 가 채우지 않는, 호출부가 정하는 부분. */
type PlayTail = Omit<
  PlayResult,
  'steps' | 'totalMs' | 'warnings' | 'mode' | 'dryRun' | 'mission'
>;

interface InGameWait {
  verdict: InGameVerdict;
  bridgeElapsedMs: number | null;
  elapsedMs: number;
  timedOut: boolean;
  aborted: boolean;
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (!signal) {
      setTimeout(() => resolve(false), ms);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class StepLog {
  private steps: PlayStep[] = [];
  private mark = Date.now();

  add(name: string, ok: boolean, detail?: string): void {
    const now = Date.now();
    this.steps.push({ name, ok, elapsedMs: now - this.mark, detail });
    this.mark = now;
  }

  list(): PlayStep[] {
    return this.steps;
  }
}

export class PlayOrchestrator {
  constructor(
    private cfg: Config,
    private clientRptDir: string,
    private launcher: Launcher,
    private mpLauncher: MpLauncher,
    private gateway: Gateway,
    private telemetry: TelemetryStore,
    /** 스택 런타임이 넣는다. 즉석 미션을 그 스택 폴더에 만든다. */
    private stack?: StackContext,
    /** 인게임 뒤 서버에서 플레이어 역할을 읽는다. 없으면 읽지 않는다. */
    private exec?: Pick<ExecManager, 'run'>,
  ) {}

  async play(input: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
    const startedAt = Date.now();
    const mode: PlayMode = input.mode ?? 'sp';
    const steps = new StepLog();
    const warnings: string[] = [];
    collectModeWarnings(mode, input, warnings);

    // 역할을 클라 수만큼 주면 clients 를 따로 주지 않아도 된다.
    const opts: PlayOptions =
      mode === 'mp' && input.clients === undefined && input.roles && input.roles.length > 1
        ? { ...input, clients: input.roles.length }
        : input;
    const roleError = mode === 'mp' ? rolesProblem(opts.roles, opts.clients ?? 1) : null;
    if (roleError) {
      return {
        ok: false,
        error: roleError,
        mode,
        dryRun: !!opts.dryRun,
        phase: 'none',
        steps: steps.list(),
        mission: { origin: opts.mission ? 'given' : 'scaffolded', ref: opts.mission ?? '', world: '' },
        warnings,
        totalMs: Date.now() - startedAt,
      };
    }

    // 미션 준비. dryRun 이어도 실제로 만든다 — Launcher 와 MpLauncher 가
    // dryRun 분기보다 먼저 미션 경로를 검사하기 때문이다.
    let missionInfo: PlayResult['mission'];
    try {
      missionInfo = this.prepareMission(opts);
    } catch (e) {
      return {
        ok: false,
        error: (e as Error).message,
        mode,
        dryRun: !!opts.dryRun,
        phase: 'none',
        steps: steps.list(),
        mission: { origin: opts.mission ? 'given' : 'scaffolded', ref: opts.mission ?? '', world: '' },
        warnings,
        totalMs: Date.now() - startedAt,
      };
    }
    steps.add(
      'mission',
      true,
      missionInfo.origin === 'scaffolded'
        ? `scaffolded ${missionInfo.template}`
        : `given ${missionInfo.ref}`,
    );

    const finish = (r: PlayTail): PlayResult => ({
      ...r,
      mode,
      dryRun: !!opts.dryRun,
      mission: missionInfo,
      steps: steps.list(),
      warnings,
      totalMs: Date.now() - startedAt,
    });

    return mode === 'sp'
      ? await this.playSp(opts, missionInfo, steps, warnings, finish, signal)
      : await this.playMp(opts, missionInfo, steps, warnings, finish, signal);
  }

  /** mission 을 주면 그대로 쓰고, 안 주면 최소 테스트 미션을 즉석에서 만든다. */
  private prepareMission(opts: PlayOptions): PlayResult['mission'] {
    if (opts.mission) {
      return {
        origin: 'given',
        ref: opts.mission,
        template: path.basename(opts.mission.replace(/[\\/]+$/, '')),
        world: expectedWorldFromMission(opts.mission),
      };
    }
    const scaffolded = scaffoldMission({
      world: opts.world,
      name: opts.name ?? 'mcp_play',
      playerType: opts.playerType,
      position: opts.position,
      safeSpawn: opts.safeSpawn,
      initSqf: opts.initSqf,
      // mp 로 클라를 여럿 붙이면 그만큼 플레이 가능한 슬롯을 만든다.
      slots: (opts.mode ?? 'sp') === 'mp' ? Math.max(1, opts.clients ?? 1) : 1,
      // 이름 있는 스택은 제 폴더에 만든다. 다른 스택이 돌리는 미션 폴더를 덮지 않는다.
      targetDir: this.stack?.scaffoldDir ?? defaultScaffoldDir(this.cfg.arma.missionsDir || undefined),
    });
    return {
      origin: 'scaffolded',
      ref: scaffolded.missionPath,
      path: scaffolded.missionPath,
      template: path.basename(scaffolded.missionPath),
      world: scaffolded.world,
      files: scaffolded.files,
      safeSpawn: scaffolded.safeSpawn,
      position: scaffolded.position,
    };
  }

  private async playSp(
    opts: PlayOptions,
    missionInfo: PlayResult['mission'],
    steps: StepLog,
    warnings: string[],
    finish: (r: PlayTail) => PlayResult,
    signal?: AbortSignal,
  ): Promise<PlayResult> {
    const launchStartedAt = Date.now();
    const launch = await this.launcher.launch({
      mission: missionInfo.ref,
      modset: opts.modset,
      mods: opts.mods,
      killRunning: opts.killRunning,
      extraArgs: opts.clientExtraArgs,
      waitForNewRptMs: opts.waitForNewRptMs,
      dryRun: opts.dryRun,
      testMods: opts.testMods,
      signal,
    });
    if (launch.warning) warnings.push(launch.warning);

    if (opts.dryRun) {
      steps.add('plan', true, 'dryRun — 게임을 실행하지 않았다');
      return finish({
        ok: launch.ok,
        error: launch.error,
        phase: 'mission',
        launch,
        nextSteps: 'dryRun 이라 인자만 계산했다. dryRun 을 빼면 실제로 실행하고 인게임까지 확인한다.',
      });
    }

    steps.add('launched', launch.ok, launch.ok ? `pid ${launch.pid ?? '?'}` : launch.error);
    if (!launch.ok) {
      return finish({
        ok: false,
        error: launch.error ?? 'Arma 실행 실패',
        phase: 'mission',
        launch,
        nextSteps: 'arma_rpt_read 로 클라이언트 RPT 를 확인하라.',
      });
    }

    const wait = await this.waitForInGame(
      {
        world: missionInfo.world,
        dedicated: false,
        minPlayers: 0,
        startedAt: launchStartedAt,
        // SP 는 사람 하나가 이미 클라이언트다. 시뮬레이션이 도는지가 진짜 신호다.
        requireSimProgress: true,
      },
      opts.bridgeReadyTimeoutMs ?? DEFAULT_SP_BRIDGE_TIMEOUT_MS,
      signal,
    );
    if (wait.bridgeElapsedMs !== null) steps.add('bridge', true, '브리지 텔레메트리 도착');
    steps.add(
      'inGame',
      wait.verdict.inGame,
      wait.verdict.inGame ? `missionTime ${wait.verdict.missionTime}` : wait.verdict.reason,
    );

    return finish({
      ok: wait.verdict.inGame,
      error: wait.verdict.inGame ? undefined : this.waitError(wait, opts.bridgeReadyTimeoutMs ?? DEFAULT_SP_BRIDGE_TIMEOUT_MS),
      phase: wait.verdict.inGame ? 'in-game' : wait.bridgeElapsedMs !== null ? 'bridge' : 'launched',
      launch,
      aborted: wait.aborted || undefined,
      inGame: { ...wait.verdict, confirmed: wait.verdict.inGame, waitedMs: wait.elapsedMs },
      nextSteps: wait.verdict.inGame
        ? '인게임 확인됨. arma_exec 와 arma_capture 를 쓸 수 있다.'
        : '미션이 아직 시작되지 않았다. arma_status(waitFor:"game") 와 arma_rpt_read 로 확인하라.',
    });
  }

  private async playMp(
    opts: PlayOptions,
    missionInfo: PlayResult['mission'],
    steps: StepLog,
    warnings: string[],
    finish: (r: PlayTail) => PlayResult,
    signal?: AbortSignal,
  ): Promise<PlayResult> {
    const autoSlot = opts.autoSlot ?? true;
    const clientCount = Math.max(1, opts.clients ?? 1);
    const roles = Array.from({ length: clientCount }, (_, i) => opts.roles?.[i] ?? null);
    const launchStartedAt = Date.now();

    const mp = await this.mpLauncher.launchMp(
      {
        mission: missionInfo.ref,
        modset: opts.modset,
        mods: opts.mods,
        port: opts.port,
        password: opts.password,
        // 서버가 미션을 먼저 띄워 두면 클라이언트가 할 일이 슬롯 선택 하나로 줄어든다.
        autoInit: true,
        serverOnly: false,
        killRunning: opts.killRunning,
        serverExtraArgs: opts.serverExtraArgs,
        clientExtraArgs: opts.clientExtraArgs,
        clients: clientCount,
        // 서버가 로비 역할을 배정한다(server.cfg 의 skipLobby 와 OnAutoSelectRole). 클라는 건드리지 않는다.
        autoSlot,
        ...(autoSlot ? { autoSlotRoles: roles } : {}),
        testMods: opts.testMods,
        dryRun: opts.dryRun,
        serverReadyTimeoutMs: opts.serverReadyTimeoutMs,
        bridgeReadyTimeoutMs: opts.bridgeReadyTimeoutMs,
        clientConnectTimeoutMs: opts.clientConnectTimeoutMs,
      },
      signal,
    );
    if (mp.warning) warnings.push(mp.warning);

    if (opts.dryRun) {
      steps.add('plan', true, 'dryRun — 서버도 클라이언트도 실행하지 않았다');
      return finish({
        ok: mp.ok,
        error: mp.error,
        phase: 'mission',
        launch: mp,
        autoSlot: {
          requested: autoSlot,
          ...judgeAutoSlot({
            requested: autoSlot,
            clients: this.autoSlotInputs(mp, roles),
            hook: [],
            players: null,
            missionSkipLobby: mp.autoSlot?.missionSkipLobby,
            inGame: false,
          }),
          log: [],
        },
        nextSteps: 'dryRun 이라 인자만 계산했다. dryRun 을 빼면 실제로 실행하고 인게임까지 확인한다.',
      });
    }

    steps.add('server', mp.server.ready, mp.server.readyLine ?? mp.error);
    if (mp.readiness?.bridge) {
      steps.add(
        'serverBridge',
        mp.bridgeReady,
        `generation ${mp.readiness.bridge.generation}/${mp.readiness.bridge.baselineGeneration}`,
      );
    }
    if (mp.client) steps.add('client', mp.client.launched, `pid ${mp.client.pid ?? '?'}`);
    if (mp.lobby) steps.add('lobby', mp.lobby.reached, mp.lobby.line);

    if (!mp.ok) {
      return finish({
        ok: false,
        error: mp.error ?? '멀티플레이 실행 실패',
        phase: mp.lobby?.reached
          ? 'lobby'
          : mp.client?.launched
            ? 'client'
            : mp.bridgeReady
              ? 'serverBridge'
              : mp.server.ready
                ? 'server'
                : 'mission',
        launch: mp,
        nextSteps:
          "서버는 살려 두었다. arma_rpt_read(source:'server') 와 arma_status(waitFor:'dedicated') 로 진단하라.",
      });
    }

    const wait = await this.waitForInGame(
      {
        world: missionInfo.world,
        dedicated: true,
        minPlayers: opts.expectPlayers ?? clientCount,
        startedAt: launchStartedAt,
        requireSimProgress: false,
      },
      opts.inGameTimeoutMs ?? DEFAULT_IN_GAME_TIMEOUT_MS,
      signal,
    );

    // 서버 RPT 의 훅 줄과 인게임 뒤 서버에서 읽은 플레이어 역할로 클라마다 들어간 역할을 맞춘다.
    const evidence = autoSlot ? await this.collectAutoSlotEvidence(mp.server.rpt?.path) : { lines: [], hook: [] };
    const players = autoSlot && wait.verdict.inGame ? await this.readServerPlayers(signal) : null;
    const judged = judgeAutoSlot({
      requested: autoSlot,
      clients: this.autoSlotInputs(mp, roles),
      hook: evidence.hook,
      players,
      missionSkipLobby: mp.autoSlot?.missionSkipLobby,
      inGame: wait.verdict.inGame,
    });
    const { state, humanNeeded } = judged;
    steps.add(
      'autoSlot',
      state === 'assigned',
      judged.clients
        .map((c) => `${c.index}:${c.state}${c.role !== undefined ? ` ${JSON.stringify(c.role)}` : ''}`)
        .join(', '),
    );
    steps.add(
      'inGame',
      wait.verdict.inGame,
      wait.verdict.inGame
        ? `${wait.verdict.playing} 명 인게임 (${wait.verdict.evidence})`
        : wait.verdict.reason,
    );

    if (autoSlot && state === 'fallback') {
      warnings.push(
        '지정한 역할에 넣지 못해 서버 기본 배정으로 들어간 클라가 있다(찾지 못했거나 찬 슬롯). ' +
          'autoSlot.clients 와 autoSlot.log 를 확인하라.',
      );
    }
    if (autoSlot && wait.verdict.inGame && state === 'no-evidence') {
      warnings.push(
        '자동 배정의 증거(서버 RPT 의 훅 줄과 서버에서 읽은 역할)를 찾지 못했다. autoSlot.log 와 서버 RPT 를 확인하라.',
      );
    }

    return finish({
      ok: wait.verdict.inGame,
      error: wait.verdict.inGame
        ? undefined
        : this.waitError(wait, opts.inGameTimeoutMs ?? DEFAULT_IN_GAME_TIMEOUT_MS),
      phase: wait.verdict.inGame ? 'in-game' : 'lobby',
      launch: mp,
      aborted: wait.aborted || undefined,
      autoSlot: {
        requested: autoSlot,
        state,
        humanNeeded,
        clients: judged.clients,
        log: evidence.lines,
        ...(mp.server.rpt ? { serverRpt: mp.server.rpt.name } : {}),
      },
      inGame: { ...wait.verdict, confirmed: wait.verdict.inGame, waitedMs: wait.elapsedMs },
      humanWait: { waited: wait.verdict.inGame && humanNeeded, waitedMs: wait.elapsedMs },
      nextSteps: wait.verdict.inGame
        ? "인게임 확인됨. arma_exec(mode:'server') 와 arma_capture 를 쓸 수 있다."
        : '로비에서 슬롯을 고르고 OK 를 누른 뒤 arma_status(waitFor:"dedicated") 로 확인하라.',
    });
  }

  private waitError(wait: InGameWait, timeoutMs: number): string {
    if (wait.aborted) return '대기가 취소되었다';
    return (
      `${timeoutMs}ms 안에 인게임 진입을 확인하지 못했다 — ${wait.verdict.reason ?? '사유 미상'}` +
      ` (world=${wait.verdict.world || '(none)'}, mission=${wait.verdict.mission || '(none)'},` +
      ` playerCount=${wait.verdict.playerCount})`
    );
  }

  /**
   * 텔레메트리로 인게임 진입을 기다린다.
   *
   * 5초 주기 push 를 기다리지 않고 1초에 한 번 즉시 push 를 요청한다.
   * arma_status(waitFor:'dedicated') 가 쓰는 것과 같은 방식이다.
   */
  private async waitForInGame(
    expect: Omit<InGameExpectation, 'prevMissionTime' | 'freshnessLimitMs'>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<InGameWait> {
    const t0 = Date.now();
    const freshnessLimitMs = Math.max(10_000, this.cfg.link?.staleAfterMs ?? 15_000);
    let prev: { receivedAt: number; missionTime: number } | null = null;
    let lastNudge = 0;
    let bridgeElapsedMs: number | null = null;
    let verdict: InGameVerdict;

    for (;;) {
      const snap = this.telemetry.current();
      if (
        bridgeElapsedMs === null &&
        snap.receivedAt >= expect.startedAt &&
        snap.world.trim().length > 0 &&
        snap.mission.trim().length > 0
      ) {
        bridgeElapsedMs = Date.now() - t0;
      }
      const prevMissionTime =
        prev && prev.receivedAt !== snap.receivedAt ? prev.missionTime : null;
      verdict = evaluateInGame(snap, { ...expect, freshnessLimitMs, prevMissionTime });
      if (snap.receivedAt > 0 && (!prev || prev.receivedAt !== snap.receivedAt)) {
        prev = { receivedAt: snap.receivedAt, missionTime: snap.missionTime };
      }
      if (verdict.inGame) {
        return { verdict, bridgeElapsedMs, elapsedMs: Date.now() - t0, timedOut: false, aborted: false };
      }
      if (signal?.aborted) {
        return { verdict, bridgeElapsedMs, elapsedMs: Date.now() - t0, timedOut: false, aborted: true };
      }
      const remaining = timeoutMs - (Date.now() - t0);
      if (remaining <= 0) {
        return { verdict, bridgeElapsedMs, elapsedMs: Date.now() - t0, timedOut: true, aborted: false };
      }
      if (this.gateway.isConnected() && Date.now() - lastNudge > TELEMETRY_NUDGE_INTERVAL_MS) {
        this.gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
        lastNudge = Date.now();
      }
      const aborted = await delay(Math.min(POLL_INTERVAL_MS, remaining), signal);
      if (aborted) {
        return { verdict, bridgeElapsedMs, elapsedMs: Date.now() - t0, timedOut: false, aborted: true };
      }
    }
  }

  /** 판정에 넘길 클라 목록. 띄운 클라가 없으면(dryRun 전 실패 등) 지정만으로 만든다. */
  private autoSlotInputs(mp: MpLaunchResult, roles: readonly PlayRole[]): AutoSlotClientInput[] {
    const launched = mp.clients ?? (mp.client ? [mp.client] : []);
    if (launched.length === 0) return roles.map((role, i) => ({ index: i + 1, role }));
    return launched.map((c) => ({ index: c.index, ...(c.name ? { name: c.name } : {}), role: roles[c.index - 1] ?? null }));
  }

  /**
   * 서버 RPT 를 한 번만 훑어 OnAutoSelectRole 훅 줄과 엔진의 OnSelectRole 오류 줄을 모은다.
   * 대기 중에 감시자를 띄우지 않고 인게임 판정이 끝난 뒤 한 번 본다.
   */
  private async collectAutoSlotEvidence(
    serverRptPath?: string,
  ): Promise<{ lines: string[]; hook: AutoSelectLogLine[] }> {
    const none = { lines: [], hook: [] };
    if (!serverRptPath) return none;
    try {
      const found = await searchRpt(path.dirname(serverRptPath), {
        pattern: AUTO_SLOT_LOG_PATTERN,
        file: serverRptPath,
        maxMatches: AUTO_SLOT_LOG_MAX_MATCHES,
        contextLines: 0,
      });
      const lines = (found?.matches ?? [])
        .map((m) => m.line.trim())
        .filter((l) => l.includes(AUTO_SELECT_LOG) || l.includes(ON_SELECT_ROLE_ERROR));
      return { lines, hook: parseAutoSelectLines(lines) };
    } catch (e) {
      log.warn(`[play] 서버 RPT 자동 배정 줄 검색 실패: ${(e as Error).message}`);
      return none;
    }
  }

  /** 인게임 뒤 서버에서 플레이어마다 역할을 읽는다. exec 가 없거나 실패하면 null 이다. */
  private async readServerPlayers(signal?: AbortSignal): Promise<ServerPlayer[] | null> {
    if (!this.exec || signal?.aborted) return null;
    try {
      const out = await this.exec.run({
        code: READ_PLAYERS_SQF,
        mode: 'server',
        timeoutMs: READ_PLAYERS_TIMEOUT_MS,
        label: 'arma_play autoSlot',
      });
      const entry = out.results[0];
      if (!out.ok || !entry || entry.parsed.kind !== 'value') return null;
      return parseServerPlayers(entry.parsed.value ?? "");
    } catch (e) {
      log.warn(`[play] 서버 플레이어 역할 읽기 실패: ${(e as Error).message}`);
      return null;
    }
  }
}

/** 모드에 맞지 않는 인자는 거부하지 않고 무시했다고 알린다. */
function collectModeWarnings(mode: PlayMode, opts: PlayOptions, warnings: string[]): void {
  const spOnly: (keyof PlayOptions)[] = ['waitForNewRptMs'];
  const mpOnly: (keyof PlayOptions)[] = [
    'port',
    'password',
    'serverExtraArgs',
    'serverReadyTimeoutMs',
    'clientConnectTimeoutMs',
    'autoSlot',
    'roles',
    'expectPlayers',
    'clients',
  ];
  const ignored = (mode === 'sp' ? mpOnly : spOnly).filter((k) => opts[k] !== undefined);
  if (ignored.length > 0) {
    warnings.push(`${mode} 모드에서 무시된 인자: ${ignored.join(', ')}`);
  }
  if (opts.lobbyProbe !== undefined) {
    warnings.push('lobbyProbe 는 쓰지 않아 무시했다. 로비 역할은 서버가 배정한다(autoSlot, roles).');
  }
  if (opts.mission && (opts.world || opts.position || opts.initSqf || opts.playerType)) {
    warnings.push('mission 을 지정해 스캐폴드 인자(world, position, initSqf, playerType)는 무시했다.');
  }
}
