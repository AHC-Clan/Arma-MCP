import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  ErrorCode,
  isInitializeRequest,
  isJSONRPCRequest,
  type JSONRPCMessage,
  type JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { resolveMcpEndpoint } from './config.js';
import {
  autostartSuppressed,
  DaemonSetupError,
  ensureDaemon,
  isPortOpen,
  type DaemonHandle,
  type EnsureDaemonOptions,
} from './daemon/autostart.js';
import {
  MCP_CLIENT_VERSION_HEADER,
  MCP_TRANSPORT_HEADER,
  MCP_VERSION_HEADER,
} from './daemon/httpDaemon.js';
import {
  createRelayFetch,
  daemonErrorText,
  describeError,
  failedAfterSocketReset,
} from './daemon/relayFetch.js';
import { ARMA_MCP_VERSION } from './version.js';
import { triggerSelfUpdateFromRelay } from './selfupdate/cli.js';
import { log } from './log.js';

/** 데몬이 사라진 뒤 다시 띄우는 시도 사이의 최소 간격(ms). */
const REVIVE_INTERVAL_MS = 15_000;
/**
 * 데몬을 다시 띄우기 전에 MCP 포트가 스스로 다시 열리기를 기다리는 상한(ms).
 * 다른 relay 가 업그레이드하느라 데몬을 내렸다 올리는 중일 수 있다. 그 사이에 이 relay 가
 * 자기 버전의 데몬을 띄우면 두 데몬이 파이프와 포트를 두고 경쟁한다.
 */
const REVIVE_SETTLE_MS = 5_000;
const REVIVE_SETTLE_POLL_MS = 250;

export interface RelayOptions {
  /** 테스트용. 기본값은 process.stdin 과 process.stdout. */
  stdin?: Readable;
  stdout?: Writable;
  ensureDaemon?: (options: EnsureDaemonOptions) => Promise<DaemonHandle>;
  autostartSuppressed?: () => boolean;
  selfUpdate?: () => void;
  now?: () => number;
  reviveSettleMs?: number;
}

/** errno 식 code 를 cause 체인에서 찾는다. 없으면 null. */
function errnoCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 새 연결이 거절돼 요청이 데몬에 닿지 못했다. 아무도 MCP 포트를 듣고 있지 않다는 뜻이다.
 * keep-alive 소켓이 끊긴 뒤 새 연결 재시도가 거절된 것은 해당하지 않는다. 데몬이 첫 시도를 받아
 * 실행하다 죽었을 수 있다.
 */
function isConnectionRefused(error: unknown): boolean {
  return errnoCode(error) === 'ECONNREFUSED' && !failedAfterSocketReset(error);
}

/** 데몬이 세션을 모른다(404). 요청은 세션에 닿기 전에 거절됐다. */
function isUnknownSession(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

/** 요청이 데몬에서 실행되지 않았다고 확실한 실패. 세션을 다시 세워 재전송해도 안전하다. */
function isSafeToResend(error: unknown): boolean {
  return isConnectionRefused(error) || isUnknownSession(error);
}

function daemonVersionError(actual: string | null): Error {
  const detail = actual ? `daemon ${actual}` : 'an incompatible pre-0.3 daemon';
  return new Error(
    `Arma-MCP relay ${ARMA_MCP_VERSION} reached ${detail}; ` +
      'restart the daemon explicitly before reconnecting',
  );
}

/** A reply without the daemon version header is not proof of an old daemon. */
function daemonUnidentifiedError(status: number, endpoint: URL): Error {
  return new Error(
    `Arma-MCP relay ${ARMA_MCP_VERSION} got HTTP ${status} from ${endpoint.href} ` +
      'without an Arma-MCP daemon header; another service may own the port, ' +
      'or the bearer token does not match the running daemon',
  );
}

/** Startup failed before any daemon session could exist. */
function relayStartupError(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  // The setup layer already named the cause and the fix; generic advice would contradict it.
  if (error instanceof DaemonSetupError) {
    return new Error(`Arma-MCP relay ${ARMA_MCP_VERSION} cannot connect: ${detail}`);
  }
  return new Error(
    `Arma-MCP relay ${ARMA_MCP_VERSION} could not start: ${detail}. ` +
      'Start the Arma-MCP daemon on the game computer, or set ARMA_MCP_TOKEN ' +
      'when connecting through an SSH tunnel.',
  );
}

/** 세션 중 사라진 데몬을 다시 띄우지 못했다. */
function daemonRestartError(error: unknown, endpoint: URL): Error {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof DaemonSetupError) {
    return new Error(`Arma-MCP relay ${ARMA_MCP_VERSION} cannot connect: ${detail}`);
  }
  return new Error(
    `Arma-MCP relay ${ARMA_MCP_VERSION} could not restart the daemon at ${endpoint.href}: ${detail}`,
  );
}

function daemonRequestError(error: unknown, endpoint: URL): Error {
  if (error instanceof Error && error.message.startsWith('Arma-MCP relay ')) {
    return error;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `Arma-MCP daemon request failed at ${endpoint.href}: ${detail}. ` +
      'Start the daemon on the server computer and verify the token/config or SSH tunnel.',
  );
}

/**
 * 데몬에 닿았을 수 있는 요청이 끝을 못 봤다. 툴이 실행됐는지 알 수 없으므로 relay 는 재전송하지 않는다.
 * 데몬이 멈추면서 503 으로 답했으면 그 문구를 그대로 쓴다. 연결 오류 문구를 그대로 넘기면 에이전트가
 * 실행되지 않았다고 읽고 같은 툴을 다시 부른다.
 */
function unfinishedRequestError(error: unknown, endpoint: URL, suppressed: boolean): Error {
  const next = suppressed
    ? 'The next call reconnects once the daemon on the server computer is running again.'
    : 'The next call reconnects and starts the daemon again if it is not running.';
  if (error instanceof StreamableHTTPError && error.code === 503) {
    const text = daemonErrorText(error) ?? 'Arma-MCP daemon is stopping';
    return new Error(`${text}. ${next}`);
  }
  if (!(error instanceof StreamableHTTPError) && errnoCode(error) !== null) {
    return new Error(
      `Arma-MCP daemon connection at ${endpoint.href} was lost while this request was running; ` +
        `the tool may or may not have run. ${next}`,
    );
  }
  return daemonRequestError(error, endpoint);
}

function rpcFailure(request: JSONRPCMessage, error: unknown): JSONRPCMessage | null {
  if (!isJSONRPCRequest(request)) return null;
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

/**
 * 데몬 세션이 서기 전에 온 요청에 relay 가 직접 하는 답.
 * 데몬은 세션 없는 요청을 400 으로 거절하고, 그 실패를 넘기면 relay 가 닫혀 뒤이을 initialize 를 못 받는다.
 * 2026-07-28 프로토콜을 아는 MCP 클라이언트는 initialize 전에 server/discover 로 떠본다.
 * 옛 서버처럼 모르는 메서드라고 답하면 같은 연결에서 initialize 로 넘어간다.
 */
function answerBeforeSession(message: JSONRPCRequest): JSONRPCMessage {
  if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} };
  return {
    jsonrpc: '2.0',
    id: message.id,
    error: { code: ErrorCode.MethodNotFound, message: `Method not found: ${message.method}` },
  };
}

/** 릴레이/데몬 버전 불일치는 재연결이 고칠 수 없다 — 자동 업데이트가 처리할 영역이다. */
function isFatalDaemonError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Arma-MCP relay ');
}

function createDownstream(
  endpoint: URL,
  token: string,
  transportFetch: typeof fetch,
): StreamableHTTPClientTransport {
  const versionCheckedFetch: typeof fetch = async (input, init) => {
    const response = await transportFetch(input, init);
    const daemonVersion = response.headers.get(MCP_VERSION_HEADER);
    if (daemonVersion !== ARMA_MCP_VERSION) {
      await response.body?.cancel().catch(() => undefined);
      if (daemonVersion === null && !response.ok) {
        throw daemonUnidentifiedError(response.status, endpoint);
      }
      throw daemonVersionError(daemonVersion);
    }
    return response;
  };
  return new StreamableHTTPClientTransport(endpoint, {
    fetch: versionCheckedFetch,
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        [MCP_CLIENT_VERSION_HEADER]: ARMA_MCP_VERSION,
        [MCP_TRANSPORT_HEADER]: 'relay',
      },
    },
  });
}

/**
 * No downstream session can exist, so serve stdio only long enough to answer
 * the first request with the reason. Without this the relay would exit before
 * the transport opened and the MCP client would see a bare connection close.
 */
async function reportStartupFailure(
  reason: Error,
  stdin: Readable,
  stdout: Writable,
): Promise<void> {
  log.error('[relay] ' + reason.message);
  const stdio = new StdioServerTransport(stdin, stdout);
  let finished = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const finish = async (): Promise<void> => {
    if (finished) return;
    finished = true;
    try {
      await stdio.close();
    } catch {
      /* ignore */
    }
    resolveClosed();
  };
  const onStdinEnd = (): void => {
    void finish();
  };
  stdin.once('end', onStdinEnd);
  stdin.once('close', onStdinEnd);

  stdio.onmessage = (message) => {
    const failure = rpcFailure(message, reason);
    if (!failure) return;
    void stdio
      .send(failure)
      .catch(() => undefined)
      .then(() => finish());
  };
  stdio.onerror = (error) => {
    log.error('[relay] stdio transport error: ' + error.message);
  };
  stdio.onclose = () => {
    void finish();
  };

  await stdio.start();
  await closed;
  stdin.off('end', onStdinEnd);
  stdin.off('close', onStdinEnd);
  process.exitCode = 1;
}

/**
 * Transparent JSON-RPC bridge from a host-managed stdio process to exactly one
 * downstream daemon session. It never opens a game gateway itself; ensureDaemon
 * is what may start or upgrade the one shared daemon, at startup and again when
 * the daemon disappears mid-session.
 */
export async function runRelay(cfg: Config, options: RelayOptions = {}): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const ensure = options.ensureDaemon ?? ensureDaemon;
  const suppressed = options.autostartSuppressed ?? (() => autostartSuppressed());
  const now = options.now ?? Date.now;
  const reviveSettleMs = options.reviveSettleMs ?? REVIVE_SETTLE_MS;

  // 세션 시작마다 플러그인 버전을 확인한다. try 블록보다 앞에 두는 것이 중요하다 —
  // relay 가 구버전이라 daemon 연결에 실패하는 상황이 바로 자동 업데이트가 고쳐야 할 경우다.
  if (options.selfUpdate) options.selfUpdate();
  else void triggerSelfUpdateFromRelay();

  const transportFetch = createRelayFetch();
  let endpoint: URL;
  let token: string;
  try {
    endpoint = resolveMcpEndpoint(cfg);
    ({ token } = await ensure({ cfg, endpoint }));
  } catch (error) {
    await reportStartupFailure(relayStartupError(error), stdin, stdout);
    return;
  }
  const stdio = new StdioServerTransport(stdin, stdout);
  let downstream = createDownstream(endpoint, token, transportFetch);

  // 데몬 세션이 한 번이라도 선 적이 있는가. 선 적이 없다면 복구할 세션도 없으므로
  // 실패는 치명적이고, 릴레이는 사유를 답한 뒤 종료해야 한다.
  let sessionEstablished = false;
  // 세션 재수립 때 재생할 initialize. 호스트가 보낸 원본을 그대로 쓴다.
  let cachedInitialize: JSONRPCMessage | null = null;
  // 재수립용 initialize 응답의 id — 호스트는 이 요청을 보낸 적이 없으므로 삼킨다.
  let swallowResponseId: string | number | null = null;
  let reestablishing: Promise<void> | null = null;

  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const close = async (terminateSession: boolean): Promise<void> => {
    if (closing) return;
    closing = true;
    const link = downstream;
    if (terminateSession && link.sessionId) {
      try {
        await link.terminateSession();
      } catch (error) {
        log.warn('[relay] failed to terminate downstream session: ' + describeError(error));
      }
    }
    try {
      await link.close();
    } catch {
      /* ignore */
    }
    try {
      await stdio.close();
    } catch {
      /* ignore */
    }
    resolveClosed();
  };
  const onStdinEnd = (): void => {
    void close(true);
  };
  stdin.once('end', onStdinEnd);
  stdin.once('close', onStdinEnd);

  // 교체된 downstream 의 콜백은 무시한다 — 재수립 중 이전 링크를 닫을 때
  // 그 onclose 가 릴레이 전체를 끝내면 안 된다.
  const wireDownstream = (link: StreamableHTTPClientTransport): void => {
    link.onmessage = (message) => {
      if (link !== downstream) return;
      const result =
        'result' in message && message.result && typeof message.result === 'object'
          ? (message.result as Record<string, unknown>)
          : null;
      if (typeof result?.protocolVersion === 'string') {
        link.setProtocolVersion(result.protocolVersion);
      }
      if (
        swallowResponseId !== null &&
        'id' in message &&
        message.id === swallowResponseId
      ) {
        swallowResponseId = null;
        return;
      }
      void stdio.send(message).catch((error) => {
        log.error('[relay] upstream response failed: ' + describeError(error));
        void close(true);
      });
    };
    link.onerror = (error) => {
      if (link !== downstream) return;
      log.error('[relay] daemon transport error: ' + describeError(error));
    };
    link.onclose = () => {
      if (link !== downstream) return;
      void close(false);
    };
  };

  const doReestablish = async (): Promise<void> => {
    const initialize = cachedInitialize;
    if (!initialize) throw new Error('no cached initialize request to replay');
    log.warn('[relay] daemon session is gone; re-establishing it');
    const previous = downstream;
    const next = createDownstream(endpoint, token, transportFetch);
    // 교체를 먼저 해야 previous.close() 의 onclose 가 무시된다.
    downstream = next;
    wireDownstream(next);
    try {
      await previous.close();
    } catch {
      /* ignore */
    }
    await next.start();
    swallowResponseId = isJSONRPCRequest(initialize) ? initialize.id : null;
    try {
      await next.send(initialize);
    } finally {
      swallowResponseId = null;
    }
    if (!next.sessionId) {
      throw new Error('daemon did not return a session id for the replayed initialize');
    }
    await next.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
    log.info('[relay] daemon session re-established');
  };

  const reestablishSession = (): Promise<void> => {
    if (!reestablishing) {
      reestablishing = doReestablish().finally(() => {
        reestablishing = null;
      });
    }
    return reestablishing;
  };

  // 세션 중 데몬이 사라졌을 때(ECONNREFUSED) 다시 띄운다. 시작할 때와 같은 ensureDaemon 을 쓰므로
  // 같은 버전이면 붙고, 낮은 버전이면 재시작하고, 높은 버전이면 업데이트하라는 사유로 실패한다.
  let reviving: Promise<boolean> | null = null;
  let lastReviveAt = Number.NEGATIVE_INFINITY;

  const waitForDaemonPort = async (): Promise<void> => {
    const deadline = Date.now() + reviveSettleMs;
    while (Date.now() < deadline) {
      if (await isPortOpen(endpoint)) return;
      const wait = Math.min(REVIVE_SETTLE_POLL_MS, deadline - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    }
  };

  /** 데몬을 다시 띄우는 시도를 했으면 true. 억제 상태이거나 간격 제한에 걸리면 false. */
  const reviveDaemon = (): Promise<boolean> => {
    if (reviving) return reviving;
    // 원격 터널 세션은 로컬 데몬을 띄우지 않는다. 요청은 이전과 같은 연결 오류로 끝난다.
    if (suppressed()) return Promise.resolve(false);
    const startedAt = now();
    if (startedAt - lastReviveAt < REVIVE_INTERVAL_MS) {
      log.warn(
        '[relay] daemon is still not listening; the last restart attempt was ' +
          `${Math.round((startedAt - lastReviveAt) / 1000)}s ago`,
      );
      return Promise.resolve(false);
    }
    lastReviveAt = startedAt;
    reviving = (async (): Promise<boolean> => {
      log.warn(`[relay] no daemon is listening on ${endpoint.href}; starting it again`);
      await waitForDaemonPort();
      try {
        const handle = await ensure({ cfg, endpoint });
        token = handle.token;
        log.info(
          handle.started ? '[relay] daemon restarted' : '[relay] daemon is listening again',
        );
        return true;
      } catch (error) {
        throw daemonRestartError(error, endpoint);
      }
    })().finally(() => {
      reviving = null;
    });
    return reviving;
  };

  /**
   * 세션을 다시 세운다. 새 연결이 거절됐으면(ECONNREFUSED) 먼저 데몬을 다시 띄운다.
   * isSafeToResend 인 실패에만 부른다. 그 요청은 실행된 적이 없으므로 재전송해도 안전하다.
   */
  const recoverSession = async (cause: unknown): Promise<void> => {
    if (isConnectionRefused(cause)) await reviveDaemon();
    await reestablishSession();
  };

  const replyFailure = async (message: JSONRPCMessage, error: Error): Promise<void> => {
    const failure = rpcFailure(message, error);
    if (!failure) return;
    try {
      await stdio.send(failure);
    } catch {
      /* closing */
    }
  };

  const forwardToDaemon = async (message: JSONRPCMessage): Promise<void> => {
    try {
      await downstream.send(message);
      if (downstream.sessionId) sessionEstablished = true;
      return;
    } catch (error) {
      // 데몬에 한 번도 붙지 못했거나 버전이 어긋났다면 복구할 여지가 없다.
      if (!sessionEstablished || isFatalDaemonError(error)) {
        const reported = daemonRequestError(error, endpoint);
        log.error('[relay] downstream request failed: ' + describeError(error));
        await replyFailure(message, reported);
        await close(sessionEstablished);
        return;
      }
      // 데몬에 닿았을 수 있는 요청은 재전송하지 않는다. 툴 호출은 멱등이 아니다.
      // 데몬이 멈췄으면(503) 세션도 다시 세우지 않는다. 다음 호출이 404 나 ECONNREFUSED 를 맞을 때 다시 붙는다.
      if (!isSafeToResend(error)) {
        log.warn(
          '[relay] downstream request may have reached the daemon before it failed: ' +
            describeError(error) +
            '; not re-sending it',
        );
        await replyFailure(message, unfinishedRequestError(error, endpoint, suppressed()));
        return;
      }
      log.warn(
        '[relay] downstream request failed: ' + describeError(error) + ' — recovering',
      );
      let resent = false;
      try {
        await recoverSession(error);
        resent = true;
        await downstream.send(message);
        if (downstream.sessionId) sessionEstablished = true;
      } catch (retryError) {
        // 복구가 실패해도 릴레이는 살린다. 데몬이 돌아오면 다음 요청이 다시 붙는다.
        log.error('[relay] session recovery failed: ' + describeError(retryError));
        const reported =
          resent && !isSafeToResend(retryError)
            ? unfinishedRequestError(retryError, endpoint, suppressed())
            : daemonRequestError(retryError, endpoint);
        await replyFailure(message, reported);
      }
    }
  };

  /** 세션이 선 적이 없으면 initialize 만 데몬에 보내고, 나머지는 relay 가 답한다. */
  const forwardQueued = async (message: JSONRPCMessage): Promise<void> => {
    if (sessionEstablished || downstream.sessionId || isInitializeRequest(message)) {
      await forwardToDaemon(message);
      return;
    }
    // 세션 없이 온 알림은 데몬이 받을 곳이 없다.
    if (!isJSONRPCRequest(message)) return;
    log.info(
      `[relay] answered ${message.method} before initialize; no daemon session exists yet`,
    );
    try {
      await stdio.send(answerBeforeSession(message));
    } catch {
      /* closing */
    }
  };

  // 세션이 서기 전까지는 순서를 지켜 보낸다. 세션 ID 는 initialize 응답 헤더에서만
  // 채워지므로, 그 전에 후속 메시지가 나가면 데몬이 400 으로 거절한다. stdio 는
  // 순서가 보장되는 채널이고 호스트도 그 가정 위에서 쓴다.
  let sendChain: Promise<void> = Promise.resolve();
  stdio.onmessage = (message) => {
    if (isInitializeRequest(message)) cachedInitialize = message;
    if (!downstream.sessionId) {
      sendChain = sendChain
        .then(() => forwardQueued(message))
        .catch((error) => {
          log.error('[relay] queued message failed: ' + describeError(error));
        });
      return;
    }
    // 세션이 선 뒤에는 병렬을 허용한다 — 장시간 툴이 뒤 요청을 막으면 안 된다.
    void forwardToDaemon(message);
  };
  stdio.onerror = (error) => {
    log.error('[relay] stdio transport error: ' + error.message);
  };
  stdio.onclose = () => {
    void close(true);
  };

  wireDownstream(downstream);
  await downstream.start();
  await stdio.start();
  log.info(`[relay] forwarding stdio to ${endpoint.href}`);
  await closed;
  stdin.off('end', onStdinEnd);
  stdin.off('close', onStdinEnd);
}
