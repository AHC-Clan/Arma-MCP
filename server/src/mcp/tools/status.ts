// status.ts — arma_status 툴 등록.

import { existsSync, type Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { newestRptAsync, SERVER_RPT_RE } from '../../rpt/rptFiles.js';
import { CLIENT_IMAGE, isArmaRunningAsync, findRunningServerImage } from '../../procs.js';
import {
  resolveServerExePath,
  resolveServerImage,
  resolveServerProfilesDir,
  type Config,
} from '../../config.js';
import { ARMA_MCP_VERSION, compareVersions } from '../../version.js';
import { readSelfUpdateCache } from '../../selfupdate/state.js';
import { BROADCAST_POLICY_KO } from '../broadcastPolicy.js';
import { listProfileNames, resolveLaunchProfilesFile } from '../../launch/launchProfiles.js';
import { withAbortSignals } from '../abort.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { tiledWindows } from '../../tiler/tilerService.js';

const DEFAULT_WAIT_MS = 30000;
const MAX_WAIT_MS = 600000;

export type StatusWaitFor = 'none' | 'game' | 'dedicated';

export interface Readiness {
  rawConnected: boolean;
  sessionInfoReceived: boolean;
  telemetryFresh: boolean;
  bridgeReady: boolean;
  dedicatedReady: boolean;
}

/**
 * 자동 업데이트가 설치해 둔 버전이 아직 실행 중 버전보다 높을 때만 안내한다.
 * 적용되고 나면 조건이 저절로 거짓이 되므로 캐시를 지울 필요가 없다.
 */
export function pendingUpdateHint(
  cache: { lastResult?: string; lastAttemptVersion?: string } | null,
  runningVersion: string,
): string {
  if (cache?.lastResult !== 'updated') return '';
  const pending = cache.lastAttemptVersion;
  if (!pending || compareVersions(pending, runningVersion) <= 0) return '';
  return (
    `Arma-MCP ${pending} 을 설치해 뒀습니다 — 이 세션은 ${runningVersion} 으로 동작 중이며 ` +
    '세션을 새로 열면 적용됩니다.'
  );
}

/**
 * arma_play 프로필 이름 목록. 공유 데몬 이벤트 루프를 막지 않게 비동기로 읽는다.
 * 파일이 깨졌으면 목록은 비우고 이유를 profilesError 로 알린다.
 */
export async function statusProfiles(
  cfg: Config,
): Promise<{ profiles: string[]; profilesError?: string }> {
  try {
    return { profiles: await listProfileNames(resolveLaunchProfilesFile(cfg)) };
  } catch (e) {
    return { profiles: [], profilesError: (e as Error).message };
  }
}

export function statusReadiness(deps: Deps): Readiness {
  const rawConnected = deps.gateway.isConnected();
  const snap = deps.telemetry.current();
  const sessionInfoReceived = rawConnected && deps.gateway.sessionInfoReceived();
  const telemetryAgeMs = snap.receivedAt > 0 ? Date.now() - snap.receivedAt : -1;
  const freshnessLimitMs = Math.max(10_000, deps.cfg?.link?.staleAfterMs ?? 15_000);
  const telemetryFresh = telemetryAgeMs >= 0 && telemetryAgeMs < freshnessLimitMs;
  const bridgeReady =
    rawConnected &&
    sessionInfoReceived &&
    telemetryFresh &&
    snap.world.trim().length > 0 &&
    snap.mission.trim().length > 0;
  return {
    rawConnected,
    sessionInfoReceived,
    telemetryFresh,
    bridgeReady,
    dedicatedReady: bridgeReady && snap.dedicated,
  };
}

function readinessSatisfied(readiness: Readiness, waitFor: StatusWaitFor): boolean {
  if (waitFor === 'none') return true;
  if (waitFor === 'game') return readiness.rawConnected;
  return readiness.dedicatedReady;
}

async function waitForReadiness(
  deps: Deps,
  waitFor: StatusWaitFor,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ satisfied: boolean; timedOut: boolean; aborted: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  let lastTelemetryReq = 0;

  for (;;) {
    const readiness = statusReadiness(deps);
    if (readinessSatisfied(readiness, waitFor)) break;
    if (signal.aborted) {
      return {
        satisfied: false,
        timedOut: false,
        aborted: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      return {
        satisfied: false,
        timedOut: true,
        aborted: false,
        elapsedMs: Date.now() - startedAt,
      };
    }
    // 링크는 붙었는데 브리지 텔레메트리만 늦는 상태면 5s 주기 push 를 기다리지 말고
    // 즉시 push 를 요청한다(멱등 — 애드온 onTelemetryReq 가 다음 프레임에 응답).
    if (
      waitFor === 'dedicated' &&
      readiness.rawConnected &&
      !readiness.bridgeReady &&
      Date.now() - lastTelemetryReq > 1000
    ) {
      deps.gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
      lastTelemetryReq = Date.now();
    }
    const aborted = await delay(Math.min(100, remaining), signal);
    if (aborted) {
      return {
        satisfied: false,
        timedOut: false,
        aborted: true,
        elapsedMs: Date.now() - startedAt,
      };
    }
  }

  return {
    satisfied: true,
    timedOut: false,
    aborted: false,
    elapsedMs: Date.now() - startedAt,
  };
}

function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
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

/** 스택 하나의 요약. 모든 스택을 한눈에 보는 arma_status.stacks 의 항목이다. */
export interface StackSummary {
  id: string;
  port: number;
  pipe: string;
  root: string;
  listener: string;
  linkPhase: string;
  dllPid: number | null;
  dllVersion: string | null;
  mission: { world: string; mission: string } | null;
  /** 이 스택의 Arma 프로세스. 목록을 읽지 못했으면 null. */
  processes: { pid: number; image: string; role: 'client' | 'server'; index: number }[] | null;
  operation: ReturnType<Deps['operationCoordinator']['snapshot']>;
  /** 마지막 실행이 붙인 테스트 애드온 PBO 이름. 없으면 빈 목록. */
  testMods: string[];
  /** 원본 PBO 를 빼고 다시 엮은 기본 모드 폴더 이름. */
  overlays: string[];
}

async function dirNames(dir: string, pick: (e: Dirent) => boolean): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(pick)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export async function stackSummaries(deps: Pick<Deps, 'stacks'>): Promise<StackSummary[]> {
  const registry = deps.stacks;
  if (!registry) return [];
  return Promise.all(
    registry.list().map(async (b) => {
      const [procs, testMods, overlays] = await Promise.all([
        b.procs.list().catch(() => null),
        dirNames(path.join(b.ctx.testModDir, 'addons'), (e) => e.isFile() && /\.pbo$/i.test(e.name)),
        dirNames(b.ctx.overlayDir, (e) => e.isDirectory()),
      ]);
      const snap = b.telemetry.current();
      return {
        id: b.ctx.id,
        port: b.ctx.port,
        pipe: b.ctx.pipeName,
        root: b.ctx.root,
        listener: b.gateway.getListenerState(),
        linkPhase: b.gateway.linkPhase(),
        dllPid: b.telemetry.dllPid() || null,
        dllVersion: b.telemetry.dllVersion() || null,
        mission: b.gateway.isConnected() ? { world: snap.world, mission: snap.mission } : null,
        processes: procs
          ? procs.map((p) => ({ pid: p.pid, image: p.image, role: p.role, index: p.index }))
          : null,
        operation: b.operationCoordinator.snapshot(),
        testMods,
        overlays,
      };
    }),
  );
}

export function registerStatusTool(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_status',
    {
      title: 'Arma MCP 상태',
      description:
        'DLL 접속 여부/경로, 현재 미션, 텔레메트리 신선도, pending exec 수, Arma 클라/데디 서버 프로세스 실행 여부, ' +
        '최신 RPT(클라/서버), 데몬/다중 세션/전역 작업 상태를 반환한다. ' +
        "waitFor='game'은 raw DLL 연결, 'dedicated'는 활성 데디 미션 브리지까지 기다린다. " +
        'operation.owner 는 실행 lease 를 쥔 세션이다. profiles 는 arma_play 에 쓸 수 있는 저장된 프로필 이름이다. ' +
        'stack 을 주면 그 스택의 게임 연결과 프로세스를 본다. stacks 는 모든 스택의 포트, 파이프, 프로세스, ' +
        '게임 연결, 실행 lease 요약이다. windowTiler 는 창 4분할이 보는 게임 창과 칸이다.',
      inputSchema: {
        stack: STACK_INPUT,
        waitFor: z
          .enum(['none', 'game', 'dedicated'])
          .optional()
          .describe("준비 상태 대기. 기본 'none'."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe('waitFor 대기 제한(ms, 기본 30000, 최대 600000).'),
      },
    },
    onStack(shared, {}, async (deps, args, extra) => {
      const waitFor = args.waitFor ?? 'none';
      const timeoutMs =
        waitFor === 'none'
          ? 0
          : Math.max(0, Math.min(args.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS));
      // 세션이 닫히거나 이 호출만 취소돼도 대기를 멈춘다.
      const wait = await withAbortSignals(
        [deps.session.abortController.signal, extra?.signal],
        (signal) => waitForReadiness(deps, waitFor, timeoutMs, signal),
      );
      // tasklist 스폰과 RPT 디렉토리 조회는 회당 수백 ms 까지 걸린다 — 전부 병렬로.
      // newestRpt(동기)는 공유 데몬 이벤트 루프를 막으므로 비동기판을 쓴다.
      // 서버 프로세스는 설정된 exe 이름 + 알려진 대체 이미지까지 본다(프로파일링 빌드 등).
      const serverProfilesDir = resolveServerProfilesDir(deps.cfg);
      // 스택 프로세스 함수가 있으면 이 스택의 게임만 센다. 다른 스택의 게임은 stacks 에 나온다.
      const procs = deps.procs;
      const [armaProcessRunning, runningServerImage, rpt, serverRpt, launchProfiles, stacks] =
        await Promise.all([
          procs ? procs.isProcRunningAsync(CLIENT_IMAGE) : isArmaRunningAsync(),
          (procs?.findRunningServerImage ?? findRunningServerImage)(resolveServerImage(deps.cfg)),
          newestRptAsync(deps.rptDir),
          newestRptAsync(serverProfilesDir, SERVER_RPT_RE),
          statusProfiles(deps.cfg),
          stackSummaries(deps),
        ]);
      const serverProcessRunning = runningServerImage !== null;
      const snap = deps.telemetry.current();
      const readiness = statusReadiness(deps);
      const connected = readiness.rawConnected;
      const serverExePath = resolveServerExePath(deps.cfg);
      const ace = deps.telemetry.ace();
      const aceVersion = deps.telemetry.aceVersion();
      const aceComponents = deps.telemetry.aceComponents();
      const tacmap = deps.telemetry.tacmap();
      const tacmapZeusTool = deps.telemetry.tacmapZeusTool();

      // ACE 로드 시 에이전트가 능동적으로 활용하도록 힌트를 준다.
      const hints: string[] = [];
      if (ace) {
        hints.push(
          `ACE${aceVersion ? ' ' + aceVersion : ''} loaded — arma_exec 로 ace_* / CBA 함수를 활용하세요. ` +
            `서브시스템 함수는 aceComponents 로 존재 확인 후 호출(예: ace_medical_treatment 있으면 치료 함수).`,
        );
      }
      // TacMap 로드 시 자막/지도 요청을 원시 SQF 로 재구현하지 않도록 전용 툴로 유도한다.
      // 유도이지 초대가 아니다 — 방송 자체는 사용자가 요청했을 때만 한다.
      if (tacmap === true) {
        // 상세 카탈로그·호출 규칙은 서버 instructions 와 docs/tacmap.md 가 이미 전달한다 —
        // 매 status 응답에는 라우팅 요지만 싣는다.
        hints.push(
          'AHC_TacticalMap loaded — ' +
            BROADCAST_POLICY_KO +
            ' 자막/마커/지도 열기는 arma_tacmap_* 전용 툴로, 그 외 기능은 ' +
            'AHC_TacticalMap_fnc_cheat<Name> 카탈로그(docs/tacmap.md)를 따르세요.' +
            (tacmapZeusTool === false
              ? ' AHC_ZeusTool 미설치 — 자막은 정상 표시되고 무전 사운드만 빠집니다.'
              : ''),
        );
      }
      // 배포된 애드온이 데몬보다 뒤처지면 연결은 되지만 새 브리지 기능이 빠질 수 있다.
      // 다만 patch 차이만으로 재배포를 권하지는 않는다 — exec 경로(프레임 형식·spawn 격리·
      // pushResult)는 major.minor 안에서 호환되므로, 라이브 서버를 멈출 이유가 되지 못한다.
      const dllVersion = deps.telemetry.dllVersion();
      const dllRelease = dllVersion.replace(/^ArmaMCP\s+/i, '').trim();
      const minorOf = (v: string): string => v.split('.').slice(0, 2).join('.');
      const bridgeCompatible = !dllRelease || minorOf(dllRelease) === minorOf(ARMA_MCP_VERSION);
      if (dllRelease && dllRelease !== ARMA_MCP_VERSION && !bridgeCompatible) {
        hints.push(
          `배포된 @arma_mcp DLL ${dllRelease} 이 데몬 ${ARMA_MCP_VERSION} 과 major.minor 가 다릅니다 — ` +
            '모드 폴더의 DLL/PBO 를 최신 빌드로 갱신하세요.',
        );
      }
      // 자동 업데이트가 받아둔 새 버전이 아직 이 프로세스에 적용되지 않았을 때만 알린다.
      // 훅이 없는 호스트에서는 이것이 유일한 가시 채널이다.
      const updateHint = pendingUpdateHint(readSelfUpdateCache(), ARMA_MCP_VERSION);
      if (updateHint) hints.push(updateHint);

      return jsonContent({
        // 아래 게임 쪽 필드가 가리키는 스택. 모든 스택의 요약은 stacks 에 있다.
        stack: deps.stack?.id ?? 'default',
        stacks,
        // 창 4분할이 보는 데몬 게임 창과 칸(0 왼쪽 위부터). 타일러가 꺼져 있으면 null 이다.
        windowTiler: tiledWindows(),
        daemonVersion: ARMA_MCP_VERSION,
        daemonUptimeMs: Date.now() - deps.serverStartMs,
        daemon: {
          version: ARMA_MCP_VERSION,
          uptimeMs: Date.now() - deps.serverStartMs,
        },
        sessions: deps.sessions.snapshot(),
        // 설정으로 꺼둔 툴 — 없는 툴을 서버 고장으로 오해하지 않게 알려준다.
        disabledTools: deps.cfg.mcp.disableTools,
        operation: deps.operationCoordinator.snapshot(),
        // arma_play profile 로 부를 수 있는 이름.
        profiles: launchProfiles.profiles,
        ...(launchProfiles.profilesError ? { profilesError: launchProfiles.profilesError } : {}),
        wait: {
          requested: waitFor,
          timeoutMs,
          ...wait,
        },
        rawConnected: readiness.rawConnected,
        bridgeReady: readiness.bridgeReady,
        dedicatedReady: readiness.dedicatedReady,
        telemetryFresh: readiness.telemetryFresh,
        gameConnectionGeneration: deps.gateway.generation(),
        gameGeneration: deps.gateway.generation(),
        // 'pre-bridge' 는 DLL 은 붙었는데 미션이 없어 SQF 브리지가 없는 상태 —
        // 연결 실패가 아니라 로비다. SQF 툴은 미션이 뜰 때까지 쓸 수 없다.
        linkPhase: deps.gateway.linkPhase(),
        dllConnected: connected,
        sessionInfoReceived: readiness.sessionInfoReceived,
        connectedVia: deps.gateway.connectedVia() || null,
        connectedForMs: deps.gateway.connectedForMs(),
        lastFrameAgeMs: deps.gateway.lastFrameAgeMs(),
        dllVersion: deps.telemetry.dllVersion() || null,
        // 지금 붙은 게임 프로세스. 0.5 이전 DLL 은 보내지 않아 null 이다.
        dllPid: deps.telemetry.dllPid?.() || null,
        // major.minor 가 같으면 exec 경로(프레임·spawn 격리·pushResult)가 호환된다 —
        // patch 차이만으로 라이브 서버의 DLL/PBO 를 재배포할 이유는 없다.
        bridgeCompatible,
        cba: deps.telemetry.cba(),
        ace,
        aceVersion: aceVersion || null,
        aceComponents,
        tacmap,
        tacmapZeusTool,
        hints,
        mission: connected ? { world: snap.world, mission: snap.mission } : null,
        // 최근 텔레메트리의 게임 시간과 창 상태. SP 는 paused 면 missionTime 이 멈추고
        // sleep 과 waitUntil 도 멈춘다. 브리지 링크는 그대로 산다.
        game:
          connected && snap.receivedAt > 0
            ? {
                missionTime: snap.missionTime,
                fps: snap.fps,
                fpsMin: snap.fpsMin,
                paused: snap.paused,
                focused: snap.focused,
              }
            : null,
        telemetryAgeMs: deps.telemetry.cacheAgeMs(),
        pendingExecs: deps.exec.pendingCount(),
        armaProcessRunning,
        serverProcessRunning,
        // 실제로 실행 중인 데디 서버 이미지명. 설정 exe 와 다르면(프로파일링 빌드 등)
        // 여기에 실물 이름이 나온다 — launch 가드·kill 대상이 이 이름이다.
        serverProcessImage: runningServerImage,
        newestRpt: rpt
          ? { name: rpt.name, sizeBytes: rpt.sizeBytes, mtimeMs: rpt.mtimeMs }
          : null,
        newestServerRpt: serverRpt
          ? { name: serverRpt.name, sizeBytes: serverRpt.sizeBytes, mtimeMs: serverRpt.mtimeMs }
          : null,
        listener: deps.gateway.getListenerState(),
        web: deps.web.statusInfo(),
        serverUptimeMs: Date.now() - deps.serverStartMs,
        config: {
          pipeName: deps.cfg.pipeName,
          tcp: deps.cfg.tcp,
          exePath: deps.cfg.arma.exePath,
          exeExists: deps.cfg.arma.exePath ? existsSync(deps.cfg.arma.exePath) : false,
          exeSource:
            deps.armaPathSource ?? (deps.cfg.arma.exePath ? 'config' : 'none'),
          serverExePath,
          serverExeExists: serverExePath ? existsSync(serverExePath) : false,
          selfModPath: deps.cfg.arma.selfModPath,
          selfModSource:
            deps.selfModSource ?? (deps.cfg.arma.selfModPath ? 'config' : 'none'),
          rptDir: deps.rptDir,
          mp: { port: deps.cfg.mp.port, profilesDir: serverProfilesDir },
        },
      });
    }),
  );
}
