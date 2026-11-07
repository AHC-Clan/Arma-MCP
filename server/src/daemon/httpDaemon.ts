import http, {
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../config.js';
import type { SharedDeps } from '../mcp/deps.js';
import { withSession } from '../mcp/deps.js';
import { buildMcpServer } from '../mcp/server.js';
import {
  createSessionContext,
  type SessionTransport,
} from '../mcp/session.js';
import { ARMA_MCP_VERSION } from '../version.js';
import { log } from '../log.js';
import { SessionRegistry } from './sessionRegistry.js';

const LOOPBACK_HOST = '127.0.0.1';
export const MCP_VERSION_HEADER = 'x-arma-mcp-version';
export const MCP_CLIENT_VERSION_HEADER = 'x-arma-mcp-client-version';
export const MCP_TRANSPORT_HEADER = 'x-arma-mcp-transport';

/**
 * stop() 의 유예(ms). 진행 중 툴 호출은 이 안에 끝나면 실제 결과로 답하고, 넘으면 503 으로 끊는다.
 * 본문을 다 보내지 않은 요청처럼 세션에 닿기 전에 멈춘 연결도 이 유예가 지나면 끊는다.
 */
export const STOP_GRACE_MS = 2000;
/** 503 을 쓴 연결이 닫히기를 기다리는 최소 시간이자, 강제로 끊은 뒤 close 콜백을 기다리는 상한(ms). */
const STOP_FORCE_WAIT_MS = 500;

/**
 * 멈추는 중에 들어온 요청에 답하는 문구. 세션에 닿기 전에 거절하므로 실행되지 않았다고 말할 수 있다.
 * CLI 는 이 문구일 때만 다시 실행하라고 안내한다.
 */
export const STOPPING_MESSAGE = 'Arma-MCP daemon is stopping; this request was not run';
/** 유예 안에 끝나지 않아 끊은 진행 중 요청에 답하는 문구. */
const STOPPED_MESSAGE =
  'Arma-MCP daemon stopped before this request finished; the tool may or may not have run';

/** promise 가 ms 안에 끝나면 true, 아니면 false. 타이머는 남기지 않는다. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    clearTimeout(timer);
  }
}

interface SessionRecord {
  server: McpServer;
  /** SDK 전송 객체. 클라이언트 종류는 kind 에 따로 둔다. */
  transport: StreamableHTTPServerTransport;
  /** 클라이언트 종류. 세션 상한과 유휴 만료를 종류별로 적용한다. */
  kind: SessionTransport;
  activeRequests: number;
}

/** 이 종류가 쓰는 세션 상한과 그 설정 이름. 429 에 이름을 실어 어느 값을 올릴지 알린다. */
interface SessionCap {
  setting: 'mcp.maxSessions' | 'mcp.maxCliSessions';
  limit: number;
}

export interface McpHttpDaemonOptions {
  cfg: Config;
  shared: SharedDeps;
  sessions: SessionRegistry;
  token: string;
  /** Test-only port override; production uses cfg.mcp.port. */
  port?: number;
  /** Test-only override of STOP_GRACE_MS. */
  stopGraceMs?: number;
  onShutdownRequested?: () => void | Promise<void>;
}

export interface McpDaemonAddress {
  host: typeof LOOPBACK_HOST;
  port: number;
  mcpPath: string;
  healthPath: '/health';
  shutdownPath: '/shutdown';
}

class PayloadTooLargeError extends Error {}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(encoded.byteLength),
    ...headers,
  });
  res.end(encoded);
}

function writeRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  code = -32000,
  headers: Record<string, string> = {},
): void {
  writeJson(
    res,
    status,
    {
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    },
    headers,
  );
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const lengthText = headerValue(req.headers['content-length']);
  if (lengthText) {
    const length = Number(lengthText);
    if (!Number.isFinite(length) || length < 0) throw new Error('invalid Content-Length');
    if (length > limit) {
      req.resume();
      throw new PayloadTooLargeError(`request body exceeds ${limit} bytes`);
    }
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.byteLength;
    if (bytes > limit) {
      req.resume();
      throw new PayloadTooLargeError(`request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  if (bytes === 0) throw new Error('request body is empty');
  return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
}

/**
 * Authenticated loopback-only Streamable HTTP MCP endpoint. Every initialized
 * client gets its own McpServer/transport/context while SharedDeps remains
 * process-wide.
 */
export class McpHttpDaemon {
  private readonly records = new Map<string, SessionRecord>();
  /** 세션에 보낸 뒤 아직 답하지 않은 POST 응답. 유예 안에 끝나지 않으면 stop() 이 대신 답한다. */
  private readonly inflight = new Set<ServerResponse>();
  /** stop() 이 진행 중 POST 가 모두 끝나기를 기다릴 때 부르는 콜백. */
  private onInflightDrained: (() => void) | null = null;
  private httpServer: Server | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private actualPort = 0;
  private stopping = false;
  private shutdownRequested = false;

  constructor(private readonly options: McpHttpDaemonOptions) {}

  address(): McpDaemonAddress | null {
    if (!this.httpServer?.listening || this.actualPort === 0) return null;
    return {
      host: LOOPBACK_HOST,
      port: this.actualPort,
      mcpPath: this.options.cfg.mcp.path,
      healthPath: '/health',
      shutdownPath: '/shutdown',
    };
  }

  async start(): Promise<McpDaemonAddress> {
    if (this.httpServer) throw new Error('MCP daemon already started');
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        log.error('[mcp-daemon] request failed', (error as Error).stack ?? String(error));
        if (!res.headersSent) writeRpcError(res, 500, 'Internal server error', -32603);
        else res.destroy();
      });
    });
    // 툴 하나가 몇 분씩 걸릴 수 있으므로 요청 타임아웃은 열어 둔다.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    // keepAliveTimeout 을 명시하지 않으면 Node 기본 5초가 적용되어, 툴 호출 간격이
    // 5초만 넘어도 데몬이 유휴 소켓을 닫는다. 릴레이가 그 소켓을 재사용하면
    // ECONNRESET 이고, MCP SDK 는 POST 를 재시도하지 않는다.
    server.keepAliveTimeout = this.options.cfg.mcp.keepAliveTimeoutMs;
    this.httpServer = server;

    const configuredPort = this.options.port ?? this.options.cfg.mcp.port;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(configuredPort, LOOPBACK_HOST);
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      await this.stop();
      throw new Error('MCP daemon did not expose a TCP address');
    }
    this.actualPort = addr.port;
    // 만료가 짧은 쪽에 맞춰 훑는다. cli 세션 만료는 보통 relay 보다 훨씬 짧다.
    const shortestIdleMs = Math.min(
      this.options.cfg.mcp.idleTimeoutMs,
      this.options.cfg.mcp.cliIdleTimeoutMs,
    );
    const sweepEvery = Math.max(250, Math.min(60_000, Math.floor(shortestIdleMs / 2)));
    this.idleTimer = setInterval(() => {
      void this.sweepIdleSessions();
    }, sweepEvery);
    this.idleTimer.unref();

    const result = this.address()!;
    log.info(
      `[mcp-daemon] listening on http://${result.host}:${result.port}${result.mcpPath}`,
    );
    return result;
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const graceMs = this.options.stopGraceMs ?? STOP_GRACE_MS;
    const graceEndsAt = Date.now() + graceMs;

    // 새 연결을 받지 않는다. 이미 열린 연결로 들어오는 요청은 handleRequest 가 503 으로 거절한다.
    // server.close() 는 열린 연결이 모두 끝나야 콜백한다. 아래에서 기다림에 상한을 둔다.
    const server = this.httpServer;
    this.httpServer = null;
    const closed = server?.listening
      ? new Promise<void>((resolve) => server.close(() => resolve()))
      : null;
    server?.closeIdleConnections?.();

    // 진행 중 툴 호출은 유예 안에 끝나면 실제 결과로 답한다. 결과를 쓴 연결은 keep-alive 로 남지 않게 닫는다.
    for (const res of this.inflight) {
      if (!res.headersSent) res.setHeader('connection', 'close');
    }
    if (this.inflight.size > 0) {
      const drained = new Promise<void>((resolve) => {
        this.onInflightDrained = resolve;
      });
      await settlesWithin(drained, graceMs);
      this.onInflightDrained = null;
    }

    const ids = [...this.records.keys()];
    await Promise.all(ids.map((id) => this.destroySession(id, 'MCP daemon stopped', true)));

    // 닫힌 세션의 진행 중 POST 는 SDK 가 영영 답하지 않는다. JSON 응답 모드에서 transport 를 닫으면
    // 대기 목록만 지워지고 응답은 쓰이지 않는다. 연결이 매달리지 않게 여기서 대신 답한다.
    // 툴은 이미 실행됐을 수 있으므로 relay 가 이 요청을 안전하게 재전송할 수 있다고 알리지 않는다.
    for (const res of this.inflight) {
      writeRpcError(res, 503, STOPPED_MESSAGE, -32000, { connection: 'close' });
    }
    this.inflight.clear();
    // 유예 동안 답을 마친 연결과, 세션을 닫으며 끝난 SSE 스트림의 연결은 이제 유휴 상태다.
    server?.closeIdleConnections?.();

    if (server && closed) {
      // 답하지 못한 연결이 남아 있으면 끝없이 기다리게 되고, 그동안 프로세스가 게임 파이프를 쥔 채 남는다.
      // 방금 쓴 503 이 나갈 시간은 남긴다.
      const waitMs = Math.max(graceEndsAt - Date.now(), STOP_FORCE_WAIT_MS);
      if (!(await settlesWithin(closed, waitMs))) {
        const open = await new Promise<number>((resolve) =>
          server.getConnections((error, count) => resolve(error ? -1 : count)),
        );
        log.warn(
          `[mcp-daemon] ${open < 0 ? 'some' : open} connection(s) still open ${graceMs}ms after stop; ` +
            'closing them',
        );
        server.closeAllConnections?.();
        if (!(await settlesWithin(closed, STOP_FORCE_WAIT_MS))) {
          log.warn('[mcp-daemon] HTTP server did not report close after forcing connections shut');
        }
      }
    }
    this.actualPort = 0;
  }

  private forgetInflight(res: ServerResponse): void {
    if (!this.inflight.delete(res)) return;
    if (this.inflight.size === 0 && this.onInflightDrained) {
      const resolve = this.onInflightDrained;
      this.onInflightDrained = null;
      resolve();
    }
  }

  async sweepIdleSessions(now = Date.now()): Promise<number> {
    let closed = 0;
    for (const [id, record] of this.records) {
      const session = this.options.sessions.get(id);
      if (!session || record.activeRequests > 0) continue;
      const timeout =
        record.kind === 'cli'
          ? this.options.cfg.mcp.cliIdleTimeoutMs
          : this.options.cfg.mcp.idleTimeoutMs;
      if (now - session.lastActivityAt < timeout) continue;
      await this.destroySession(id, 'MCP session idle timeout', true);
      closed += 1;
    }
    return closed;
  }

  private setCommonHeaders(res: ServerResponse): void {
    res.setHeader(MCP_VERSION_HEADER, ARMA_MCP_VERSION);
    res.setHeader('cache-control', 'no-store');
  }

  private validateHost(req: IncomingMessage): boolean {
    const raw = headerValue(req.headers.host).trim().toLowerCase();
    if (!raw) return false;
    try {
      const parsed = new URL(`http://${raw}`);
      const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
      if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
      return !parsed.port || Number(parsed.port) === this.actualPort;
    } catch {
      return false;
    }
  }

  private authenticate(req: IncomingMessage): boolean {
    const authorization = headerValue(req.headers.authorization);
    const match = /^Bearer[ \t]+(.+)$/i.exec(authorization);
    return Boolean(match && safeTokenEqual(match[1]!, this.options.token));
  }

  private validateOrigin(req: IncomingMessage): boolean {
    const origin = headerValue(req.headers.origin);
    return !origin || this.options.cfg.mcp.allowedOrigins.includes(origin);
  }

  private transportKind(req: IncomingMessage): SessionTransport {
    const declared = headerValue(req.headers[MCP_TRANSPORT_HEADER]);
    if (declared === 'relay' || declared === 'cli') return declared;
    return 'remote-http';
  }

  /** cli 는 자기 상한을 쓴다. 나머지 종류는 지금처럼 mcp.maxSessions 를 함께 쓴다. */
  private sessionCap(kind: SessionTransport): SessionCap & { used: number } {
    const cli = kind === 'cli';
    let used = 0;
    for (const record of this.records.values()) {
      if ((record.kind === 'cli') === cli) used += 1;
    }
    return cli
      ? { setting: 'mcp.maxCliSessions', limit: this.options.cfg.mcp.maxCliSessions, used }
      : { setting: 'mcp.maxSessions', limit: this.options.cfg.mcp.maxSessions, used };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCommonHeaders(res);
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    if (![this.options.cfg.mcp.path, '/health', '/shutdown'].includes(pathname)) {
      writeJson(res, 404, { error: 'Not found' });
      return;
    }
    if (!this.validateHost(req)) {
      writeJson(res, 421, { error: 'Invalid Host header' });
      return;
    }
    if (!this.validateOrigin(req)) {
      writeJson(res, 403, { error: 'Origin is not allowed' });
      return;
    }
    if (!this.authenticate(req)) {
      writeJson(res, 401, { error: 'Bearer authentication required' }, {
        'www-authenticate': 'Bearer',
      });
      return;
    }

    const clientVersion = headerValue(req.headers[MCP_CLIENT_VERSION_HEADER]);
    if (clientVersion && clientVersion !== ARMA_MCP_VERSION) {
      writeJson(res, 409, {
        error:
          `Arma-MCP relay ${clientVersion} does not match daemon ${ARMA_MCP_VERSION}; ` +
          'restart the daemon explicitly before reconnecting',
      });
      return;
    }

    if (pathname === '/health') {
      if (req.method !== 'GET') {
        writeJson(res, 405, { error: 'Method not allowed' }, { allow: 'GET' });
        return;
      }
      writeJson(res, 200, {
        ok: true,
        name: 'arma-mcp',
        version: ARMA_MCP_VERSION,
        // 업그레이드하는 relay 가 /shutdown 뒤에도 남은 이 프로세스를 정확히 집어 끝낼 수 있게 한다.
        pid: process.pid,
        uptimeMs: Math.max(0, Date.now() - this.options.shared.serverStartMs),
        sessions: this.options.sessions.snapshot(),
        game: {
          listenerState: this.options.shared.gateway.getListenerState(),
          connected: this.options.shared.gateway.isConnected(),
          generation: this.options.shared.gateway.generation(),
        },
      });
      return;
    }

    if (pathname === '/shutdown') {
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'Method not allowed' }, { allow: 'POST' });
        return;
      }
      if (this.shutdownRequested) {
        writeJson(res, 202, { ok: true, shuttingDown: true });
        return;
      }
      this.shutdownRequested = true;
      writeJson(res, 202, {
        ok: true,
        shuttingDown: true,
        activeSessions: this.options.sessions.size(),
      });
      res.once('finish', () => {
        Promise.resolve(this.options.onShutdownRequested?.()).catch((error) => {
          log.error('[mcp-daemon] explicit shutdown failed: ' + String(error));
        });
      });
      return;
    }

    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      writeJson(res, 405, { error: 'Method not allowed' }, {
        allow: 'GET, POST, DELETE',
      });
      return;
    }

    // 릴레이에는 standalone SSE 스트림을 제공하지 않는다.
    // 이 데몬은 서버 발신 메시지를 하나도 보내지 않고(enableJsonResponse 로 모든 응답이
    // 자기 POST 를 탄다), 그래서 릴레이가 여는 GET 스트림은 아무것도 나르지 않은 채
    // undici 의 300s bodyTimeout 에 끊기고 SDK 가 영원히 재연결한다(실측 5분 5초 주기).
    // 405 를 받으면 SDK 는 "스트림 미제공"으로 보고 조용히 넘어간다.
    // setCommonHeaders 가 이미 실행됐으므로 이 405 에도 버전 헤더가 실린다 —
    // 없으면 릴레이의 버전 검사가 SDK 보다 먼저 예외를 던진다.
    // SSE 를 실제로 쓸 수 있는 원격 HTTP 클라이언트에는 GET 을 그대로 열어 둔다.
    // cli 도 같은 이유로 막는다. 명령 하나를 처리하고 끝나는 세션이라 스트림을 쓸 일이 없다.
    const kind = this.transportKind(req);
    if (req.method === 'GET' && (kind === 'relay' || kind === 'cli')) {
      writeJson(res, 405, { error: `Standalone SSE stream is not offered to ${kind} sessions` }, {
        allow: 'POST, DELETE',
      });
      return;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      const contentType = headerValue(req.headers['content-type']).toLowerCase();
      if (!contentType.startsWith('application/json')) {
        writeRpcError(res, 415, 'Content-Type must be application/json');
        return;
      }
      try {
        parsedBody = await readJsonBody(req, this.options.cfg.mcp.maxBodyBytes);
      } catch (error) {
        if (error instanceof PayloadTooLargeError) {
          writeRpcError(res, 413, error.message);
        } else {
          writeRpcError(res, 400, `Invalid JSON request body: ${(error as Error).message}`, -32700);
        }
        return;
      }
    }

    // 멈추는 중에는 세션을 만들지도, 세션에 요청을 넘기지도 않는다. 세션에 닿기 전이므로 실행되지 않았다.
    // 본문을 읽는 동안 stop() 이 시작됐을 수 있어 본문을 읽은 뒤에 본다.
    if (this.stopping) {
      writeRpcError(res, 503, STOPPING_MESSAGE, -32000, { connection: 'close' });
      return;
    }

    const sessionId = headerValue(req.headers['mcp-session-id']);
    if (sessionId) {
      const record = this.records.get(sessionId);
      if (!record) {
        writeRpcError(res, 404, 'Unknown or expired MCP session');
        return;
      }
      await this.dispatch(record, sessionId, req, res, parsedBody);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(parsedBody)) {
      writeRpcError(res, 400, 'A valid MCP session ID or initialize request is required');
      return;
    }
    // cli 는 자기 상한을 따로 쓴다. 짧은 cli 호출이 몰려도 relay 가 붙을 자리는 남는다.
    const cap = this.sessionCap(kind);
    if (cap.used >= cap.limit) {
      writeRpcError(res, 429, `Maximum MCP session count reached (${cap.setting}=${cap.limit})`);
      return;
    }

    await this.initializeSession(kind, req, res, parsedBody);
  }

  private async initializeSession(
    kind: SessionTransport,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
  ): Promise<void> {
    const id = randomUUID();
    const context = createSessionContext(kind, id);
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      enableJsonResponse: true,
      onsessionclosed: async (closedId) => {
        await this.destroySession(closedId, 'MCP client closed the session', false);
      },
    });
    const server = buildMcpServer(withSession(this.options.shared, context));
    const record: SessionRecord = { server, transport, kind, activeRequests: 0 };
    this.records.set(id, record);
    this.options.sessions.add(context);

    try {
      await server.connect(transport);
      if (this.stopping) {
        // connect 를 기다리는 사이 stop() 이 시작됐다. 이 세션은 stop() 이 이미 닫았을 수 있다.
        await this.destroySession(id, 'MCP daemon stopped', true);
        writeRpcError(res, 503, STOPPING_MESSAGE, -32000, { connection: 'close' });
        return;
      }
      await this.dispatch(record, id, req, res, parsedBody);
    } catch (error) {
      await this.destroySession(id, 'MCP initialization failed', true);
      throw error;
    }
  }

  private async dispatch(
    record: SessionRecord,
    sessionId: string,
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown,
  ): Promise<void> {
    // A standalone GET is a passive SSE notification stream and can remain open for the
    // whole session, so only an in-flight POST can block idle reaping. Relay and cli sessions
    // are refused that stream up front (see handleRequest), so this path is reached by GET
    // only for remote HTTP clients.
    const blocksIdleReaping = req.method === 'POST';
    if (blocksIdleReaping) {
      record.activeRequests += 1;
      this.inflight.add(res);
      res.once('close', () => this.forgetInflight(res));
      if (record.kind === 'cli') this.closeCliOnDisconnect(sessionId, res);
    }
    this.options.sessions.touch(sessionId);
    try {
      await record.transport.handleRequest(req, res, parsedBody);
    } finally {
      if (blocksIdleReaping) {
        record.activeRequests = Math.max(0, record.activeRequests - 1);
        this.forgetInflight(res);
      }
      this.options.sessions.touch(sessionId);
    }
  }

  /**
   * cli 가 응답을 받기 전에 연결을 끊으면 세션을 바로 닫는다.
   * 셸이 명령을 죽이면 프로세스와 함께 소켓이 닫히고, 그 뒤로 응답을 받을 쪽이 없다.
   * 세션을 닫아야 진행 중인 exec, 대기, lease 가 곧바로 풀린다.
   * relay 와 원격 HTTP 는 이 규칙을 쓰지 않는다. 지금처럼 유휴 만료나 DELETE 로 닫힌다.
   * stop() 은 세션 기록을 모두 지운 뒤에 503 을 쓰고 연결을 끊는다. 그 close 는 기록이 없어 여기서 넘어간다.
   * 유예 동안 cli 가 먼저 끊으면 여기서 세션을 닫는다. stop() 은 기록이 남은 세션만 닫으므로 두 번 닫지 않는다.
   * 멈추는 중이라 handleRequest 가 거절한 요청은 dispatch 에 오지 않으므로 끊김으로 세지 않는다.
   */
  private closeCliOnDisconnect(sessionId: string, res: ServerResponse): void {
    res.once('close', () => {
      if (res.writableFinished || !this.records.has(sessionId)) return;
      const shortId = this.options.sessions.get(sessionId)?.shortId ?? sessionId.slice(0, 8);
      log.info(`[mcp-daemon] cli session ${shortId} closed: client disconnected mid-request`);
      void this.destroySession(sessionId, 'cli client disconnected mid-request', true);
    });
  }

  private async destroySession(
    id: string,
    reason: string,
    closeServer: boolean,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    const session = this.options.sessions.remove(id);
    if (session && !session.abortController.signal.aborted) {
      session.abortController.abort(new Error(reason));
    }
    if (closeServer) {
      try {
        await record.server.close();
      } catch (error) {
        log.warn(`[mcp-daemon] failed to close session ${id}: ${String(error)}`);
      }
    }
  }
}
