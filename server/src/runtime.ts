import path from 'node:path';
import {
  resolveStacksRoot,
  resolveStateDir,
  resolveWebRoot,
  type Config,
} from './config.js';
import type { SharedDeps } from './mcp/deps.js';
import { WebServer } from './web/webServer.js';
import { SessionRegistry } from './daemon/sessionRegistry.js';
import { detectArmaPaths } from './game/steamPaths.js';
import { resolveSelfModSource } from './game/bridgeMod.js';
import { defaultStackContext } from './stack/stackContext.js';
import { createStackBundle } from './stack/stackRuntime.js';
import { StackRegistry } from './stack/stackRegistry.js';
import { WindowTilerService } from './tiler/tilerService.js';
import { log } from './log.js';

export { deriveExpectedMachines } from './stack/stackRuntime.js';

/**
 * 설정이 없는 컴퓨터에서 Steam 설치 경로를 채운다. 사용자가 적어 둔 값이 항상 우선이고,
 * 탐지 결과는 이 프로세스 메모리에만 반영한다.
 */
async function resolveArmaPathSource(cfg: Config): Promise<'config' | 'steam-auto' | 'none'> {
  if (cfg.arma.exePath) return 'config';
  const detected = await detectArmaPaths();
  if (!detected) return 'none';
  cfg.arma.exePath = detected.exePath;
  if (!cfg.arma.serverExePath && detected.serverExePath) {
    cfg.arma.serverExePath = detected.serverExePath;
  }
  log.info('[config] Arma 경로 자동 탐지: ' + detected.exePath);
  return 'steam-auto';
}

export interface RuntimeOptions {
  requireGatewayOwnership?: boolean;
  sessions?: SessionRegistry;
}

export interface SharedRuntime {
  deps: SharedDeps;
  sessions: SessionRegistry;
  stop(): Promise<void>;
}

/**
 * Create the one process-wide Arma runtime. No MCP transport owns this object;
 * daemon sessions come and go while the game bridges remain connected.
 *
 * The default stack keeps the 0.4 pipe, ports, and paths. Named test stacks get
 * their own pipe each; stacks saved by an earlier daemon are reopened after the
 * default pipe is owned, so a duplicate daemon still fails on the default pipe first.
 */
export async function startSharedRuntime(
  cfg: Config,
  options: RuntimeOptions = {},
): Promise<SharedRuntime> {
  const serverStartMs = Date.now();
  const sessions = options.sessions ?? new SessionRegistry();
  // 스택 설정 사본은 경로 탐지가 cfg 를 채운 뒤에 만든다.
  const armaPathSource = await resolveArmaPathSource(cfg);
  const selfModSource = resolveSelfModSource(cfg);

  // default 번들은 목록보다 먼저 만들어지므로 다른 스택 상태는 나중에 묶는다.
  let stacks: StackRegistry | undefined;
  const main = createStackBundle(cfg, defaultStackContext(cfg), {
    othersActive: () => stacks?.othersActive('default') ?? false,
  });
  stacks = new StackRegistry(cfg, main);

  const web = new WebServer(cfg.web, resolveWebRoot(cfg));
  try {
    await main.start({
      requireOwnership: options.requireGatewayOwnership !== false,
    });
    web.start();
  } catch (error) {
    await main.stop();
    throw error;
  }
  await stacks.loadPersisted();

  // 게임 창 4분할과 포커스 가드는 게임 파이프를 가진 이 프로세스 하나만 돌린다.
  const tiler =
    (cfg.windowTiler.enabled || cfg.windowTiler.focusGuard) && process.platform === 'win32'
      ? new WindowTilerService({
          stacksRoot: resolveStacksRoot(cfg),
          stacks: cfg.windowTiler.stacks,
          tile: cfg.windowTiler.enabled,
          aspect: { width: cfg.stacks.windowWidth, height: cfg.stacks.windowHeight },
          focusGuard: cfg.windowTiler.focusGuard,
          stateFile: path.join(resolveStateDir(cfg), 'window-tiler.json'),
        })
      : null;
  tiler?.start();

  const deps: SharedDeps = {
    cfg,
    armaPathSource,
    selfModSource,
    rptDir: main.rptDir,
    rptSources: main.rptSources,
    gateway: main.gateway,
    telemetry: main.telemetry,
    exec: main.exec,
    launcher: main.launcher,
    mpLauncher: main.mpLauncher,
    playOrchestrator: main.playOrchestrator,
    missionMarker: main.missionMarker,
    web,
    serverStartMs,
    sessions,
    operationCoordinator: main.operationCoordinator,
    procs: main.procs,
    stack: main.ctx,
    stacks,
  };

  let stopped = false;
  return {
    deps,
    sessions,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const session of sessions.values()) {
        if (!session.abortController.signal.aborted) {
          session.abortController.abort(new Error('Arma-MCP runtime stopped'));
        }
        sessions.remove(session.id);
      }
      await tiler?.stop();
      await stacks.stopAll();
      await main.stop();
      await web.stop();
    },
  };
}
