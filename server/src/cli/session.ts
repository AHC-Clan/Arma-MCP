// session.ts: CLI 명령 하나가 쓰는 데몬 MCP 세션.
//
// 프로세스마다 세션 하나를 열고 명령이 끝나면 닫는다. CLI 는 이미 떠 있는 데몬에 붙기만 한다.
// 데몬을 띄우거나 재시작하거나 끄지 않고, 게임 게이트웨이도 열지 않는다. 데몬은 여러 에이전트
// 세션이 함께 쓰므로 그 수명은 relay 가 맡는다. 그래서 여기서는 ensureDaemon 을 쓰지 않는다.
//
// 토큰은 헤더에만 싣는다. 명령줄, 출력, 오류 메시지 어디에도 옮기지 않는다.

import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { resolveMcpEndpoint, resolveMcpTokenFile, type Config } from '../config.js';
import { loadMcpToken } from '../daemon/token.js';
import {
  createRelayFetch,
  daemonErrorText,
  describeError,
  failedAfterSocketReset,
} from '../daemon/relayFetch.js';
import {
  MCP_CLIENT_VERSION_HEADER,
  MCP_TRANSPORT_HEADER,
  MCP_VERSION_HEADER,
  STOPPING_MESSAGE,
} from '../daemon/httpDaemon.js';
import { ARMA_MCP_VERSION, compareVersions } from '../version.js';
import { CliError, EXIT } from './errors.js';
import { formatDuration } from './render.js';

/**
 * 도구 호출 하나의 상한. SDK 기본 60초는 arma_play 와 arma_rpt_wait 를 중간에 끊는다.
 * 가장 긴 도구 대기(10분)보다 넉넉히 잡는다.
 */
export const CALL_TIMEOUT_MS = 900_000;
/** initialize 왕복 상한. 데몬이 살아 있으면 수 ms 안에 끝난다. */
const CONNECT_TIMEOUT_MS = 30_000;
/** 끝낼 때 DELETE 를 기다리는 상한. 못 보내도 데몬의 cli 유휴 만료가 세션을 치운다. */
const TERMINATE_WAIT_MS = 1000;

export interface CallOptions {
  /** 이 호출의 상한(ms). 기본 CALL_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * 중단 신호를 걸지 않는다. 중단된 뒤 게임 안의 루프를 멈추는 정리 호출에 쓴다.
   * 이 호출은 timeoutMs 로만 끊긴다.
   */
  ignoreInterrupt?: boolean;
}

export interface CliSession {
  readonly endpoint: URL;
  call(name: string, args: Record<string, unknown>, opts?: CallOptions): Promise<CallToolResult>;
  /** 세션을 닫는다. 진행 중인 호출은 기다리지 않고 끊는다. 여러 번 불러도 된다. */
  close(): Promise<void>;
}

export interface OpenCliSessionOptions {
  /** 중단 신호. 걸리면 진행 중인 요청을 취소한다. */
  signal?: AbortSignal;
  /** initialize 왕복 상한(ms). 테스트 주입. 기본 CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
}

const TUNNEL_HINT =
  'ARMA_MCP_TOKEN 이 설정돼 있어 터널 연결로 본다. SSH 터널이 열려 있는지 확인한다. ' +
  '에이전트 세션과 같은 ARMA_MCP_TOKEN 과 ARMA_MCP_CONFIG 를 이 셸에 export 한다.';

function withTunnelHint(message: string, env: NodeJS.ProcessEnv): string {
  return env.ARMA_MCP_TOKEN ? `${message} ${TUNNEL_HINT}` : message;
}

function tokenError(cfg: Config, env: NodeJS.ProcessEnv, error: unknown): CliError {
  if (env.ARMA_MCP_TOKEN) {
    // validateToken 의 메시지는 길이만 말하고 값은 싣지 않는다.
    return new CliError(
      EXIT.connection,
      `ARMA_MCP_TOKEN 을 쓸 수 없다: ${(error as Error).message}`,
    );
  }
  return new CliError(
    EXIT.connection,
    `데몬 토큰을 읽지 못했다(${resolveMcpTokenFile(cfg)}). ` +
      '이 컴퓨터에서 데몬이 뜬 적이 없거나 mcp.tokenFile 설정이 다르다. ' +
      '에이전트 세션의 MCP 연결을 열면 relay 가 데몬을 띄운다. ' +
      '터널로 붙는 중이면 에이전트 세션과 같은 ARMA_MCP_TOKEN 과 ARMA_MCP_CONFIG 를 이 셸에 export 한다.',
  );
}

function isConnectionRefused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ECONNREFUSED') return true;
  const errors = (error as { errors?: unknown[] } | undefined)?.errors;
  return Array.isArray(errors) && errors.some((inner) => isConnectionRefused(inner));
}

export function unreachableMessage(host: string, env: NodeJS.ProcessEnv): string {
  return withTunnelHint(
    `데몬에 연결하지 못했다(${host}). CLI 는 데몬을 띄우지 않는다. ` +
      '에이전트 세션의 MCP 연결을 다시 열면 relay 가 띄운다. 진단은 arma-mcp doctor.',
    env,
  );
}

export function versionSkewMessage(daemonVersion: string | null): string {
  const daemon = daemonVersion ?? '(알 수 없음)';
  if (daemonVersion && compareVersions(ARMA_MCP_VERSION, daemonVersion) < 0) {
    return (
      `CLI ${ARMA_MCP_VERSION} 와 데몬 ${daemon} 의 버전이 다르다. CLI 가 더 낮다. ` +
      '셸 PATH 의 arma-mcp 가 옛 플러그인 폴더를 가리킨다. ' +
      '에이전트 세션을 새로 열면 새 버전의 bin 이 PATH 에 오른다.'
    );
  }
  return (
    `CLI ${ARMA_MCP_VERSION} 와 데몬 ${daemon} 의 버전이 다르다. ` +
    'CLI 는 다른 세션이 쓰는 데몬을 재시작하지 않는다. ' +
    '에이전트 세션을 새로 열면 relay 가 데몬을 맞춘다.'
  );
}

function unauthorizedMessage(host: string, env: NodeJS.ProcessEnv): string {
  const fix = env.ARMA_MCP_TOKEN
    ? 'ARMA_MCP_TOKEN 을 에이전트 세션과 같은 값으로 export 한다.'
    : 'mcp.tokenFile 설정과 ARMA_MCP_CONFIG 가 데몬과 같은지 확인한다.';
  return (
    `데몬이 토큰을 거부했다(HTTP 401, ${host}). 이 셸의 토큰이 실행 중인 데몬의 토큰과 다르다. ` +
    `${fix} 진단은 arma-mcp doctor.`
  );
}

function capMessage(body: string): string {
  const setting = /mcp\.\w+=\d+/.exec(body)?.[0] ?? 'mcp.maxCliSessions';
  return (
    `데몬의 세션 자리가 가득 찼다(HTTP 429, ${setting}). ` +
    '다른 arma-mcp 명령이 끝난 뒤 다시 실행한다. 자주 모자라면 설정에서 이 상한을 올린다.'
  );
}

/**
 * 데몬 응답을 먼저 보고 연결 문제를 종료 코드 3 의 오류로 바꾼다.
 * SDK 는 fetch 가 던진 오류를 그대로 callTool 과 connect 의 거부 사유로 넘긴다.
 */
function checkedFetch(base: typeof fetch, host: string, env: NodeJS.ProcessEnv): typeof fetch {
  const wrapped = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await base(input, init);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      // keep-alive 소켓이 끊긴 뒤 새 연결까지 거절됐으면 첫 시도가 데몬에 닿았을 수 있다. 아래 끊김 문구로 답한다.
      if (isConnectionRefused(error) && !failedAfterSocketReset(error)) {
        throw new CliError(EXIT.connection, unreachableMessage(host, env));
      }
      throw new CliError(
        EXIT.connection,
        withTunnelHint(
          `데몬 연결이 끊겼다(${host}): ${describeError(error)}. ` +
            '데몬이 종료됐거나 재시작됐을 수 있다. 진단은 arma-mcp doctor.',
          env,
        ),
      );
    }
    const daemonVersion = response.headers.get(MCP_VERSION_HEADER);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(EXIT.connection, unauthorizedMessage(host, env));
    }
    if (response.status === 409) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(EXIT.connection, versionSkewMessage(daemonVersion));
    }
    if (response.status === 429) {
      const body = await response.text().catch(() => '');
      throw new CliError(EXIT.connection, capMessage(body));
    }
    if (daemonVersion === null && !response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(
        EXIT.connection,
        `${host} 에서 Arma-MCP 데몬이 아닌 응답(HTTP ${response.status})을 받았다. ` +
          '다른 서비스가 mcp.port 를 쓰고 있을 수 있다. 진단은 arma-mcp doctor.',
      );
    }
    if (daemonVersion !== null && daemonVersion !== ARMA_MCP_VERSION) {
      await response.body?.cancel().catch(() => undefined);
      throw new CliError(EXIT.connection, versionSkewMessage(daemonVersion));
    }
    return response;
  };
  return wrapped as typeof fetch;
}

/**
 * 도구 호출에서 SDK 가 낸 오류를 종료 코드가 붙은 오류로 바꾼다. 이미 CliError 면 그대로 둔다.
 * 중단은 main 이 신호를 보고 따로 처리한다. initialize 중의 오류는 connectError 가 맡는다.
 */
export function toCliError(
  error: unknown,
  host: string,
  timeoutMs: number = CALL_TIMEOUT_MS,
): unknown {
  if (error instanceof CliError) return error;
  if (error instanceof StreamableHTTPError) {
    if (error.code === 503) {
      // 데몬이 멈추는 중이다. 데몬 문구가 이 요청이 실행됐는지 알린다. CLI 는 다시 보내지 않는다.
      // 실행되지 않았다고 확인된 경우에만 다시 실행하라고 안내한다. arma-mcp status 는 SQF 가 돌았는지 보여 주지 않는다.
      const text = daemonErrorText(error) ?? 'Arma-MCP daemon is stopping';
      const next =
        text === STOPPING_MESSAGE
          ? 'arma-mcp status 로 데몬이 다시 떴는지 본 뒤 다시 실행한다.'
          : '명령이 게임에서 이미 실행됐을 수 있다. 다시 실행하기 전에 읽기 전용 exec 나 RPT 로 게임 상태를 확인한다.';
      return new CliError(
        EXIT.connection,
        `데몬이 멈추는 중이다(HTTP 503, ${host}): ${text}. CLI 는 명령을 다시 보내지 않는다. ${next}`,
      );
    }
    return new CliError(
      EXIT.connection,
      `데몬 요청이 실패했다(HTTP ${error.code}, ${host}): ${error.message}`,
    );
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      const limit =
        timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000}분` : formatDuration(timeoutMs);
      return new CliError(EXIT.timeout, `도구 호출이 ${limit} 안에 끝나지 않았다.`);
    }
    if (error.code === ErrorCode.ConnectionClosed) {
      return new CliError(EXIT.connection, `데몬 연결이 닫혔다(${host}): ${error.message}`);
    }
    return new CliError(EXIT.failure, `도구 오류: ${error.message}`);
  }
  return error;
}

/**
 * initialize 중에 난 오류를 종료 코드 3 으로 바꾼다. 세션을 열지 못한 것은 모두 연결 문제다.
 * 포트는 받았는데 답이 없는 데몬을 대기 시간 초과(5)로 내면 셸 루프가 "아직 안 떴다"로 읽는다.
 */
export function connectError(
  error: unknown,
  host: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number = CONNECT_TIMEOUT_MS,
): unknown {
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return new CliError(
        EXIT.connection,
        withTunnelHint(
          `데몬이 ${formatDuration(timeoutMs)} 안에 initialize 에 답하지 않았다(${host}). ` +
            '데몬이 멈췄거나 다른 프로그램이 mcp.port 를 쓰고 있을 수 있다. 진단은 arma-mcp doctor.',
          env,
        ),
      );
    }
    if (error.code !== ErrorCode.ConnectionClosed) {
      return new CliError(
        EXIT.connection,
        `데몬이 initialize 를 거부했다(${host}): ${error.message}. 진단은 arma-mcp doctor.`,
      );
    }
  }
  return toCliError(error, host, timeoutMs);
}

function delay(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function openCliSession(
  cfg: Config,
  env: NodeJS.ProcessEnv,
  opts: OpenCliSessionOptions = {},
): Promise<CliSession> {
  const endpoint = resolveMcpEndpoint(cfg);
  const host = endpoint.host;
  let token: string;
  try {
    token = loadMcpToken(cfg, env);
  } catch (error) {
    throw tokenError(cfg, env, error);
  }

  // agent 는 이 프로세스만 쓴다. close 에서 transport 가 요청을 모두 끊은 뒤에 destroy 한다.
  // 진행 중인 요청이 있을 때 먼저 destroy 하면 relayFetch 가 재사용 소켓 실패로 보고 다시 보낸다.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: checkedFetch(createRelayFetch({ agent }), host, env),
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        [MCP_CLIENT_VERSION_HEADER]: ARMA_MCP_VERSION,
        [MCP_TRANSPORT_HEADER]: 'cli',
      },
    },
  });
  const client = new Client({ name: 'arma-mcp-cli', version: ARMA_MCP_VERSION });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      if (transport.sessionId) {
        const cap = delay(TERMINATE_WAIT_MS);
        await Promise.race([transport.terminateSession().catch(() => undefined), cap.promise]);
        cap.cancel();
      }
      // transport.close 가 남은 요청을 abort 로 끊고, 기다리던 호출은 연결 종료로 거부된다.
      await client.close().catch(() => undefined);
      agent.destroy();
    })();
    return closing;
  };

  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  try {
    await client.connect(transport, { signal: opts.signal, timeout: connectTimeoutMs });
  } catch (error) {
    await close();
    throw connectError(error, host, env, connectTimeoutMs);
  }

  return {
    endpoint,
    async call(name, args, callOpts = {}) {
      try {
        const result = await client.callTool({ name, arguments: args }, undefined, {
          signal: callOpts.ignoreInterrupt ? undefined : opts.signal,
          timeout: callOpts.timeoutMs ?? CALL_TIMEOUT_MS,
        });
        return result as CallToolResult;
      } catch (error) {
        throw toCliError(error, host, callOpts.timeoutMs ?? CALL_TIMEOUT_MS);
      }
    },
    close,
  };
}
