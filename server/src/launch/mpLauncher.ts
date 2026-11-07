// mpLauncher.ts — 멀티플레이 테스트 오케스트레이션(데디 서버 + 클라 자동 접속).
//
// 시퀀스: 미션 MPMissions 배치 → server.cfg 생성 → 데디 서버 spawn →
// 서버 부팅 감지(서버 RPT 의 Steam 줄이나 서버 브리지) → 클라 spawn(-connect=127.0.0.1) →
// 서버 텔레메트리의 클라 목록으로 접속 판정.
//
// 엔진은 "Player ... connecting/connected" 와 "Host identity created" 를 서버 콘솔에만 쓰고
// RPT 에는 쓰지 않는다. 그래서 접속은 서버 텔레메트리로만 본다. 브리지 DLL 은 미션 postInit 에야
// pipe 에 접속하므로 autoInit 이 아닌 로비 대기에서는 접속을 판정하지 않는다. 모드셋은 클라 RPT
// 헤더에서 복원해 서버·클라가 동일한 -mod= 문자열을 받는다(selfModPath 보장으로 서버에도 @arma_mcp 로드).

import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import {
  resolveServerExePath,
  resolveServerImage,
  resolveServerProfilesDir,
  resolveMpMissionsDir,
} from '../config.js';
import { newestRpt, rptAfter, SERVER_RPT_RE } from '../rpt/rptFiles.js';
import { createDirWatcher } from '../rpt/rptWatch.js';
import { waitForPattern, type WaitResult } from '../rpt/rptReader.js';
import {
  CLIENT_IMAGE,
  KILL_WAIT_MS,
  SERVER_IMAGE,
  findRunningServerImage,
  isProcRunningAsync,
  killProcAsync,
  waitProcGone,
  waitPathsWritable,
  invalidateProcCache,
  type PathUnlockResult,
} from '../procs.js';
import { resolveModset } from './mods.js';
import {
  CLIENT_PROFILE_FLAGS,
  MIN_FITTED_WINDOW_WIDTH,
  WINDOW_LAYOUT_FLAGS,
  clientStackArgs,
  clientWindowPositions,
  clientWindowSize,
  fitClientWindowSize,
  tileClientSize,
  flagsIn,
  planLaunchTestMods,
  prepareClientProfile,
  stackOwnedIn,
  stackSpawnEnv,
  stripStackOwned,
  windowPositionArgs,
  withNoPause,
  withoutFlags,
  type ClientWindowSize,
  type FittedWindowSize,
  type LaunchStackOptions,
  type ScreenArea,
  type WindowPosition,
} from './stackArgs.js';
import { primaryWorkArea } from './screenArea.js';
import { planSummary, stageTestMods, type StageResult } from '../stack/testMods.js';
import { buildServerCfg, writeServerCfg, deployMissionToMpMissions } from './serverCfg.js';
import {
  autoSlotEntries,
  missionSkipLobby,
  rolesProblem,
  userAutoSlotLines,
  type AutoSlotEntry,
  type PlayRole,
} from './autoSlot.js';
import { battlEyeExeProblem, splitBattlEyeLines } from './battlEye.js';
import { log } from '../log.js';
import type { Gateway, GatewayFrame } from '../ipc/gateway.js';
import type { MissionSnapshot, TelemetryStore } from '../game/telemetry.js';
import { combineAbortSignals } from '../mcp/abort.js';
import { spawnDetached, type DetachedProcess } from './spawn.js';
import { noteLaunchedClient, plannedTileSizes } from '../tiler/tilerService.js';
import { TILE_SLOTS, stackAllowed } from '../tiler/windowTiler.js';
import { DEFAULT_STACK_ID } from '../stack/stackContext.js';

// 데디 서버 부팅 완료 줄. waitForPattern 이 대소문자 무시 정규식으로 컴파일한다.
// Steam 서버 초기화 줄이다. "Host identity created" 는 서버 콘솔에만 찍혀 RPT 에 없다.
// loopback 서버는 Steam 초기화를 건너뛰어 이 줄도 없다. 그때는 서버 브리지로 판정한다(waitServerReady).
// 예: "14:50:29 Initializing Steam server - Game Port: 2302, Steam Query Port: 2303"
//     "14:50:32 Connected to Steam servers. Temporary Steam ID: ..."
export const SERVER_READY_PATTERN = 'Initializing Steam server - Game Port|Connected to Steam servers';
/** 서버가 읽을 server.cfg 를 바꾸는 인자. 서버는 MCP 가 만든 server.cfg 만 읽는다. */
const SERVER_CONFIG_FLAGS: readonly string[] = ['-config'];

/** killMp 가 쓰는 프로세스와 파일 함수. 테스트에서 생성자로 바꿔 끼운다. */
export interface MpProcFns {
  findRunningServerImage: typeof findRunningServerImage;
  isProcRunningAsync: typeof isProcRunningAsync;
  killProcAsync: typeof killProcAsync;
  waitProcGone: typeof waitProcGone;
  waitPathsWritable: typeof waitPathsWritable;
}

const DEFAULT_PROC_FNS: MpProcFns = {
  findRunningServerImage,
  isProcRunningAsync,
  killProcAsync,
  waitProcGone,
  waitPathsWritable,
};

export interface KillEntry {
  killed: boolean;
  /**
   * 프로세스가 없는지. waitMs 0 으로 종료만 하고 확인하지 않았으면 생략된다.
   * taskkill 이 실패했거나 처음부터 없었으면 늘 적는다.
   */
  gone?: boolean;
  waitedMs: number;
  detail: string;
}

export interface KillMpResult {
  client?: KillEntry;
  server?: KillEntry;
  unlock?: PathUnlockResult[];
}

export interface KillMpOptions {
  /** 종료 뒤 프로세스가 사라지기를 기다리는 상한(ms). 0 이면 기다리지 않는다. 기본 KILL_WAIT_MS. */
  waitMs?: number;
  /** 종료 뒤 쓰기 가능해질 때까지 기다릴 파일이나 디렉터리. */
  unlockPaths?: string[];
  /**
   * 대기를 멈추는 신호. 걸리면 종료 신호는 이미 보낸 채로 프로세스와 잠금 대기만 멈춘다.
   * 확인하지 못한 프로세스는 gone:false, 잠긴 경로는 ABORTED 로 남는다.
   */
  signal?: AbortSignal;
}

/** 살아 남은 프로세스가 없고 잠금 대기가 모두 풀렸으면 true. */
export function killSucceeded(res: KillMpResult): boolean {
  const entries = [res.client, res.server].filter((e): e is KillEntry => e !== undefined);
  return entries.every((e) => e.gone !== false) && (res.unlock ?? []).every((u) => u.ok);
}

export interface MpLaunchOptions {
  mission: string; // 필수. 절대경로 또는 missionsDir 하위 이름
  modset?: 'rpt' | 'explicit' | 'none';
  mods?: string[];
  port?: number;
  password?: string;
  autoInit?: boolean; // true 면 persistent=1 + -autoInit (로비 없이 즉시 미션 시작)
  serverOnly?: boolean; // 클라 spawn 생략
  killRunning?: boolean;
  serverExtraArgs?: string[];
  clientExtraArgs?: string[];
  dryRun?: boolean;
  serverReadyTimeoutMs?: number; // 기본 60000
  bridgeReadyTimeoutMs?: number; // autoInit 브리지 준비 대기, 기본 120000
  clientConnectTimeoutMs?: number; // 기본 180000 (대형 모드팩 클라 부팅 감안)
  /** 붙일 클라 수. 기본 1. 둘 이상은 스택 런타임에서만 된다. */
  clients?: number;
  /** 클라 i(1부터)에만 더할 인자. MCP 입력이 아니다. */
  clientArgsFor?: (index: number) => string[];
  /**
   * 서버가 로비 역할을 배정한다. server.cfg 에 skipLobby = 1 과 OnAutoSelectRole 훅을 넣는다.
   * 기본은 autoInit 이다. 로비 대기(autoInit false)에는 쓸 수 없다.
   */
  autoSlot?: boolean;
  /** autoSlotRoles[i-1] 이 클라 i 의 지정이고 null 이나 빈 칸은 서버 기본 배정이다. */
  autoSlotRoles?: PlayRole[];
  /** 새로 빌드한 PBO 나 작은 모드 폴더. 스택 전용 테스트 애드온으로 복사해 붙인다. */
  testMods?: string[];
}

/** arma_launch_server 의 입력. autoSlot 은 받고 클라 지정(autoSlotRoles)은 받지 않는다. */
export type DedicatedLaunchOptions = Omit<
  MpLaunchOptions,
  | 'autoInit'
  | 'serverOnly'
  | 'clientExtraArgs'
  | 'clientConnectTimeoutMs'
  | 'clients'
  | 'clientArgsFor'
  | 'autoSlotRoles'
>;

/** 띄운 클라 하나. 순번은 1부터다. */
export interface ClientLaunch {
  index: number;
  launched: boolean;
  pid?: number;
  argString: string;
  /** 서버 훅이 이 클라를 알아보는 이름(-name). 모르면 없다. */
  name?: string;
  rpt?: { name: string; path: string };
  lobby?: { reached: boolean; line?: string; elapsedMs: number };
  /**
   * 데몬이 정한 창 크기(클라이언트 영역)와 -posX, -posY. 제 profiles 를 받는 창 모드 클라에만 있다.
   * 자리는 클라가 둘 이상이고 사용자가 -posX, -posY 를 주지 않았을 때만 있다.
   */
  window?: { width: number; height: number; x?: number; y?: number };
}

export interface BridgeReadiness {
  ready: boolean;
  baselineGeneration: number;
  generation: number;
  hello: boolean;
  sessionInfo: boolean;
  telemetry: boolean;
  elapsedMs: number;
  expected: { template: string; world: string };
  actual: { mission: string; world: string; dedicated: boolean };
  telemetrySnapshot?: MissionSnapshot;
}

export interface MpLaunchResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  mission: { source: string; template: string; deployedPath: string; deployMethod?: string };
  modSource: string;
  modCount: number;
  mods: string[];
  serverCfgText?: string; // dryRun 에서만 (실행 시엔 cfgPath 파일 참조)
  server: {
    launched: boolean;
    pid?: number;
    exePath: string;
    port: number;
    argString: string;
    cfgPath?: string;
    profilesDir: string;
    rpt?: { name: string; path: string };
    ready: boolean;
    readyLine?: string;
  };
  /** 첫 클라. 클라가 여럿이면 clients 에 모두 있다. */
  client?: ClientLaunch;
  clients?: ClientLaunch[];
  lobby?: { reached: boolean; line?: string; elapsedMs: number };
  /**
   * 로비 역할 자동 배정. autoInit 서버면 기본으로 있다. cfgLines 가 false 면 설정의 extraCfgLines 가 정한 줄(userCfgLines)을 썼다.
   * missionSkipLobby 는 미션 description.ext 가 정한 값이다. 0 이면 로비를 건너뛰지 않는다.
   */
  autoSlot?: { entries: AutoSlotEntry[]; cfgLines: boolean; userCfgLines?: string[]; missionSkipLobby?: number };
  /**
   * 클라가 둘 이상인 스택 실행의 창 배치. area 는 주 모니터 작업 영역, configured 는 설정 크기, size 는 이번에 쓴 크기다.
   * mode 는 fitClientWindowSize 와 같고, userArgs 면 그 인자가 userArgs 에 있다.
   */
  windowLayout?: {
    area: ScreenArea;
    configured: ClientWindowSize;
    size: ClientWindowSize;
    mode: FittedWindowSize['mode'];
    userArgs?: string[];
  };
  missionStarted: boolean;
  bridgeReady: boolean;
  readiness?: {
    serverElapsedMs: number;
    bridge?: BridgeReadiness;
    processAlive?: boolean;
  };
  aborted?: boolean;
  nextSteps?: string;
  warning?: string;
  /** 테스트 애드온. dryRun 은 계획, 실제 실행은 만든 결과다. */
  testMods?: StageResult;
}

export interface MpLauncherBridgeDeps {
  gateway: Gateway;
  telemetry: TelemetryStore;
}

export class MpLauncher {
  private procs: MpProcFns;

  constructor(
    private cfg: Config,
    private clientRptDir: string,
    private bridgeDeps?: MpLauncherBridgeDeps,
    procs: Partial<MpProcFns> = {},
    /** 스택 런타임이 넣는다. 없으면 0.4 와 같게 돈다. */
    private stack?: LaunchStackOptions,
  ) {
    this.procs = { ...DEFAULT_PROC_FNS, ...procs };
  }

  /** launcher.resolveMissionPath 와 동일 규칙(절대경로/구분자 포함 → 그대로, 아니면 missionsDir 하위). */
  private resolveMissionPath(mission: string): string | null {
    if (path.isAbsolute(mission) || /[\\/]/.test(mission)) {
      return existsSync(mission) ? path.resolve(mission) : null;
    }
    if (this.cfg.arma.missionsDir) {
      const candidate = path.join(this.cfg.arma.missionsDir, mission);
      if (existsSync(candidate)) return path.resolve(candidate);
    }
    return null;
  }

  /**
   * 클라와 서버를 강제 종료하고, 프로세스가 사라지기를 기다린 뒤 unlockPaths 의 잠금이 풀리기를 기다린다.
   * 전체 대기는 waitMs 하나를 나눠 쓴다. 프로세스가 늦게 사라지면 잠금 대기에 남는 시간이 줄어든다.
   */
  async killMp(
    target: 'client' | 'server' | 'all' = 'all',
    opts: KillMpOptions = {},
  ): Promise<KillMpResult> {
    const fns = this.procs;
    const waitMs = Math.max(0, opts.waitMs ?? KILL_WAIT_MS);
    const deadline = Date.now() + waitMs;
    const out: KillMpResult = {};

    const killOne = async (image: string): Promise<KillEntry> => {
      const kill = await fns.killProcAsync(image);
      if (!kill.killed) {
        // 미실행이거나 taskkill 이 실패했다. killProcAsync 가 방금 강제 조회한 캐시를 읽는다.
        if (!(await fns.isProcRunningAsync(image))) return { ...kill, gone: true, waitedMs: 0 };
        // taskkill 이 실패했는데 프로세스가 남아 있다. waitMs 0 이어도 성공으로 적지 않는다.
        if (waitMs <= 0) return { ...kill, gone: false, waitedMs: 0 };
        // 이미 끝나는 중인 프로세스에는 taskkill 이 실패한다. 남은 시간 안에 사라지는지 본다.
      } else if (waitMs <= 0) {
        return { ...kill, waitedMs: 0 };
      }
      const t0 = Date.now();
      const gone = await fns.waitProcGone(image, waitMs, 150, opts.signal);
      return { ...kill, gone, waitedMs: Date.now() - t0 };
    };

    // tasklist/taskkill 스폰이 회당 수백 ms — 클라/서버를 병렬로 처리한다.
    // 서버는 실제로 실행 중이라고 확인된 이미지만 종료한다(설정 exe 우선, 없으면 알려진 후보).
    const killServer = async (): Promise<KillEntry> => {
      const image = await fns.findRunningServerImage(resolveServerImage(this.cfg), true);
      if (!image) {
        return {
          killed: false,
          gone: true,
          waitedMs: 0,
          detail: `${resolveServerImage(this.cfg)} 미실행`,
        };
      }
      return killOne(image);
    };
    const [client, server] = await Promise.all([
      target !== 'server' ? killOne(CLIENT_IMAGE) : Promise.resolve(undefined),
      target !== 'client' ? killServer() : Promise.resolve(undefined),
    ]);
    if (client) out.client = client;
    if (server) out.server = server;

    const unlockPaths = opts.unlockPaths ?? [];
    if (unlockPaths.length > 0) {
      out.unlock = await fns.waitPathsWritable(unlockPaths, {
        timeoutMs: Math.max(0, deadline - Date.now()),
        signal: opts.signal,
      });
    }
    return out;
  }

  launchServer(opts: DedicatedLaunchOptions, signal?: AbortSignal): Promise<MpLaunchResult> {
    return this.launchMp(
      {
        ...opts,
        autoInit: true,
        serverOnly: true,
      },
      signal,
    );
  }

  async launchMp(opts: MpLaunchOptions, signal?: AbortSignal): Promise<MpLaunchResult> {
    const mp = this.cfg.mp;
    const port = opts.port ?? mp.port;
    const password = opts.password ?? mp.password;
    const autoInit = !!opts.autoInit;
    const serverExePath = resolveServerExePath(this.cfg);
    const profilesDir = resolveServerProfilesDir(this.cfg);
    const mpMissionsDir = resolveMpMissionsDir(this.cfg);
    const cfgDir = path.join(profilesDir, '..'); // ~/.arma-mcp/server
    const serverReadyTimeoutMs = opts.serverReadyTimeoutMs ?? 60000;
    const bridgeReadyTimeoutMs = opts.bridgeReadyTimeoutMs ?? 120000;
    const clientConnectTimeoutMs = opts.clientConnectTimeoutMs ?? 180000;
    const launchStartedAt = Date.now();

    // 미션 해석.
    const missionPath = this.resolveMissionPath(opts.mission);
    const failBase = (
      error: string,
      partial?: Partial<MpLaunchResult>,
    ): MpLaunchResult => ({
      ok: false,
      error,
      dryRun: !!opts.dryRun,
      mission: {
        source: missionPath ?? opts.mission,
        template: missionPath ? path.basename(missionPath) : '',
        deployedPath: '',
      },
      modSource: '',
      modCount: 0,
      mods: [],
      server: {
        launched: false,
        exePath: serverExePath,
        port,
        argString: '',
        profilesDir,
        ready: false,
      },
      missionStarted: false,
      bridgeReady: false,
      ...partial,
    });

    if (!missionPath) return failBase(`mission not found: ${opts.mission}`);
    // 로비 역할 자동 배정은 미션이 이미 도는 autoInit 서버에서만 쓴다. 로비 대기는 사람이 고르는 실행이다.
    if (opts.autoSlot === true && !autoInit) {
      return failBase('autoSlot 은 autoInit 서버에서만 쓴다. autoInit:true 를 함께 주거나 autoSlot 을 뺀다');
    }
    const autoSlotOn = autoInit && opts.autoSlot !== false;
    if (opts.autoSlotRoles?.length && !autoSlotOn) {
      return failBase('roles 는 서버가 역할을 배정할 때만 쓴다. autoInit:true 로 띄우고 autoSlot:false 를 뺀다');
    }
    const ctx = this.stack?.ctx;
    const named = ctx !== undefined && !ctx.isDefault;
    if (named) {
      // 이름 있는 스택의 포트와 profiles 는 스택이 정한다. -profiles 가 곧 스택 소속의 표시다.
      if (opts.port !== undefined && opts.port !== ctx.port) {
        return failBase(
          `스택 ${ctx.id} 의 게임 포트는 ${ctx.port} 로 정해져 있다. port 를 빼고 부른다`,
        );
      }
      const owned = [...stackOwnedIn(opts.serverExtraArgs), ...stackOwnedIn(opts.clientExtraArgs)];
      if (owned.length > 0) {
        return failBase(`스택 ${ctx.id} 에서는 스택이 정하는 인자를 줄 수 없다: ${owned.join(' ')}`);
      }
    }
    // 이름 있는 스택은 MPMissions 에 이름을 달리 배치한다. 다른 스택이 돌리는 같은 이름의
    // 미션 폴더를 지우고 다시 쓰지 않기 위해서다. world 확장자는 그대로다.
    const template = ctx ? ctx.templateFor(path.basename(missionPath)) : path.basename(missionPath);

    // 모드셋(서버·클라 공용).
    const { modString, modSource, warning } = resolveModset(
      this.cfg,
      this.stack?.modsetRptDir ?? this.clientRptDir,
      opts,
      { stacksRoot: this.stack?.stacksRoot },
    );
    // 기본 모드. selfModPath 확인은 오버레이로 바뀌기 전의 이 목록으로 한다.
    const baseMods = modString.split(';').filter(Boolean);

    // 클라 수. 둘째 클라부터는 스택 폴더에 제 profiles 를 받아야 하므로 스택 런타임이 필요하다.
    const clientCount = opts.serverOnly ? 0 : Math.floor(opts.clients ?? 1);
    const maxClients = this.cfg.stacks?.maxClients ?? 4;
    if (!opts.serverOnly && (clientCount < 1 || clientCount > maxClients)) {
      return failBase(`clients 는 1 부터 ${maxClients}(stacks.maxClients) 까지다: ${opts.clients}`);
    }
    if (clientCount > 1 && !ctx) {
      return failBase('클라를 여럿 띄우려면 스택 런타임이 필요하다');
    }
    const rolesError = rolesProblem(opts.autoSlotRoles, clientCount);
    if (rolesError) return failBase(rolesError);
    // 클라가 여럿이면 클라마다 profiles 와 이름을 스택이 정한다. 모든 클라에 붙는 인자로 주면 프로필이 겹친다.
    const sharedProfileArgs = clientCount > 1 ? flagsIn(opts.clientExtraArgs, CLIENT_PROFILE_FLAGS) : [];
    if (sharedProfileArgs.length > 0) {
      return failBase(
        `클라를 여럿 띄울 때는 클라마다 profiles 와 이름을 스택이 정한다. clientExtraArgs 에서 뺀다: ${sharedProfileArgs.join(' ')}`,
      );
    }
    // BattlEye 는 늘 끈다. 서버는 MCP 가 만든 server.cfg 만 읽고, 클라는 BattlEye 실행기를 거치지 않는다.
    const extraConfigArgs = flagsIn(opts.serverExtraArgs, SERVER_CONFIG_FLAGS);
    if (extraConfigArgs.length > 0) {
      return failBase(
        `serverExtraArgs 로 -config 를 줄 수 없다. 서버는 MCP 가 만든 server.cfg(BattlEye = 0)만 읽는다: ${extraConfigArgs.join(' ')}`,
      );
    }
    const exeProblem = clientCount > 0 ? battlEyeExeProblem(this.cfg.arma.exePath) : null;
    if (exeProblem) return failBase(exeProblem);

    // 새로 빌드한 PBO 는 스택 전용 테스트 애드온으로 붙인다. 겹친 기본 모드는 오버레이로 바뀐다.
    const testPlan = await planLaunchTestMods(this.stack, this.cfg, baseMods, opts.testMods);
    if (!testPlan.ok) return failBase(testPlan.error);
    const mods = testPlan.plan ? testPlan.plan.mods : baseMods;
    const finalModString = mods.join(';');

    // 인자 조립.
    const plannedCfgPath = path.join(path.resolve(cfgDir), 'server.cfg');
    const serverParts = [
      `-config="${plannedCfgPath}"`,
      `-port=${port}`,
      `-profiles="${profilesDir}"`,
    ];
    if (autoInit) serverParts.push('-autoInit');
    serverParts.push(
      ...(named ? stripStackOwned(mp.serverBaseArgs) : withoutFlags(mp.serverBaseArgs, SERVER_CONFIG_FLAGS)),
    );
    if (opts.serverExtraArgs) serverParts.push(...opts.serverExtraArgs);
    if (finalModString) serverParts.push(`-mod="${finalModString}"`);
    const serverArgString = serverParts.join(' ');

    // 클라가 여럿이면 창 모드 클라를 주 모니터 작업 영역 안에 나란히 놓는다. 설정 크기로 겹치지 않게
    // 다 안 들어가면 비율을 지키며 창을 줄인다. 사용자가 창 크기나 자리 인자를 줬으면 줄이지 않는다.
    // 창 타일러가 켜져 있고 이 스택이 대상이며 클라가 칸 수 이하면 타일러가 칸에 놓는다. 그때는 칸 크기로 띄우고 자리는 정하지 않는다.
    // 게임은 시작 중에 바뀐 창 크기를 렌더 해상도에 반영하지 않는다. 그래서 칸 크기를 Arma3.cfg 에 적어 처음부터 그 크기로 띄운다.
    // 타일러가 돌면 클라마다 받을 칸을 묻는다. 다른 게임 창이 주 모니터 칸을 쓰고 있으면 다른 모니터 칸 크기다.
    // 클라가 하나여도 다른 게임 창이 떠 있으면 타일러가 놓으므로 칸 크기로 띄운다.
    const configuredWindow = clientWindowSize(this.cfg);
    const stackId = ctx?.id ?? DEFAULT_STACK_ID;
    const tiled =
      this.cfg.windowTiler.enabled && clientCount <= TILE_SLOTS && stackAllowed(stackId, this.cfg.windowTiler.stacks);
    const userArgs = flagsIn(
      [
        ...this.cfg.arma.baseArgs,
        ...(opts.clientExtraArgs ?? []),
        ...Array.from({ length: clientCount }, (_, i) => opts.clientArgsFor?.(i + 1) ?? []).flat(),
      ],
      WINDOW_LAYOUT_FLAGS,
    );
    const plannedSizes =
      ctx && tiled && userArgs.length === 0 ? (this.stack?.tilePlan ?? plannedTileSizes)(stackId, clientCount) : null;
    if (plannedSizes) {
      const shown = plannedSizes.map((s) => (s ? `${s.width}x${s.height}` : '칸 없음')).join(', ');
      log.info(`[launchMp] 창 타일러 칸 크기로 띄움: ${shown} (스택 ${stackId})`);
    }
    let windowLayout: MpLaunchResult['windowLayout'];
    let windowPositions: WindowPosition[] | null = null;
    if (ctx && clientCount > 1) {
      const area = await (this.stack?.workArea ?? primaryWorkArea)();
      const fitted: FittedWindowSize =
        userArgs.length > 0
          ? { size: configuredWindow, mode: 'userArgs' }
          : tiled
            ? { size: plannedSizes?.[0] ?? tileClientSize(area, configuredWindow), mode: 'tiled' }
            : fitClientWindowSize(clientCount, configuredWindow, area);
      windowPositions = tiled ? null : clientWindowPositions(clientCount, fitted.size, area);
      windowLayout = {
        area,
        configured: configuredWindow,
        size: fitted.size,
        mode: fitted.mode,
        ...(userArgs.length > 0 ? { userArgs } : {}),
      };
      if (fitted.mode === 'floor') {
        log.warn(
          `[launchMp] 클라 ${clientCount}개 창을 폭 ${MIN_FITTED_WINDOW_WIDTH} 아래로 줄여야 겹치지 않아 ` +
            `설정 크기 ${configuredWindow.width}x${configuredWindow.height} 로 겹쳐 놓는다`,
        );
      }
    }
    // 이번 실행의 창 모드 클라 창과 렌더 크기. prepareClientProfile 이 Arma3.cfg 에 적는다.
    const clientWindowOf = (index: number): ClientWindowSize =>
      plannedSizes?.[index - 1] ?? windowLayout?.size ?? configuredWindow;
    const clientArgsOf = (index: number): { argString: string; position?: WindowPosition } => {
      // 제 profiles 를 받는 클라는 설정의 -profiles 와 -name 을 쓰지 않는다. 클라마다 프로필이 달라야 한다.
      // 그 클라가 창 모드다(clientStackArgs 의 -window).
      const ownProfile = Boolean(ctx?.clientProfilesDir(index));
      const parts = [
        ...(ownProfile ? stripStackOwned(this.cfg.arma.baseArgs) : this.cfg.arma.baseArgs),
        ...(ctx ? clientStackArgs(ctx, index) : []),
        `-connect=127.0.0.1`,
        `-port=${port}`,
      ];
      if (password) parts.push(`-password=${password}`);
      if (opts.clientExtraArgs) parts.push(...opts.clientExtraArgs);
      if (opts.clientArgsFor) parts.push(...opts.clientArgsFor(index));
      const positionArgs = windowPositionArgs(ownProfile ? windowPositions?.[index - 1] : undefined, parts);
      parts.push(...positionArgs);
      // 창이 포커스를 잃어도 게임이 멈추지 않게 한다. 설정에 이미 있으면 그대로 둔다.
      const withPause = withNoPause(parts);
      if (finalModString) withPause.push(`-mod="${finalModString}"`);
      const position = positionArgs.length > 0 ? windowPositions?.[index - 1] : undefined;
      return { argString: withPause.join(' '), ...(position ? { position } : {}) };
    };
    const plannedClients: ClientLaunch[] = Array.from({ length: clientCount }, (_, i) => {
      const { argString, position } = clientArgsOf(i + 1);
      const name = ctx?.clientName(i + 1) ?? nameFlagIn(argString);
      // 제 profiles 를 받는 창 모드 클라만 데몬이 창 크기를 정한다.
      const window = ctx?.clientProfilesDir(i + 1) ? { ...clientWindowOf(i + 1), ...(position ?? {}) } : undefined;
      return { index: i + 1, launched: false, argString, ...(name ? { name } : {}), ...(window ? { window } : {}) };
    });

    // 로비 역할 자동 배정. 설정의 extraCfgLines 가 이미 정했으면 그 줄을 따르고 데몬 줄은 넣지 않는다.
    // 지정이 없는 클라와 서버만 띄운 뒤 붙는 클라는 서버 기본 배정이다.
    let autoSlot: MpLaunchResult['autoSlot'];
    if (autoSlotOn) {
      const roles = opts.autoSlotRoles ?? [];
      const entries = autoSlotEntries(roles, clientCount, (i) => plannedClients[i - 1]?.name ?? null);
      const userCfgLines = userAutoSlotLines(mp.extraCfgLines);
      autoSlot =
        userCfgLines.length > 0 ? { entries, cfgLines: false, userCfgLines } : { entries, cfgLines: true };
    }

    const serverCfgText = buildServerCfg({
      hostname: named ? `${mp.hostname} [${ctx.id}]` : mp.hostname,
      password,
      adminPassword: mp.adminPassword,
      // 로컬 클라가 모두 들어올 자리는 있어야 한다.
      maxPlayers: Math.max(mp.maxPlayers, clientCount),
      template,
      autoInit,
      // 같은 Steam ID 클라 둘째부터 Steam 티켓 검사에 걸리지 않게 LAN 모드로 연다.
      loopback: clientCount > 1,
      ...(autoSlot?.cfgLines ? { autoSlot: autoSlot.entries } : {}),
      extraCfgLines: mp.extraCfgLines,
    });
    const droppedBattlEye = splitBattlEyeLines(mp.extraCfgLines).dropped;
    const droppedConfig = flagsIn(mp.serverBaseArgs, SERVER_CONFIG_FLAGS);
    const skipLobby = autoSlot ? missionSkipLobby(missionPath) : undefined;
    if (autoSlot && skipLobby !== undefined) autoSlot.missionSkipLobby = skipLobby;

    const base: MpLaunchResult = {
      ok: true,
      dryRun: !!opts.dryRun,
      mission: {
        source: missionPath,
        template,
        deployedPath: path.join(mpMissionsDir, template),
      },
      modSource,
      modCount: mods.length,
      mods,
      server: {
        launched: false,
        exePath: serverExePath,
        port,
        argString: serverArgString,
        cfgPath: plannedCfgPath,
        profilesDir,
        ready: false,
      },
      missionStarted: false,
      bridgeReady: false,
      warning: joinWarnings(
        warning,
        autoInit ? missionPersistenceWarning(missionPath) : undefined,
        droppedBattlEye.length > 0
          ? `mp.extraCfgLines 의 BattlEye 줄은 넣지 않았다(BattlEye = 0 고정): ${droppedBattlEye.join(' ')}`
          : undefined,
        droppedConfig.length > 0
          ? `mp.serverBaseArgs 의 -config 는 빼고 띄웠다(MCP 가 만든 server.cfg 만 쓴다): ${droppedConfig.join(' ')}`
          : undefined,
        autoSlot?.userCfgLines
          ? `mp.extraCfgLines 가 정한 로비 배정 줄을 따랐다. 데몬의 skipLobby 와 OnAutoSelectRole 은 넣지 않았다: ${autoSlot.userCfgLines.join(' ')}`
          : undefined,
        skipLobby === 0
          ? '미션 description.ext 가 skipLobby = 0 이라 로비를 강제한다. 서버 자동 배정이 돌지 않아 역할은 사람이 고른다'
          : undefined,
        windowLayout?.mode === 'floor'
          ? `클라 창을 폭 ${MIN_FITTED_WINDOW_WIDTH} 아래로 줄여야 겹치지 않아 줄이지 않았다. ` +
              `설정 크기 ${configuredWindow.width}x${configuredWindow.height} 창이 겹친다`
          : undefined,
      ),
      ...(testPlan.plan ? { testMods: planSummary(testPlan.plan) } : {}),
      ...(autoSlot ? { autoSlot } : {}),
      ...(windowLayout ? { windowLayout } : {}),
    };

    if (opts.dryRun) {
      log.info('[launchMp] dryRun', serverArgString);
      return {
        ...base,
        serverCfgText,
        client: plannedClients[0],
        ...(plannedClients.length > 1 ? { clients: plannedClients } : {}),
      };
    }

    if (!serverExePath || !existsSync(serverExePath)) {
      return failBase(`데디 서버 실행파일 없음: ${serverExePath || '(미설정)'} — arma.serverExePath 설정 필요`);
    }
    if (!opts.serverOnly && !existsSync(this.cfg.arma.exePath)) {
      return failBase(`Arma3 클라 실행파일 없음: ${this.cfg.arma.exePath}`);
    }
    if (autoInit) {
      const selfModPath = this.cfg.arma.selfModPath;
      if (!selfModPath || !existsSync(selfModPath)) {
        return failBase(
          `MCP 애드온 경로 없음: ${selfModPath || '(미설정)'} — arma.selfModPath 를 서버에서 읽을 수 있는 @arma_mcp 경로로 설정`,
        );
      }
      if (!baseMods.some((mod) => samePath(mod, selfModPath))) {
        return failBase('MCP 애드온이 서버 -mod 인자에 포함되지 않음 — arma.selfModPath/모드셋 설정 확인');
      }
      if (!this.bridgeDeps) {
        return failBase('전용 서버 브리지 준비 검증을 사용할 수 없음 — 공유 Gateway/TelemetryStore 배선 필요');
      }
      if (this.bridgeDeps.gateway.getListenerState() !== 'ok') {
        return failBase('MCP 데몬이 게임 파이프를 소유하지 못함 — 중복 데몬을 종료한 뒤 다시 시도');
      }
    }
    if (named && this.stack?.bridgeGate) {
      const problem = await this.stack.bridgeGate();
      if (problem) return failBase(problem);
    }

    // 실행 중 검사(캐시 무시) — killRunning 이면 양쪽 정리.
    // 서버는 설정된 exe 이름 + 알려진 대체 이미지까지 본다. 고정 이름 하나만 보면
    // 프로파일링 빌드로 띄운 서버를 놓쳐 이 가드가 통과되고 서버가 이중 실행된다.
    // 스택 런타임은 this.procs 에 그 스택 프로세스만 보는 판을 넣는다. 다른 스택의 게임은 건드리지 않는다.
    const fns = this.procs;
    const [clientRunning, runningServerImage] = await Promise.all([
      fns.isProcRunningAsync(CLIENT_IMAGE, true),
      fns.findRunningServerImage(resolveServerImage(this.cfg), true),
    ]);
    const serverRunning = runningServerImage !== null;
    if (clientRunning || serverRunning) {
      if (opts.killRunning) {
        const clientKill = clientRunning ? await fns.killProcAsync(CLIENT_IMAGE) : undefined;
        const serverKill = runningServerImage ? await fns.killProcAsync(runningServerImage) : undefined;
        const [clientGone, serverGone] = await Promise.all([
          clientRunning ? fns.waitProcGone(CLIENT_IMAGE, KILL_WAIT_MS, 150) : Promise.resolve(true),
          runningServerImage
            ? fns.waitProcGone(runningServerImage, KILL_WAIT_MS, 150)
            : Promise.resolve(true),
        ]);
        if (!clientGone || !serverGone) {
          const stuck = [
            !clientGone ? `${CLIENT_IMAGE}: ${clientKill?.detail ?? '종료 확인 실패'}` : '',
            !serverGone
              ? `${runningServerImage ?? SERVER_IMAGE}: ${serverKill?.detail ?? '종료 확인 실패'}`
              : '',
          ]
            .filter(Boolean)
            .join(' / ');
          return failBase(`기존 Arma 프로세스가 종료되지 않아 새 서버를 시작하지 않음 — ${stuck}`);
        }
      } else {
        const who = [clientRunning && CLIENT_IMAGE, runningServerImage]
          .filter(Boolean)
          .join(', ');
        return failBase(`${who} 가 이미 실행 중 (killRunning:true 로 강제 종료 가능)`);
      }
    }
    if (signal?.aborted) {
      return failBase(abortMessage(signal), { aborted: true });
    }

    // 스택 게임이 모두 꺼진 뒤라 이전 테스트 애드온 스냅샷을 바꿀 수 있다.
    if (testPlan.plan && ctx) {
      const staged = await stageTestMods(testPlan.plan, { stackRoot: ctx.root, signal });
      base.testMods = staged;
      if (!staged.ok) return { ...base, ok: false, error: staged.error };
    }

    // 미션 배치 + server.cfg + profiles 디렉토리.
    const deploy = deployMissionToMpMissions(missionPath, mpMissionsDir, template);
    if (!deploy.ok) return failBase(deploy.error ?? '미션 배치 실패');
    base.mission.deployedPath = deploy.deployedPath;
    base.mission.deployMethod = deploy.method;
    mkdirSync(profilesDir, { recursive: true });
    const cfgPath = writeServerCfg(serverCfgText, path.resolve(cfgDir));
    base.server.cfgPath = cfgPath;

    // 서버 spawn 전에 현재 링크 generation 을 기록하고 이벤트 추적기를 먼저 붙인다.
    // 그래야 아주 빠른 hello/sessionInfo 도 놓치지 않고, 기존 링크를 성공으로 오인하지 않는다.
    const bridgeTracker =
      autoInit && this.bridgeDeps
        ? new BridgeReadinessTracker(
            this.bridgeDeps.gateway,
            this.bridgeDeps.telemetry,
            this.bridgeDeps.gateway.generation(),
            launchStartedAt,
            template,
          )
        : undefined;

    // 서버 spawn (launcher 와 동일한 verbatim 단일 문자열 — mod 경로 공백/괄호 보존).
    const prevServerRpt = newestRpt(profilesDir, SERVER_RPT_RE);
    const prevServerRptName = prevServerRpt ? prevServerRpt.name : '';
    let serverProcess: DetachedProcess;
    try {
      serverProcess = await spawnDetached(serverExePath, [serverArgString], {
        windowsVerbatimArguments: true,
        ...(ctx ? { env: stackSpawnEnv(ctx) } : {}),
      });
      base.server.pid = serverProcess.pid;
      invalidateProcCache();
    } catch (e) {
      bridgeTracker?.dispose();
      return failBase('서버 spawn 실패: ' + (e as Error).message);
    }
    base.server.launched = true;
    log.info(`[launchMp] server pid=${base.server.pid} port=${port} mods=${mods.length}`);
    const serverWait = combineAbortSignals(signal, serverProcess.exitSignal);
    const finishServerWait = <T extends MpLaunchResult>(result: T): T => {
      serverWait.dispose();
      return result;
    };

    // 서버 부팅 감지: 새 서버 RPT 출현 → 준비 패턴 대기.
    const readyDeadline = Date.now() + serverReadyTimeoutMs;
    let serverRpt = rptAfter(profilesDir, prevServerRptName, SERVER_RPT_RE);
    {
      const rptWatcher = createDirWatcher(profilesDir);
      try {
        while (!serverRpt && Date.now() < readyDeadline && !serverWait.signal.aborted) {
          await rptWatcher.wait(250, serverWait.signal);
          serverRpt = rptAfter(profilesDir, prevServerRptName, SERVER_RPT_RE);
        }
      } finally {
        rptWatcher.dispose();
      }
    }
    if (serverWait.signal.aborted) {
      bridgeTracker?.dispose();
      return finishServerWait({
        ...base,
        ok: false,
        ...waitFailure(signal, serverProcess, '전용 서버'),
        readiness: {
          serverElapsedMs: Date.now() - launchStartedAt,
          processAlive: !serverProcess.exitSignal.aborted,
        },
      });
    }
    if (!serverRpt) {
      bridgeTracker?.dispose();
      const alive = !serverProcess.exitSignal.aborted;
      return finishServerWait({
        ...base,
        ok: false,
        error:
          `서버 RPT 가 ${serverReadyTimeoutMs}ms 내에 생성되지 않음(프로세스 ${alive ? '실행 중' : '이미 종료'}) — ` +
          `profiles 경로(${profilesDir}) 또는 서버 RPT 를 arma_rpt_list(source:'server')로 확인`,
        readiness: { serverElapsedMs: Date.now() - launchStartedAt, processAlive: alive },
      });
    }
    base.server.rpt = { name: serverRpt.name, path: serverRpt.path };

    const readyTimeoutMs = Math.max(1000, readyDeadline - Date.now());
    const readyRpt = serverRpt.path;
    const ready = await waitServerReady(
      (readySignal) =>
        waitForPatternOrAbort(
          profilesDir,
          {
            pattern: SERVER_READY_PATTERN,
            file: readyRpt,
            fromEnd: false,
            timeoutMs: readyTimeoutMs,
            rptRe: SERVER_RPT_RE,
          },
          readySignal,
        ),
      bridgeTracker,
      readyTimeoutMs,
      serverWait.signal,
    );
    if (ready.aborted) {
      bridgeTracker?.dispose();
      return finishServerWait({
        ...base,
        ok: false,
        ...waitFailure(signal, serverProcess, '전용 서버'),
        readiness: {
          serverElapsedMs: Date.now() - launchStartedAt,
          processAlive: !serverProcess.exitSignal.aborted,
        },
      });
    }
    if (!ready.found) {
      bridgeTracker?.dispose();
      const alive = !serverProcess.exitSignal.aborted;
      return finishServerWait({
        ...base,
        ok: false,
        error:
          `서버 부팅 패턴("${SERVER_READY_PATTERN}") 미감지` +
          (bridgeTracker ? ', 서버 브리지도 준비되지 않음' : '') +
          ` — arma_rpt_read(source:'server') 로 서버 로그 확인 (모드 로딩이 느리면 serverReadyTimeoutMs 증가)`,
        readiness: { serverElapsedMs: Date.now() - launchStartedAt, processAlive: alive },
      });
    }
    base.server.ready = true;
    base.server.readyLine = ready.line;
    base.readiness = { serverElapsedMs: Date.now() - launchStartedAt };

    if (autoInit && bridgeTracker) {
      const bridge = await bridgeTracker.wait(bridgeReadyTimeoutMs, serverWait.signal);
      bridgeTracker.dispose();
      base.readiness.bridge = bridge;
      base.bridgeReady = bridge.ready;
      base.missionStarted = bridge.ready;
      if (!bridge.ready) {
        const alive = !serverProcess.exitSignal.aborted;
        base.readiness.processAlive = alive;
        return finishServerWait({
          ...base,
          ok: false,
          ...(serverWait.signal.aborted
            ? waitFailure(signal, serverProcess, '전용 서버')
            : {}),
          error: serverWait.signal.aborted
            ? waitFailure(signal, serverProcess, '전용 서버').error
            : `전용 서버 브리지가 ${bridgeReadyTimeoutMs}ms 내에 준비되지 않음` +
              `(프로세스 ${alive ? '실행 중' : '이미 종료'}, generation ${bridge.generation}/${bridge.baselineGeneration}, ` +
              `hello=${bridge.hello}, sessionInfo=${bridge.sessionInfo}, telemetry=${bridge.telemetry}) — ` +
              `expected=${bridge.expected.template}/${bridge.expected.world}, ` +
              `actual=${bridge.actual.mission || '(none)'}/${bridge.actual.world || '(none)'}, ` +
              `서버는 종료하지 않았으며 arma_status(waitFor:"dedicated")와 서버 RPT로 계속 진단 가능`,
        });
      }
    } else {
      bridgeTracker?.dispose();
    }

    if (serverWait.signal.aborted) {
      return finishServerWait({
        ...base,
        ok: false,
        ...waitFailure(signal, serverProcess, '전용 서버'),
        readiness: {
          ...base.readiness,
          serverElapsedMs: Date.now() - launchStartedAt,
          processAlive: !serverProcess.exitSignal.aborted,
        },
      });
    }

    // 서버가 역할을 배정하면 붙는 클라는 로비 없이 들어간다. 미션이 skipLobby = 0 이면 로비가 남는다.
    const slotAssigned = !!base.autoSlot && base.autoSlot.missionSkipLobby !== 0;
    if (opts.serverOnly) {
      return finishServerWait({
        ...base,
        nextSteps: autoInit
          ? '전용 서버 미션과 MCP 브리지가 준비됨. Arma 클라이언트 없이 arma_exec(mode:"server")/arma_status 사용 가능.' +
            (slotAssigned ? ' 나중에 붙는 클라는 서버가 역할을 배정해 로비 없이 들어간다.' : '')
          : '서버만 실행됨(autoInit=false, 로비 대기). 활성 미션 전에는 SQF 브리지가 없으며 클라이언트가 수동으로 미션을 시작해야 함.',
      });
    }

    // 클라 spawn. 여럿이면 앞 클라가 서버 텔레메트리에 보인 뒤 다음을 띄운다.
    // 한꺼번에 띄우면 한 PC 에서 모드 로딩이 겹쳐 모두 느려지고, 로비 슬롯도 순서대로 잡힌다.
    // 텔레메트리가 없는 로비 대기 실행은 앞 클라의 RPT 가 생긴 뒤 다음을 띄운다.
    const clients: ClientLaunch[] = [];
    let lastLobby: WaitResult | null = null;
    const lobbyStartedAt = Date.now();
    for (const planned of plannedClients) {
      const index = planned.index;
      const client: ClientLaunch = { ...planned };
      clients.push(client);
      const rptDir = ctx ? ctx.clientRptDir(index) : this.clientRptDir;
      const prevClientRpt = newestRpt(rptDir);
      const prevClientRptName = prevClientRpt ? prevClientRpt.name : '';
      // 이 클라를 띄우기 전에 이미 서버에 있던 이름. 이름을 모르는 클라는 새로 나타난 이름으로 판정한다.
      const baselineClientNames = this.bridgeDeps
        ? new Set(serverClientNames(this.bridgeDeps.telemetry.current()))
        : new Set<string>();
      if (ctx) await prepareClientProfile(ctx.clientProfilesDir(index), { window: clientWindowOf(index) });
      let clientProcess: DetachedProcess;
      try {
        clientProcess = await spawnDetached(this.cfg.arma.exePath, [client.argString], {
          windowsVerbatimArguments: true,
          ...(ctx ? { env: stackSpawnEnv(ctx) } : {}),
        });
        client.pid = clientProcess.pid;
        invalidateProcCache();
      } catch (e) {
        return finishServerWait({
          ...base,
          client: clients[0],
          clients,
          ok: false,
          error: `클라 ${index} spawn 실패: ` + (e as Error).message,
        });
      }
      client.launched = true;
      log.info(`[launchMp] client ${index} pid=${client.pid} -connect=127.0.0.1:${port}`);
      noteLaunchedClient({
        pid: client.pid,
        stack: ctx?.id ?? DEFAULT_STACK_ID,
        label: client.name ?? ctx?.id ?? DEFAULT_STACK_ID,
      });
      const clientWait = combineAbortSignals(serverWait.signal, clientProcess.exitSignal);
      try {
        // 접속 판정은 서버 텔레메트리의 클라 목록 하나다. 엔진은 접속 줄을 서버 콘솔에만 쓰고 RPT 에는
        // 쓰지 않는다. 서버 브리지는 autoInit 미션에서만 떠 있으므로 로비 대기 실행은 판정하지 않는다.
        const name = ctx?.clientName(index) ?? null;
        const telemetryWait =
          autoInit && this.bridgeDeps
            ? waitClientInTelemetry(
                this.bridgeDeps,
                name,
                baselineClientNames,
                clientConnectTimeoutMs,
                clientWait.signal,
              )
            : null;

        // 그 사이 새 클라 RPT 감지(부팅 확인용 — 실패해도 치명적이지 않음).
        const clientRptDeadline = Date.now() + Math.min(clientConnectTimeoutMs, 60000);
        {
          const rptWatcher = createDirWatcher(rptDir);
          try {
            while (Date.now() < clientRptDeadline && !clientWait.signal.aborted) {
              const after = rptAfter(rptDir, prevClientRptName);
              if (after) {
                client.rpt = { name: after.name, path: after.path };
                break;
              }
              await rptWatcher.wait(250, clientWait.signal);
            }
          } finally {
            rptWatcher.dispose();
          }
        }

        if (!telemetryWait) continue;
        const lobby = await telemetryWait;
        if (lobby.aborted && clientWait.signal.aborted) {
          return finishServerWait({
            ...base,
            client: clients[0],
            clients,
            ok: false,
            ...waitFailure(signal, serverProcess, '전용 서버', clientProcess, `Arma 클라이언트 ${index}`),
          });
        }
        client.lobby = { reached: lobby.found, line: lobby.line, elapsedMs: lobby.elapsedMs };
        lastLobby = lobby;
        if (!lobby.found) {
          return finishServerWait({
            ...base,
            client: clients[0],
            clients,
            lobby: { reached: false, elapsedMs: Date.now() - lobbyStartedAt },
            ok: false,
            error:
              `클라 ${index} 가 ${clientConnectTimeoutMs}ms 내에 서버 텔레메트리에 나타나지 않음 — ` +
              `클라 RPT(arma_rpt_read)와 서버 RPT(source:'server')로 원인 확인 (모드 로딩이 느리면 clientConnectTimeoutMs 증가)`,
          });
        }
      } finally {
        clientWait.dispose();
      }
    }

    const result: MpLaunchResult = {
      ...base,
      client: clients[0],
      ...(clients.length > 1 ? { clients } : {}),
      // 판정하지 않았으면 lobby 를 적지 않는다.
      ...(lastLobby ? { lobby: { reached: true, line: lastLobby.line, elapsedMs: Date.now() - lobbyStartedAt } } : {}),
      nextSteps: lastLobby
        ? slotAssigned
          ? '접속 감지. 서버가 역할을 배정해 클라는 로비 없이 미션에 들어간다. ' +
            '인게임 확인은 arma_status(waitFor:"dedicated"), 배정 기록은 서버 RPT 의 [ArmaMCP] autoSelectRole 줄이다.'
          : '접속 감지. autoInit 이라 미션은 이미 돈다. 로비에서 슬롯을 고르면 인게임이다. ' +
            '서버 브리지 접속 후 arma_exec/arma_status 사용 가능.'
        : '클라를 띄웠다. 서버 브리지가 없는 로비 대기라 접속은 판정하지 않았다. 슬롯 선택과 미션 시작은 수동이고, ' +
          '미션이 시작되면 서버 브리지가 pipe 에 붙어 arma_exec/arma_status 를 쓸 수 있다.',
    };
    return finishServerWait(result);
  }
}

export class BridgeReadinessTracker {
  private currentGeneration: number;
  private helloSeen = false;
  private sessionInfoSeen = false;
  private telemetrySeen = false;
  private sessionDedicated = false;
  private sessionWorld = '';
  private sessionMission = '';
  private disposed = false;

  private readonly onConnected = (): void => {
    this.advanceGeneration();
  };

  private readonly onHello = (): void => {
    if (this.advanceGeneration()) this.helloSeen = true;
  };

  private readonly onSessionInfo = (msg: GatewayFrame): void => {
    if (!this.advanceGeneration()) return;
    this.sessionInfoSeen = true;
    this.sessionDedicated = Boolean(msg.dedicated);
    this.sessionWorld = String(msg.world ?? '');
    this.sessionMission = String(msg.mission ?? '');
  };

  private readonly onTelemetry = (): void => {
    if (!this.advanceGeneration()) return;
    this.telemetrySeen = true;
  };

  constructor(
    private gateway: Gateway,
    private telemetry: TelemetryStore,
    private baselineGeneration: number,
    private launchStartedAt: number,
    private expectedTemplate: string,
  ) {
    this.currentGeneration = baselineGeneration;
    gateway.on('connected', this.onConnected);
    gateway.on('hello', this.onHello);
    gateway.on('sessionInfo', this.onSessionInfo);
    gateway.on('telemetry', this.onTelemetry);
  }

  async wait(timeoutMs: number, signal?: AbortSignal): Promise<BridgeReadiness> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, timeoutMs);
    while (!signal?.aborted) {
      if (this.isReady()) return this.result(true, startedAt);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleepAbortable(Math.min(50, remaining), signal);
    }
    return this.result(false, startedAt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.gateway.off('connected', this.onConnected);
    this.gateway.off('hello', this.onHello);
    this.gateway.off('sessionInfo', this.onSessionInfo);
    this.gateway.off('telemetry', this.onTelemetry);
  }

  private advanceGeneration(): boolean {
    const generation = this.gateway.generation();
    if (generation <= this.baselineGeneration) return false;
    if (generation !== this.currentGeneration) {
      this.currentGeneration = generation;
      this.helloSeen = false;
      this.sessionInfoSeen = false;
      this.telemetrySeen = false;
      this.sessionDedicated = false;
      this.sessionWorld = '';
      this.sessionMission = '';
    }
    return true;
  }

  private isReady(): boolean {
    const snap = this.telemetry.current();
    return (
      this.currentGeneration > this.baselineGeneration &&
      this.helloSeen &&
      this.sessionInfoSeen &&
      this.telemetrySeen &&
      this.sessionDedicated &&
      this.sessionWorld.length > 0 &&
      this.sessionMission.length > 0 &&
      sameWorld(this.sessionWorld, this.expectedWorld()) &&
      snap.dedicated &&
      snap.world.length > 0 &&
      snap.mission.length > 0 &&
      sameWorld(snap.world, this.expectedWorld()) &&
      snap.receivedAt >= this.launchStartedAt
    );
  }

  private result(ready: boolean, startedAt: number): BridgeReadiness {
    const snap = this.telemetry.current();
    return {
      ready,
      baselineGeneration: this.baselineGeneration,
      generation: this.currentGeneration,
      hello: this.helloSeen,
      sessionInfo: this.sessionInfoSeen,
      telemetry: this.telemetrySeen,
      elapsedMs: Date.now() - startedAt,
      expected: {
        template: this.expectedTemplate,
        world: this.expectedWorld(),
      },
      actual: {
        mission: this.sessionMission || snap.mission,
        world: this.sessionWorld || snap.world,
        dedicated: this.sessionInfoSeen ? this.sessionDedicated : snap.dedicated,
      },
      telemetrySnapshot: ready
        ? {
            ...snap,
            date: [...snap.date],
            players: snap.players.map((player) => ({ ...player })),
            aceComponents: [...snap.aceComponents],
          }
        : undefined,
    };
  }

  private expectedWorld(): string {
    const separator = this.expectedTemplate.lastIndexOf('.');
    return separator >= 0 ? this.expectedTemplate.slice(separator + 1) : '';
  }
}

/** 서버 텔레메트리에 보이는 사람 클라 이름. 로비의 클라(clients)와 유닛을 잡은 플레이어를 모두 본다. */
export function serverClientNames(snap: MissionSnapshot): string[] {
  const names = new Set<string>();
  for (const c of snap.clients ?? []) if (!c.isHC && c.name) names.add(c.name);
  for (const p of snap.players) if (p.isPlayer && p.name) names.add(p.name);
  return [...names];
}

/**
 * 서버 텔레메트리에 클라가 나타날 때까지 기다린다. 이름을 알면 그 이름을, 모르면 baseline 에 없던 새 이름을 찾는다.
 * 5초 주기 push 를 기다리지 않고 1초에 한 번 즉시 push 를 요청한다.
 */
export async function waitClientInTelemetry(
  deps: MpLauncherBridgeDeps,
  name: string | null,
  baseline: ReadonlySet<string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitResult & { aborted?: boolean }> {
  const startedAt = Date.now();
  let lastNudge = 0;
  while (!signal.aborted) {
    const names = serverClientNames(deps.telemetry.current());
    const hit = name ? names.find((n) => n === name) : names.find((n) => !baseline.has(n));
    if (hit !== undefined) {
      return { found: true, file: '', line: `telemetry: ${hit} 접속`, elapsedMs: Date.now() - startedAt };
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return { found: false, file: '', elapsedMs: Date.now() - startedAt };
    if (Date.now() - lastNudge > 1000 && deps.gateway.isConnected()) {
      deps.gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
      lastNudge = Date.now();
    }
    await sleepAbortable(Math.min(250, remaining), signal);
  }
  return { found: false, file: '', elapsedMs: Date.now() - startedAt, aborted: true };
}

/** 인자 글에서 -name 값. 따옴표로 감싼 값도 받는다. 없으면 null 이다. */
export function nameFlagIn(argString: string): string | null {
  const m = /(?:^|\s)-name=(?:"([^"]*)"|(\S+))/i.exec(argString);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** 서버 준비를 RPT 줄 대신 브리지로 판정했을 때 readyLine 에 남기는 글. */
export const SERVER_READY_BY_BRIDGE = 'MCP 서버 브리지 준비(서버 RPT 의 준비 줄 없이)';

/**
 * 서버 준비를 서버 RPT 의 준비 줄과 서버 브리지 중 먼저 오는 쪽으로 판정한다.
 *
 * 클라가 둘 이상이면 server.cfg 에 loopback = true 가 들어간다. 그때 엔진은 Steam 서버 초기화를
 * 건너뛰어 SERVER_READY_PATTERN 의 Steam 줄이 RPT 에 나오지 않는다(엔진 분석). "Host identity created"
 * 는 서버 콘솔에만 찍힌다. autoInit 실행은 브리지가 붙으면 미션이 돌고 있으므로 서버도 준비된 것이다.
 * 둘 다 실패하면 RPT 쪽 결과를 돌려준다.
 */
export async function waitServerReady(
  byRpt: (signal: AbortSignal) => Promise<WaitResult & { aborted?: boolean }>,
  bridge: Pick<BridgeReadinessTracker, 'wait'> | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<WaitResult & { aborted?: boolean; via?: 'rpt' | 'bridge' }> {
  const settled = new AbortController();
  const both = combineAbortSignals(signal, settled.signal);
  try {
    const rpt = byRpt(both.signal).then((r) => ({ ...r, via: 'rpt' as const }));
    if (!bridge) return await rpt;
    const viaBridge = bridge.wait(timeoutMs, both.signal).then((b) =>
      b.ready
        ? { found: true, file: '', line: SERVER_READY_BY_BRIDGE, elapsedMs: b.elapsedMs, via: 'bridge' as const }
        : null,
    );
    return await new Promise((resolve) => {
      let rptMiss: (WaitResult & { aborted?: boolean; via: 'rpt' }) | null = null;
      let bridgeDone = false;
      void rpt.then((r) => {
        if (r.found || r.aborted || bridgeDone) resolve(r);
        else rptMiss = r;
      });
      void viaBridge.then((b) => {
        bridgeDone = true;
        if (b) resolve(b);
        else if (rptMiss) resolve(rptMiss);
      });
    });
  } finally {
    settled.abort();
    both.dispose();
  }
}

async function waitForPatternOrAbort(
  rptDir: string,
  opts: Parameters<typeof waitForPattern>[1],
  signal?: AbortSignal,
): Promise<WaitResult & { aborted?: boolean }> {
  return raceWaitWithAbort(waitForPattern(rptDir, { ...opts, signal }), signal);
}

async function raceWaitWithAbort(
  pending: Promise<WaitResult>,
  signal?: AbortSignal,
): Promise<WaitResult & { aborted?: boolean }> {
  if (!signal) return pending;
  if (signal.aborted) return { found: false, file: '', elapsedMs: 0, aborted: true };

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<WaitResult & { aborted: true }>((resolve) => {
    onAbort = () => resolve({ found: false, file: '', elapsedMs: 0, aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function abortMessage(signal?: AbortSignal): string {
  const reason = signal?.reason;
  return reason instanceof Error ? reason.message : 'launch operation aborted';
}

function waitFailure(
  requestSignal: AbortSignal | undefined,
  primary: DetachedProcess,
  primaryLabel: string,
  secondary?: DetachedProcess,
  secondaryLabel?: string,
): Pick<MpLaunchResult, 'error' | 'aborted'> {
  if (requestSignal?.aborted) {
    return { aborted: true, error: abortMessage(requestSignal) };
  }
  if (primary.exitSignal.aborted) {
    return {
      error: `${primaryLabel} 프로세스가 준비 완료 전에 종료됨: ${abortMessage(primary.exitSignal)}`,
    };
  }
  if (secondary?.exitSignal.aborted) {
    return {
      error: `${secondaryLabel ?? '하위'} 프로세스가 준비 완료 전에 종료됨: ${abortMessage(secondary.exitSignal)}`,
    };
  }
  return { error: 'launch operation aborted' };
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

function missionPersistenceWarning(missionPath: string): string | undefined {
  try {
    if (!statSync(missionPath).isDirectory()) {
      return (
        '무인 persistence를 정적으로 확인할 수 없는 packed 미션입니다. ' +
        '플레이어 0명 유지를 위해 description.ext의 respawn이 INSTANT(2) 또는 BASE(3)인지 확인하세요.'
      );
    }
  } catch {
    return '미션 persistence 설정을 확인하지 못했습니다.';
  }

  const description = path.join(missionPath, 'description.ext');
  if (!existsSync(description)) {
    return (
      'description.ext가 없어 플레이어 0명에서 미션이 종료될 수 있습니다. ' +
      '무인 전용 서버에는 respawn=2(INSTANT) 또는 respawn=3(BASE)를 권장합니다.'
    );
  }
  try {
    const text = readFileSync(description, 'utf8');
    const persistentRespawn =
      /\brespawn\s*=\s*(?:2|3)\s*;/i.test(text) ||
      /\brespawn\s*=\s*"(?:INSTANT|BASE)"\s*;/i.test(text);
    if (persistentRespawn) return undefined;
  } catch {
    return 'description.ext를 읽지 못해 플레이어 0명 persistence를 확인하지 못했습니다.';
  }
  return (
    'description.ext에서 INSTANT/BASE respawn을 확인하지 못했습니다. ' +
    '플레이어 0명이 되면 persistent=1이어도 미션이 종료될 수 있습니다.'
  );
}

function joinWarnings(...warnings: Array<string | undefined>): string | undefined {
  const present = warnings.filter((value): value is string => Boolean(value));
  return present.length > 0 ? present.join(' / ') : undefined;
}

function sameWorld(actual: string, expected: string): boolean {
  return expected.length === 0 || actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
