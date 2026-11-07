import http, { STATUS_CODES } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { log } from '../log.js';

/**
 * 릴레이가 데몬에 붙을 때 쓰는 HTTP 클라이언트.
 *
 * 전역 fetch(undici) 를 쓰지 않는 이유는 하나다: undici 는 headersTimeout /
 * bodyTimeout 기본값이 각각 300초라 5분을 넘기는 툴 호출을 반드시 끊는다.
 * 데몬은 enableJsonResponse 로 동작하므로 응답 헤더가 툴 완료 뒤에야 나가고,
 * arma_rpt_wait(최대 10분) 이나 arma_watch(최대 303초) 는 그 한계를 그대로 넘는다.
 * 여기서는 응답 대기에 어떤 타임아웃도 걸지 않고, 취소는 SDK 가 넘기는
 * AbortSignal 로만 이뤄진다.
 *
 * 대상이 루프백 · JSON 전용 · Bearer 인증이고, 데몬이 릴레이 세션에는 SSE 스트림을
 * 주지 않으므로(httpDaemon 의 405) 스트리밍 응답 경로는 구현하지 않는다.
 */

/** SDK 가 실제로 소비하는 Response 표면만 갖춘 최소 구현. */
interface BufferedResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  body: { cancel(): Promise<void> } | null;
}

interface SocketError extends NodeJS.ErrnoException {
  /** keep-alive 로 재사용한 소켓에서 터진 실패인가. */
  reusedSocket?: boolean;
  /** 재사용 소켓이 끊겨 새 연결로 다시 보냈다가 실패했다. 첫 시도는 데몬에 닿았을 수 있다. */
  afterSocketReset?: boolean;
}

/**
 * 재시도할 소켓 재사용 실패. 대개 데몬이 유휴 소켓을 먼저 닫아 요청이 닿지 못한 경우다.
 * 데몬이 요청을 받아 실행하다 죽어도 같은 모습이라, 재시도가 실패하면 그 오류에 표시를 남긴다.
 */
const REUSE_FAILURE_CODES = new Set(['ECONNRESET', 'EPIPE']);

function buildResponse(
  status: number,
  headers: IncomingHttpHeaders,
  body: Buffer,
): BufferedResponse {
  return {
    status,
    statusText: STATUS_CODES[status] ?? '',
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        const value = headers[name.toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? (value[0] ?? null) : value;
      },
    },
    text: async () => body.toString('utf8'),
    json: async () => JSON.parse(body.toString('utf8')) as unknown,
    // 본문은 이미 버퍼에 다 들어와 있으므로 취소할 스트림이 없다.
    body: { cancel: async () => undefined },
  };
}

function headerRecord(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      const [key, value] = entry;
      if (key === undefined || value === undefined) continue;
      out[key] = value;
    }
    return out;
  }
  if (typeof (headers as Headers).forEach === 'function') {
    (headers as Headers).forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    out[key] = value;
  }
  return out;
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

function requestOnce(
  url: URL,
  init: RequestInit,
  agent: http.Agent,
): Promise<BufferedResponse> {
  return new Promise<BufferedResponse>((resolve, reject) => {
    const headers = headerRecord(init.headers ?? undefined);
    const body = typeof init.body === 'string' ? init.body : undefined;
    if (body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(body, 'utf8'));
    }

    const request = http.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers,
        agent,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', settleReject);
        response.on('end', () => {
          settleResolve(
            buildResponse(
              response.statusCode ?? 0,
              response.headers,
              Buffer.concat(chunks),
            ),
          );
        });
      },
    );

    const signal = init.signal ?? undefined;
    const onAbort = (): void => {
      request.destroy(abortError(signal?.reason));
    };
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
    };
    const settleResolve = (value: BufferedResponse): void => {
      if (settled) return;
      cleanup();
      resolve(value);
    };
    const settleReject = (error: Error): void => {
      if (settled) return;
      cleanup();
      reject(error);
    };

    request.on('error', (error) => {
      // 소켓 재사용 여부는 호출자가 재시도 가능 여부를 판단하는 유일한 근거다.
      (error as SocketError).reusedSocket = request.reusedSocket === true;
      settleReject(error);
    });

    if (signal) {
      if (signal.aborted) {
        request.destroy(abortError(signal.reason));
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    if (body !== undefined) request.write(body);
    request.end();
  });
}

function isRetryableReuseFailure(error: unknown): boolean {
  const socketError = error as SocketError | undefined;
  if (!socketError || socketError.reusedSocket !== true) return false;
  return REUSE_FAILURE_CODES.has(socketError.code ?? '');
}

export interface RelayFetchOptions {
  /**
   * 요청에 쓸 agent. 호출자가 만들고 끝날 때 destroy 한다.
   * 비우면 여기서 keep-alive agent 를 만든다. 릴레이는 이 기본값을 쓴다.
   */
  agent?: http.Agent;
}

/**
 * 릴레이용 fetch. keep-alive 소켓을 재사용하다 끊긴 경우에만 새 연결로 한 번 재시도한다.
 * 데몬이 유휴 소켓을 먼저 닫은 경우라면 요청은 닿지 않았고 재시도가 그대로 성공한다.
 * 데몬이 요청을 받은 뒤 죽은 경우라면 새 연결은 거절된다. 그 오류에는 afterSocketReset 표시를 남겨
 * 호출자가 데몬에 닿지 않은 요청으로 보고 재전송하지 않게 한다(failedAfterSocketReset).
 * 응답을 받기 시작한 뒤의 실패는 재시도하지 않는다(툴 호출은 멱등이 아니다).
 * CLI 도 같은 함수를 자기 agent 로 쓴다.
 */
export function createRelayFetch(opts: RelayFetchOptions = {}): typeof fetch {
  const agent =
    opts.agent ??
    new http.Agent({
      keepAlive: true,
      // Agent 의 timeout 은 활성 요청 소켓에도 걸리므로 지정하지 않는다.
      // 유휴 소켓 수명은 데몬의 keepAliveTimeout 이 정하고, 그 경계는 아래 재시도가 흡수한다.
      maxSockets: 32,
    });

  const relayFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<BufferedResponse> => {
    const url = input instanceof URL ? input : new URL(String(input));
    const options = init ?? {};
    try {
      return await requestOnce(url, options, agent);
    } catch (error) {
      if (!isRetryableReuseFailure(error)) throw error;
      log.warn(
        '[relay] daemon closed an idle keep-alive socket ' +
          `(${(error as SocketError).code}); retrying once on a fresh connection`,
      );
      try {
        return await requestOnce(url, options, agent);
      } catch (retryError) {
        if (retryError instanceof Error) (retryError as SocketError).afterSocketReset = true;
        throw retryError;
      }
    }
  };

  return relayFetch as unknown as typeof fetch;
}

/**
 * 재사용 소켓이 끊긴 뒤 새 연결 재시도까지 실패한 오류인가. 첫 시도는 데몬이 받아 실행했을 수 있으므로
 * 이 오류의 ECONNREFUSED 를 요청이 데몬에 닿지 않았다는 근거로 쓰면 안 된다.
 */
export function failedAfterSocketReset(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    if ((current as SocketError).afterSocketReset === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 데몬이 보낸 JSON-RPC 오류 본문의 message. SDK 는 본문을 "Error POSTing to endpoint: " 뒤에 붙인다.
 * relay 와 CLI 가 데몬의 503 문구를 그대로 전할 때 쓴다.
 */
export function daemonErrorText(error: Error): string | null {
  const marker = 'Error POSTing to endpoint: ';
  const at = error.message.indexOf(marker);
  if (at < 0) return null;
  try {
    const body = JSON.parse(error.message.slice(at + marker.length)) as {
      error?: { message?: unknown };
    };
    return typeof body.error?.message === 'string' ? body.error.message : null;
  } catch {
    return null;
  }
}

/** fetch 실패는 래퍼 메시지만으로 원인을 못 가린다. cause 체인을 펼쳐 로그에 남긴다. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; cause instanceof Error && depth < 4; depth += 1) {
    const detail = cause as SocketError;
    parts.push(
      'caused by ' +
        [detail.message, detail.code, detail.syscall].filter(Boolean).join(' '),
    );
    cause = (cause as { cause?: unknown }).cause;
  }
  const code = (error as SocketError).code;
  if (code && !parts.some((part) => part.includes(code))) parts.push(`code ${code}`);
  return parts.join('; ');
}
