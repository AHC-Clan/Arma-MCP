// stackRuntime.ts — 스택 하나의 게임 쪽 서비스 묶음.
//
// 게임 파이프, 텔레메트리, exec, RPT 위치, 실행기, 실행 lease 가 스택마다 하나씩이다.
// 스택끼리는 아무것도 공유하지 않으므로 한 스택의 재접속이나 실행이 다른 스택을 건드리지 않는다.

import type { Config } from '../config.js';
import { resolveRptDir, resolveStacksRoot } from '../config.js';
import type { LaunchStackOptions } from '../launch/stackArgs.js';
import { stackBridgeProblem } from './bridgeGate.js';
import { Gateway } from '../ipc/gateway.js';
import { TelemetryStore } from '../game/telemetry.js';
import { ExecManager } from '../exec/execManager.js';
import { Launcher } from '../launch/launcher.js';
import { MpLauncher } from '../launch/mpLauncher.js';
import { PlayOrchestrator } from '../launch/playOrchestrator.js';
import { OperationCoordinator } from '../launch/operationCoordinator.js';
import { newestRpt } from '../rpt/rptFiles.js';
import { RptSourceResolver } from '../rpt/rptSource.js';
import type { RptCursor } from '../rpt/rptReader.js';
import type { MissionMarker } from '../mcp/deps.js';
import { stackCfg, type StackContext } from './stackContext.js';
import { createScopedProcs, type ScopedProcs } from './processScope.js';

/**
 * 텔레메트리 스냅샷으로 all 모드 exec 의 기대 응답 머신 수를 유도한다. 서버는 항상
 * 1대, 플레이어는 playerCount, HC 는 hcCount. 리슨 호스트는 본인이 playerCount 에
 * 포함되므로 비-dedicated 는 max(1, ...) 로 수렴(SP=1). 캐시가 없거나 10s 이상
 * 묵으면 null — 호출측 quiet-window 폴백에 맡긴다.
 */
export function deriveExpectedMachines(
  snap: { dedicated: boolean; playerCount: number; hcCount: number },
  ageMs: number,
): number | null {
  if (ageMs < 0 || ageMs >= 10000) return null;
  const n = snap.playerCount + snap.hcCount;
  return snap.dedicated ? 1 + n : Math.max(1, n);
}

export interface StackBundle {
  ctx: StackContext;
  /** 이 스택의 설정 사본(default 는 원본). */
  cfg: Config;
  /** 이 스택의 기본 클라 RPT 폴더(클라 1). */
  rptDir: string;
  rptSources: RptSourceResolver;
  gateway: Gateway;
  telemetry: TelemetryStore;
  exec: ExecManager;
  launcher: Launcher;
  mpLauncher: MpLauncher;
  playOrchestrator: PlayOrchestrator;
  missionMarker: MissionMarker;
  operationCoordinator: OperationCoordinator;
  /** 이 스택의 Arma 프로세스만 보는 조회와 종료. */
  procs: ScopedProcs;
  /** 게임 파이프를 연다. requireOwnership 이면 이미 쓰이는 파이프에서 실패한다. */
  start(options?: { requireOwnership?: boolean }): Promise<void>;
  stop(): Promise<void>;
}

export interface StackBundleOptions {
  /** 다른 스택이 게임을 돌리는 중인지. 프로세스 조회가 실패했을 때 쓴다. */
  othersActive?: () => boolean;
  /** 테스트에서 프로세스 함수를 바꿔 끼운다. */
  procs?: ScopedProcs;
}

export function createStackBundle(
  baseCfg: Config,
  ctx: StackContext,
  options: StackBundleOptions = {},
): StackBundle {
  const cfg = stackCfg(baseCfg, ctx);
  const clientRptDir = ctx.clientRptDir(1);
  const procs =
    options.procs ??
    createScopedProcs({
      cfg,
      stackId: ctx.id,
      stacksRoot: resolveStacksRoot(baseCfg),
      othersActive: options.othersActive,
    });

  const gateway = new Gateway(cfg);
  const telemetry = new TelemetryStore();
  telemetry.bind(gateway);

  const rptSources = new RptSourceResolver(cfg, clientRptDir, telemetry, (i) => ctx.clientRptDir(i));

  // all 모드 exec 의 기대 응답 머신 수 유도. 값이 잡히면 quiet-window(기본 800ms)를
  // 기다리지 않고 expectN 도달 즉시 완료된다. 과대 유도는 quiet 폴백이 흡수하지만
  // 과소 유도는 결과를 누락시키므로, stale 텔레메트리면 즉시 push 를 요청해 신선값으로
  // 유도한다.
  const expectedMachines = async (): Promise<number | null> => {
    const age0 = telemetry.cacheAgeMs();
    if ((age0 < 0 || age0 > 2500) && gateway.isConnected()) {
      gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
      await telemetry.waitForTelemetry(400);
    }
    return deriveExpectedMachines(telemetry.current(), telemetry.cacheAgeMs());
  };
  const exec = new ExecManager(gateway, clientRptDir, cfg.exec, expectedMachines);
  const launchStack: LaunchStackOptions = {
    ctx,
    // 이름 있는 스택도 모드셋은 사람이 마지막으로 띄운 default 클라 RPT 헤더에서 읽는다.
    modsetRptDir: resolveRptDir(baseCfg),
    stacksRoot: resolveStacksRoot(baseCfg),
    bridgeGate: () => stackBridgeProblem(baseCfg.arma.selfModPath),
  };
  const launcher = new Launcher(cfg, clientRptDir, procs, launchStack);
  const mpLauncher = new MpLauncher(cfg, clientRptDir, { gateway, telemetry }, procs, launchStack);
  const playOrchestrator = new PlayOrchestrator(
    cfg,
    clientRptDir,
    launcher,
    mpLauncher,
    gateway,
    telemetry,
    ctx,
    exec,
  );
  const operationCoordinator = new OperationCoordinator();

  let missionCursor: RptCursor | null = null;
  gateway.on('connected', () => {
    missionCursor = null;
    // 접속 즉시 sessionInfo+telemetry push 를 요청 — bridgeReady 인지를 5s 주기
    // 텔레메트리에 묶지 않고 프레임 단위로 당긴다(애드온 onTelemetryReq 가 응답).
    gateway.send({ v: 1, type: 'telemetryRequest', reqId: '' });
  });
  gateway.on('sessionInfo', () => {
    const source = rptSources.resolve('auto');
    const newest = newestRpt(source.dir, source.re);
    missionCursor = newest ? { file: newest.path, offset: newest.sizeBytes } : null;
  });
  const missionMarker: MissionMarker = { cursor: () => missionCursor };

  return {
    ctx,
    cfg,
    rptDir: clientRptDir,
    rptSources,
    gateway,
    telemetry,
    exec,
    launcher,
    mpLauncher,
    playOrchestrator,
    missionMarker,
    operationCoordinator,
    procs,
    async start(options = {}) {
      await gateway.start({ requireOwnership: options.requireOwnership !== false });
    },
    async stop() {
      await gateway.stop();
    },
  };
}
