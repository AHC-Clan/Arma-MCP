import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, type Config } from './config.js';
import { configureLogger, redirectConsoleToStderr, log } from './log.js';
import { stateDir } from './daemon/autostart.js';
import { runDoctor } from './daemon/doctor.js';
import { startSharedRuntime } from './runtime.js';
import { buildMcpServer } from './mcp/server.js';
import { withSession } from './mcp/deps.js';
import { createSessionContext } from './mcp/session.js';
import { McpHttpDaemon } from './daemon/httpDaemon.js';
import { ensureMcpToken } from './daemon/token.js';
import { runRelay } from './relay.js';
import { runSelfUpdateCli } from './selfupdate/cli.js';
import { runCli, watchProcessSignals } from './cli/main.js';
import type { LogLevel } from './log.js';

type RunMode = 'daemon' | 'relay' | 'standalone' | 'doctor' | 'selfupdate' | 'cli';

const RUN_MODES: RunMode[] = ['daemon', 'relay', 'standalone', 'doctor', 'selfupdate', 'cli'];

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** 런타임을 열지 않는 모드의 로그 수준. 기본은 warn 이고 ARMA_MCP_LOG_LEVEL 로 바꾼다. */
function quietLogLevel(): LogLevel {
  const level = process.env.ARMA_MCP_LOG_LEVEL as LogLevel | undefined;
  return level && LOG_LEVELS.includes(level) ? level : 'warn';
}

function parseMode(argv: string[]): RunMode {
  const raw = argv[0] ?? process.env.ARMA_MCP_MODE ?? 'standalone';
  const normalized = raw.startsWith('--mode=') ? raw.slice('--mode='.length) : raw;
  if ((RUN_MODES as string[]).includes(normalized)) return normalized as RunMode;
  throw new Error(
    `unknown Arma-MCP mode "${raw}"; expected ${RUN_MODES.join(', ')}`,
  );
}

/**
 * relay 는 호스트가 stderr 를 어디에 담는지 알 수 없다. 실패 사유가 화면에서 사라져도
 * 사후에 찾을 수 있도록 daemon 로그와 같은 폴더에 relay.log 를 남긴다.
 */
function resolveLogFile(cfg: Config, mode: RunMode): string {
  if (cfg.logFile) return cfg.logFile;
  if (mode !== 'relay') return '';
  try {
    return path.join(stateDir(cfg), 'relay.log');
  } catch {
    return '';
  }
}

async function runStandalone(cfg: Config): Promise<void> {
  const runtime = await startSharedRuntime(cfg, { requireGatewayOwnership: true });
  const session = createSessionContext('standalone');
  runtime.sessions.add(session);
  const mcp = buildMcpServer(withSession(runtime.deps, session));
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!session.abortController.signal.aborted) {
      session.abortController.abort(new Error('standalone MCP session closed'));
    }
    runtime.sessions.remove(session.id);
    try {
      await mcp.close();
    } catch {
      /* ignore */
    }
    await runtime.stop();
    resolveClosed();
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
  await mcp.connect(transport);
  transport.onclose = () => void shutdown();
  log.info('arma-mcp: standalone MCP stdio connected');
  await closed;
}

/**
 * daemon 종료 정리의 상한(ms). HTTP 정리는 STOP_GRACE_MS 안에 끝나므로 보통은 닿지 않는다.
 * 넘으면 프로세스를 바로 끝낸다. 게임 파이프를 쥔 채 남으면 다음 daemon 이 뜨지 못한다.
 */
const DAEMON_SHUTDOWN_WATCHDOG_MS = 10_000;
/**
 * 정리를 마친 뒤 프로세스가 스스로 끝나기를 기다리는 시간(ms).
 * 정리 뒤에도 exec 타임아웃 같은 타이머가 이벤트 루프를 붙잡을 수 있어 이 시간이 지나면 끝낸다.
 */
const DAEMON_EXIT_GRACE_MS = 1_000;

async function runDaemon(cfg: Config): Promise<void> {
  const token = ensureMcpToken(cfg);
  const runtime = await startSharedRuntime(cfg, { requireGatewayOwnership: true });
  let daemon: McpHttpDaemon;
  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('arma-mcp: daemon shutting down');
    const watchdog = setTimeout(() => {
      log.error(
        `arma-mcp: daemon shutdown did not finish within ${DAEMON_SHUTDOWN_WATCHDOG_MS}ms; exiting now`,
      );
      process.exit(1);
    }, DAEMON_SHUTDOWN_WATCHDOG_MS);
    watchdog.unref();
    try {
      await daemon.stop();
    } catch (error) {
      log.error('arma-mcp: MCP endpoint shutdown failed: ' + String(error));
    }
    try {
      await runtime.stop();
    } catch (error) {
      log.error('arma-mcp: runtime shutdown failed: ' + String(error));
    } finally {
      clearTimeout(watchdog);
      resolveClosed();
    }
  };

  daemon = new McpHttpDaemon({
    cfg,
    shared: runtime.deps,
    sessions: runtime.sessions,
    token,
    onShutdownRequested: shutdown,
  });
  try {
    await daemon.start();
  } catch (error) {
    await runtime.stop();
    throw error;
  }
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await closed;
  log.info('arma-mcp: daemon stopped');
  setTimeout(() => process.exit(process.exitCode ?? 0), DAEMON_EXIT_GRACE_MS).unref();
}

async function main(): Promise<void> {
  // MCP stdio mode owns stdout. All diagnostics remain on stderr in every mode.
  redirectConsoleToStderr();
  const mode = parseMode(process.argv.slice(2));

  // self-update 는 서버 설정과 무관하고, 설정 파일이 없는 플러그인 캐시에서도 돌아야 한다.
  // loadConfig() 를 건너뛰어 세션 시작 임계 경로에 zod 파싱과 stderr 한 줄을 더하지 않는다.
  if (mode === 'selfupdate') {
    configureLogger({ level: quietLogLevel(), file: '' });
    await runSelfUpdateCli(process.argv.slice(3));
    return;
  }

  // cli 는 이미 떠 있는 데몬에 붙는 짧은 클라이언트다. 런타임과 게이트웨이를 열지 않고,
  // 로그 파일도 쓰지 않는다. 설정은 명령이 필요할 때 조용히 읽는다.
  if (mode === 'cli') {
    configureLogger({ level: quietLogLevel(), file: '' });
    const signals = watchProcessSignals();
    try {
      process.exitCode = await runCli(process.argv.slice(3), { interrupt: signals.signal });
    } finally {
      signals.dispose();
    }
    return;
  }

  const cfg = loadConfig();
  configureLogger({ level: cfg.logLevel, file: resolveLogFile(cfg, mode) });
  process.on('uncaughtException', (error) =>
    log.error('uncaughtException', error?.stack ?? String(error)),
  );
  process.on('unhandledRejection', (error) =>
    log.error('unhandledRejection', String(error)),
  );

  if (mode === 'relay') {
    await runRelay(cfg);
  } else if (mode === 'daemon') {
    await runDaemon(cfg);
  } else if (mode === 'doctor') {
    await runDoctor(cfg);
  } else {
    await runStandalone(cfg);
  }
}

main().catch((error) => {
  log.error('fatal', error?.stack ?? String(error));
  process.exitCode = 1;
});
