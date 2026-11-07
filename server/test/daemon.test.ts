import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, type Config } from '../src/config.js';
import type { SharedDeps } from '../src/mcp/deps.js';
import {
  McpHttpDaemon,
  MCP_VERSION_HEADER,
  MCP_TRANSPORT_HEADER,
} from '../src/daemon/httpDaemon.js';
import { SessionRegistry } from '../src/daemon/sessionRegistry.js';
import { ensureMcpToken, loadMcpToken } from '../src/daemon/token.js';
import { createRelayFetch } from '../src/daemon/relayFetch.js';
import { isPortOpen, type DaemonHandle } from '../src/daemon/autostart.js';
import type { ExecOptions, ExecOutcome } from '../src/exec/execManager.js';
import { OperationCoordinator } from '../src/launch/operationCoordinator.js';
import { log } from '../src/log.js';
import { runRelay } from '../src/relay.js';
import { ARMA_MCP_VERSION } from '../src/version.js';

const TOKEN = '0123456789abcdef0123456789abcdef';
const here = path.dirname(fileURLToPath(import.meta.url));

function configFile(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-daemon-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

/**
 * relay 를 띄우는 테스트용 설정. token 파일 위치가 상태 폴더(=relay.log 위치)를 정하므로
 * 반드시 임시 경로로 격리한다 — 그러지 않으면 테스트가 사용자의 실제 로그에 기록한다.
 */
function relayConfigFile(mcp: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-relay-'));
  const file = path.join(dir, 'config.json');
  writeFileSync(
    file,
    JSON.stringify({
      web: { enabled: false },
      mcp: { tokenFile: path.join(dir, 'daemon.token'), ...mcp },
    }),
    'utf8',
  );
  return file;
}

function fakeShared(cfg: Config, sessions: SessionRegistry): SharedDeps {
  return {
    cfg,
    rptDir: '',
    rptSources: {
      resolve: () => ({ source: 'client', dir: '', re: /\.rpt$/i }),
    } as SharedDeps['rptSources'],
    gateway: {
      getListenerState: () => 'ok',
      isConnected: () => false,
      generation: () => 0,
    } as SharedDeps['gateway'],
    telemetry: {} as SharedDeps['telemetry'],
    exec: {} as SharedDeps['exec'],
    launcher: {} as SharedDeps['launcher'],
    mpLauncher: {} as SharedDeps['mpLauncher'],
    missionMarker: { cursor: () => null },
    web: {} as SharedDeps['web'],
    serverStartMs: Date.now(),
    sessions,
    operationCoordinator: new OperationCoordinator(),
  };
}

async function fixture(
  mcp: Record<string, unknown> = {},
  onShutdownRequested?: () => void | Promise<void>,
  options: {
    /** 도구를 실제로 부르는 테스트가 쓰는 공유 의존성. 비우면 fakeShared 다. */
    shared?: (cfg: Config, sessions: SessionRegistry) => SharedDeps;
    /** mcp 밖의 설정 조각. */
    config?: Record<string, unknown>;
  } = {},
): Promise<{
  cfg: Config;
  daemon: McpHttpDaemon;
  sessions: SessionRegistry;
  endpoint: URL;
}> {
  const cfg = loadConfig(
    configFile({
      web: { enabled: false },
      ...options.config,
      mcp: { allowedOrigins: ['https://allowed.example'], ...mcp },
    }),
  );
  const sessions = new SessionRegistry();
  const daemon = new McpHttpDaemon({
    cfg,
    shared: (options.shared ?? fakeShared)(cfg, sessions),
    sessions,
    token: TOKEN,
    port: 0,
    onShutdownRequested,
  });
  const address = await daemon.start();
  return {
    cfg,
    daemon,
    sessions,
    endpoint: new URL(`http://${address.host}:${address.port}${address.mcpPath}`),
  };
}

function directTransport(endpoint: URL): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
  });
}

async function reserveUnusedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('daemon config defaults and token resolution use env first, then the token file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-token-'));
  const tokenFile = path.join(dir, 'daemon.token');
  const cfg = loadConfig(configFile({ mcp: { tokenFile } }));
  assert.equal(cfg.mcp.port, 5303);
  assert.equal(cfg.mcp.path, '/mcp');
  assert.equal(cfg.mcp.maxSessions, 16);
  assert.equal(cfg.mcp.idleTimeoutMs, 30 * 60 * 1000);
  assert.equal(cfg.mcp.maxCliSessions, 8);
  assert.equal(cfg.mcp.cliIdleTimeoutMs, 60_000);
  assert.equal(cfg.mcp.maxBodyBytes, 6 * 1024 * 1024);

  delete process.env.ARMA_MCP_TOKEN;
  const generated = ensureMcpToken(cfg);
  assert.ok(Buffer.byteLength(generated, 'utf8') >= 32);
  assert.equal(loadMcpToken(cfg), generated);

  const envToken = 'fedcba9876543210fedcba9876543210';
  process.env.ARMA_MCP_TOKEN = envToken;
  try {
    assert.equal(loadMcpToken(cfg), envToken);
    assert.equal(ensureMcpToken(cfg), envToken);
  } finally {
    delete process.env.ARMA_MCP_TOKEN;
  }
});

async function rawStatus(url: URL, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'GET',
        headers,
      },
      (res) => {
        res.resume();
        res.once('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

test('daemon authenticates before body parsing and validates Host, Origin, and version', async () => {
  const { daemon, endpoint } = await fixture({ maxBodyBytes: 1024 });
  try {
    const health = new URL('/health', endpoint);

    const unauthorized = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'x'.repeat(1100) }),
    });
    assert.equal(unauthorized.status, 401, 'auth is evaluated before the body limit');

    assert.equal(
      await rawStatus(health, {
        authorization: `Bearer ${TOKEN}`,
        host: 'evil.example',
      }),
      421,
    );

    const badOrigin = await fetch(health, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'https://blocked.example',
      },
    });
    assert.equal(badOrigin.status, 403);

    const goodOrigin = await fetch(health, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: 'https://allowed.example',
      },
    });
    assert.equal(goodOrigin.status, 200);
    assert.equal(goodOrigin.headers.get(MCP_VERSION_HEADER), ARMA_MCP_VERSION);
    const healthBody = (await goodOrigin.json()) as { version?: unknown; pid?: unknown };
    assert.equal(healthBody.version, ARMA_MCP_VERSION);
    assert.equal(healthBody.pid, process.pid, 'health 는 업그레이드하는 relay 가 쓸 pid 를 알린다');

    const mismatch = await fetch(health, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-arma-mcp-client-version': '0.2.0',
      },
    });
    assert.equal(mismatch.status, 409);
    assert.match(await mismatch.text(), /restart the daemon explicitly/);

    const tooLarge = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: 'x'.repeat(1100) }),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await daemon.stop();
  }
});

test('릴레이에는 standalone SSE 스트림을 주지 않는다(405), 원격 HTTP 에는 준다', async () => {
  // 데몬은 서버 발신 메시지를 하나도 보내지 않는다. 릴레이가 여는 GET 스트림은
  // 아무것도 나르지 못한 채 undici 의 bodyTimeout 에 끊기고 SDK 가 영원히 재연결한다.
  // 405 면 SDK 가 "스트림 미제공"으로 보고 조용히 넘어간다.
  const { daemon, endpoint } = await fixture();
  try {
    const relayGet = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'text/event-stream',
        [MCP_TRANSPORT_HEADER]: 'relay',
      },
    });
    assert.equal(relayGet.status, 405);
    assert.equal(relayGet.headers.get('allow'), 'POST, DELETE');
    // 버전 헤더가 빠지면 릴레이의 버전 검사가 SDK 보다 먼저 예외를 던진다.
    assert.equal(
      relayGet.headers.get(MCP_VERSION_HEADER),
      ARMA_MCP_VERSION,
      '405 에도 버전 헤더가 실려야 릴레이가 이 응답을 우리 데몬의 것으로 인정한다',
    );

    // cli 도 스트림을 쓸 일이 없어 같은 405 를 받는다.
    const cliGet = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'text/event-stream',
        [MCP_TRANSPORT_HEADER]: 'cli',
      },
    });
    assert.equal(cliGet.status, 405);
    assert.equal(cliGet.headers.get('allow'), 'POST, DELETE');
    assert.equal(cliGet.headers.get(MCP_VERSION_HEADER), ARMA_MCP_VERSION);

    // relay 헤더가 없는 클라이언트(원격 HTTP)는 이 405 를 받지 않는다.
    const httpGet = await fetch(endpoint, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: 'text/event-stream',
      },
    });
    assert.notEqual(httpGet.status, 405, '원격 HTTP 클라이언트에는 GET 을 열어 둔다');
    await httpGet.body?.cancel();
  } finally {
    await daemon.stop();
  }
});

test('daemon gives each client an isolated session and DELETE leaves peers alive', async () => {
  const { daemon, endpoint, sessions } = await fixture();
  const transportA = directTransport(endpoint);
  const transportB = directTransport(endpoint);
  const clientA = new Client({ name: 'daemon-test-a', version: '1.0.0' });
  const clientB = new Client({ name: 'daemon-test-b', version: '1.0.0' });
  try {
    await clientA.connect(transportA);
    await clientB.connect(transportB);
    assert.notEqual(transportA.sessionId, transportB.sessionId);
    assert.equal(sessions.snapshot().total, 2);

    const toolsA = await clientA.listTools();
    const toolsB = await clientB.listTools();
    assert.ok(toolsA.tools.some((tool) => tool.name === 'arma_exec'));
    assert.ok(toolsB.tools.some((tool) => tool.name === 'arma_status'));

    await transportA.terminateSession();
    assert.equal(sessions.snapshot().total, 1);
    const stillAlive = await clientB.listTools();
    assert.ok(stillAlive.tools.length >= 15);
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await daemon.stop();
  }
});

test('authenticated shutdown endpoint is explicit and keeps daemon alive after mismatch', async () => {
  let shutdownRequests = 0;
  const { daemon, endpoint } = await fixture({}, () => {
    shutdownRequests += 1;
  });
  try {
    const health = new URL('/health', endpoint);
    const shutdown = new URL('/shutdown', endpoint);
    const mismatch = await fetch(health, {
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'x-arma-mcp-client-version': '9.9.9',
      },
    });
    assert.equal(mismatch.status, 409);
    assert.equal(
      (
        await fetch(health, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).status,
      200,
      'a version mismatch must not stop the daemon',
    );

    assert.equal((await fetch(shutdown, { method: 'POST' })).status, 401);
    const accepted = await fetch(shutdown, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(shutdownRequests, 1);
  } finally {
    await daemon.stop();
  }
});

/** arma_rpt_wait 가 실제로 기다릴 수 있게 RPT 폴더를 가진 데몬. */
async function daemonWithRptDir(
  stopGraceMs?: number,
): Promise<{ daemon: McpHttpDaemon; endpoint: URL; sessions: SessionRegistry }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-stop-'));
  writeFileSync(path.join(dir, 'Arma3_x64_2026-09-23_17-00-00.rpt'), '17:00:00 boot\r\n', 'utf8');
  const cfg = loadConfig(configFile({ web: { enabled: false } }));
  const sessions = new SessionRegistry();
  const shared = fakeShared(cfg, sessions);
  shared.rptSources = {
    resolve: () => ({ source: 'client', dir, re: /\.rpt$/i }),
  } as SharedDeps['rptSources'];
  const daemon = new McpHttpDaemon({ cfg, shared, sessions, token: TOKEN, port: 0, stopGraceMs });
  const address = await daemon.start();
  return {
    daemon,
    sessions,
    endpoint: new URL(`http://${address.host}:${address.port}${address.mcpPath}`),
  };
}

function waitCall(client: Client, timeoutMs: number): Promise<string> {
  return client
    .callTool(
      {
        name: 'arma_rpt_wait',
        arguments: { pattern: 'NEVER_WRITTEN', timeoutMs, fromEnd: true },
      },
      undefined,
      { timeout: 600_000 },
    )
    .then(
      (result) => 'answered ' + JSON.stringify(result.content),
      (error: unknown) => String((error as Error)?.message ?? error),
    );
}

test('daemon stop() answers an in-flight tool call whose session it closed', async () => {
  // 실측: 0.4.1 daemon 이 /shutdown 뒤 90초 넘게 게임 파이프를 쥔 채 남았다. 닫힌 세션의
  // 진행 중 POST 는 응답을 받지 못하고, server.close() 가 그 연결을 끝없이 기다렸다.
  const GRACE_MS = 500;
  const { daemon, endpoint } = await daemonWithRptDir(GRACE_MS);
  const client = new Client({ name: 'daemon-stop-test', version: '1.0.0' });
  let stopped = false;
  try {
    await client.connect(directTransport(endpoint));
    const call = waitCall(client, 600_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const startedAt = Date.now();
    await Promise.race([daemon.stop(), rejectAfter(5000, 'stop() did not finish')]);
    stopped = true;
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= GRACE_MS - 50 && elapsed < GRACE_MS + 1000,
      `유예만큼 기다린 뒤 진행 중 호출을 끊는다 (실제 ${elapsed}ms)`,
    );
    const outcome = await Promise.race([call, rejectAfter(2000, 'the in-flight call did not settle')]);
    assert.match(outcome, /daemon stopped before this request finished.*may or may not have run/);
  } finally {
    await client.close().catch(() => undefined);
    if (!stopped) await daemon.stop();
  }
});

test('daemon stop() 은 유예 안에 끝난 진행 중 호출에 실제 결과로 답한다', async () => {
  // 게임에서 이미 실행된 SQF 의 결과가 곧 올 호출을 "실행됐는지 모름" 으로 끊으면 에이전트가 판단할 수 없다.
  const { daemon, endpoint } = await daemonWithRptDir();
  const client = new Client({ name: 'daemon-stop-grace-test', version: '1.0.0' });
  let stopped = false;
  try {
    await client.connect(directTransport(endpoint));
    // 700ms 뒤 타임아웃 결과로 끝나는 호출. stop() 의 유예(2초) 안이다.
    const call = waitCall(client, 700);
    await new Promise((resolve) => setTimeout(resolve, 150));

    const startedAt = Date.now();
    await Promise.race([daemon.stop(), rejectAfter(5000, 'stop() did not finish')]);
    stopped = true;
    const elapsed = Date.now() - startedAt;
    const outcome = await Promise.race([call, rejectAfter(2000, 'the in-flight call did not settle')]);
    assert.match(outcome, /^answered /, outcome);
    assert.ok(elapsed < 1500, `호출이 끝나면 유예를 다 쓰지 않고 끝난다 (실제 ${elapsed}ms)`);
  } finally {
    await client.close().catch(() => undefined);
    if (!stopped) await daemon.stop();
  }
});

test('daemon stop() 중에 들어온 요청은 세션을 만들지 않고 실행하지 않았다고 503 으로 답한다', async () => {
  const { daemon, endpoint, sessions } = await fixture();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'daemon-stopping-test', version: '1.0.0' },
    },
  });
  const request = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.pathname,
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': String(Buffer.byteLength(body)),
    },
  });
  const answered = new Promise<{ status: number; text: string }>((resolve, reject) => {
    request.once('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    request.once('error', reject);
  });
  // 본문을 읽는 도중에 stop() 이 시작되는 상황.
  request.write(body.slice(0, 10));
  let stopping: Promise<void> | null = null;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stopping = daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    request.end(body.slice(10));
    const reply = await Promise.race([answered, rejectAfter(3000, 'no answer while stopping')]);
    assert.equal(reply.status, 503);
    assert.match(reply.text, /daemon is stopping; this request was not run/);
    assert.equal(sessions.size(), 0, '멈추는 중에는 세션을 만들지 않는다');
  } finally {
    request.destroy();
    await (stopping ?? daemon.stop());
  }
});

test('daemon stop() force-closes a connection that never finishes its request', async () => {
  // 본문을 다 보내지 않은 요청은 세션에 닿지 못해 stop() 이 대신 답할 수도 없다.
  // 유예(2초)가 지나면 연결을 끊고 끝나야 한다.
  const { daemon, endpoint } = await fixture();
  const request = http.request({
    hostname: endpoint.hostname,
    port: endpoint.port,
    path: endpoint.pathname,
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'content-length': '1000',
    },
  });
  const settled = new Promise<string>((resolve) => {
    request.once('response', (res) => {
      res.resume();
      resolve(`status ${res.statusCode}`);
    });
    request.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
  request.write('{"jsonrpc":');
  let stopped = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const startedAt = Date.now();
    await Promise.race([daemon.stop(), rejectAfter(5000, 'stop() did not finish')]);
    stopped = true;
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed >= 1500 && elapsed < 2500,
      `유예 뒤에 연결을 끊는다 (실제 ${elapsed}ms)`,
    );
    assert.equal(
      await Promise.race([settled, rejectAfter(2000, 'the stuck request did not settle')]),
      'ECONNRESET',
    );
  } finally {
    request.destroy();
    if (!stopped) await daemon.stop();
  }
});

test('daemon enforces max sessions and reaps only inactive idle sessions', async () => {
  const { daemon, endpoint, sessions } = await fixture({
    maxSessions: 1,
    idleTimeoutMs: 1000,
  });
  const transportA = directTransport(endpoint);
  const transportB = directTransport(endpoint);
  const clientA = new Client({ name: 'daemon-limit-a', version: '1.0.0' });
  const clientB = new Client({ name: 'daemon-limit-b', version: '1.0.0' });
  try {
    await clientA.connect(transportA);
    await assert.rejects(clientB.connect(transportB), /429|Maximum MCP session/);
    const session = sessions.get(transportA.sessionId!);
    assert.ok(session);
    await new Promise((resolve) => setTimeout(resolve, 25));
    session.lastActivityAt = 1;
    assert.equal(await daemon.sweepIdleSessions(Date.now()), 1);
    assert.equal(sessions.snapshot().total, 0);
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await daemon.stop();
  }
});

test('two stdio relays and one direct client share one daemon and close independently', async () => {
  const { daemon, endpoint, sessions } = await fixture();
  const relayConfig = relayConfigFile({
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  const makeRelay = (): StdioClientTransport =>
    new StdioClientTransport({
      command: process.execPath,
      args: [
        '--import',
        'tsx',
        path.join(here, '..', 'src', 'index.ts'),
        'relay',
      ],
      cwd: path.join(here, '..'),
      env: {
        ...process.env,
        ARMA_MCP_CONFIG: relayConfig,
        ARMA_MCP_TOKEN: TOKEN,
      },
    });
  const relayA = makeRelay();
  const relayB = makeRelay();
  const direct = directTransport(endpoint);
  const clientA = new Client({ name: 'relay-test-a', version: '1.0.0' });
  const clientB = new Client({ name: 'relay-test-b', version: '1.0.0' });
  const directClient = new Client({ name: 'direct-test', version: '1.0.0' });
  try {
    await Promise.all([
      clientA.connect(relayA),
      clientB.connect(relayB),
      directClient.connect(direct),
    ]);
    const relayPids = [relayA.pid, relayB.pid];
    assert.ok(relayPids.every((pid) => pid && pid > 0));
    assert.deepEqual(sessions.snapshot().byTransport, {
      relay: 2,
      'remote-http': 1,
      standalone: 0,
      cli: 0,
    });
    const tools = await clientA.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'arma_exec'));
    await clientA.close();

    const deadline = Date.now() + 2000;
    while (sessions.snapshot().total > 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(sessions.snapshot().total, 2);
    assert.ok((await clientB.listTools()).tools.length >= 16);
    assert.ok((await directClient.listTools()).tools.length >= 16);
    assert.throws(
      () => process.kill(relayPids[0]!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      'closed relay child process must exit',
    );

    await clientB.close();
    await direct.terminateSession();
    await directClient.close();
    assert.equal(sessions.snapshot().total, 0);
    assert.throws(
      () => process.kill(relayPids[1]!, 0),
      (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
      'second relay child process must exit',
    );
  } finally {
    await clientA.close().catch(() => undefined);
    await clientB.close().catch(() => undefined);
    await directClient.close().catch(() => undefined);
    await daemon.stop();
  }
});

test('relay reports an unavailable daemon with remediation and then exits', async () => {
  const port = await reserveUnusedPort();
  const relayConfig = relayConfigFile({ port });
  const relay = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, '..', 'src', 'index.ts'), 'relay'],
    cwd: path.join(here, '..'),
    env: {
      ...process.env,
      ARMA_MCP_CONFIG: relayConfig,
      ARMA_MCP_TOKEN: TOKEN,
    },
  });
  const response = new Promise<Record<string, unknown>>((resolve) => {
    relay.onmessage = (message) => resolve(message as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => {
    relay.onclose = resolve;
  });
  await relay.start();
  const pid = relay.pid;
  assert.ok(pid && pid > 0);
  await relay.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'relay-unavailable-test', version: '1.0.0' },
    },
  });
  const failure = await Promise.race([
    response,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('relay did not fail within 3 seconds')), 3000),
    ),
  ]);
  assert.match(
    String((failure.error as { message?: unknown } | undefined)?.message),
    /Start the daemon.*token\/config.*SSH tunnel/i,
  );
  await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('relay did not exit within 2 seconds')), 2000),
    ),
  ]);

  const deadline = Date.now() + 2000;
  let exited = false;
  while (!exited && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      exited = (error as NodeJS.ErrnoException).code === 'ESRCH';
      if (!exited) throw error;
    }
  }
  assert.equal(exited, true, 'relay process should exit after a terminal daemon request failure');
});

test('relay without a daemon token answers initialize with remediation and exits', async () => {
  const port = await reserveUnusedPort();
  const relayConfig = configFile({ web: { enabled: false }, mcp: { port } });
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ARMA_MCP_TOKEN;
  env.ARMA_MCP_CONFIG = relayConfig;
  // 자동 기동은 autostart.test.ts 가 다룬다. 여기서는 보고·종료 계약만 본다.
  env.ARMA_MCP_NO_AUTOSTART = '1';
  env.ARMA_MCP_TOKEN_FILE = path.join(
    mkdtempSync(path.join(tmpdir(), 'arma-mcp-notoken-')),
    'daemon.token',
  );
  const relay = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, '..', 'src', 'index.ts'), 'relay'],
    cwd: path.join(here, '..'),
    env,
  });
  const response = new Promise<Record<string, unknown>>((resolve) => {
    relay.onmessage = (message) => resolve(message as Record<string, unknown>);
  });
  const closed = new Promise<void>((resolve) => {
    relay.onclose = resolve;
  });
  await relay.start();
  const pid = relay.pid;
  assert.ok(pid && pid > 0);
  await relay.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'relay-no-token-test', version: '1.0.0' },
    },
  });
  const failure = await Promise.race([
    response,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('relay did not fail within 3 seconds')), 3000),
    ),
  ]);
  assert.match(
    String((failure.error as { message?: unknown } | undefined)?.message),
    /could not start.*token not found.*ARMA_MCP_TOKEN/is,
  );
  await Promise.race([
    closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('relay did not exit within 2 seconds')), 2000),
    ),
  ]);

  const deadline = Date.now() + 2000;
  let exited = false;
  while (!exited && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      exited = (error as NodeJS.ErrnoException).code === 'ESRCH';
      if (!exited) throw error;
    }
  }
  assert.equal(exited, true, 'relay process should exit after reporting a startup failure');
});

const RELAY_ARGS = ['--import', 'tsx', path.join(here, '..', 'src', 'index.ts'), 'relay'];

function relayEnv(relayConfig: string): NodeJS.ProcessEnv {
  return { ...process.env, ARMA_MCP_CONFIG: relayConfig, ARMA_MCP_TOKEN: TOKEN };
}

function rejectAfter(ms: number, what: string): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms),
  );
}

test('relay keeps the session when the host writes initialize and follow-ups in one burst', async () => {
  const { daemon, endpoint } = await fixture();
  const relayConfig = relayConfigFile({
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  const child = spawn(process.execPath, RELAY_ARGS, {
    cwd: path.join(here, '..'),
    env: relayEnv(relayConfig),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const responses = new Map<number, Record<string, unknown>>();
    let buffer = '';
    const bothAnswered = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (;;) {
          const index = buffer.indexOf('\n');
          if (index < 0) break;
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          const message = JSON.parse(line) as Record<string, unknown>;
          if (typeof message.id === 'number') responses.set(message.id, message);
        }
        if (responses.has(1) && responses.has(2)) resolve();
      });
    });

    // 세션 ID 는 initialize 응답 헤더에서만 채워진다. 릴레이가 이 세 줄을 병렬로
    // POST 하면 뒤 두 개가 세션 없이 나가고 데몬이 400 으로 거절한다.
    child.stdin.write(
      [
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'relay-burst-test', version: '1.0.0' },
          },
        }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ].join('\n') + '\n',
    );

    await Promise.race([bothAnswered, rejectAfter(10_000, 'relay did not answer both requests')]);
    assert.equal(responses.get(1)?.error, undefined, 'initialize must succeed');
    const toolsReply = responses.get(2)!;
    assert.equal(
      toolsReply.error,
      undefined,
      `tools/list must not be rejected: ${JSON.stringify(toolsReply.error)}`,
    );
    const tools = (toolsReply.result as { tools?: unknown[] } | undefined)?.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0);
    // 세션 복구가 결함을 덮어서는 안 된다. 경쟁 자체가 일어나지 않아야 한다.
    assert.doesNotMatch(
      stderr,
      /A valid MCP session ID/,
      'no message may reach the daemon before the session exists',
    );
    assert.doesNotMatch(stderr, /recovering|re-establish/, 'no recovery should be needed');
  } finally {
    child.kill();
    await daemon.stop();
  }
});

test('relay 는 initialize 전의 server/discover 탐색에 직접 답하고 같은 연결에서 세션을 연다', async () => {
  const { daemon, endpoint, sessions } = await fixture();
  const relayCfg = loadConfig(
    relayConfigFile({ port: Number(endpoint.port), path: endpoint.pathname }),
  );
  const io = relayIo();
  const relay = runRelay(relayCfg, {
    stdin: io.stdin,
    stdout: io.stdout,
    selfUpdate: () => undefined,
    ensureDaemon: async (): Promise<DaemonHandle> => ({ token: TOKEN, started: false }),
  });
  try {
    // 2026-07-28 프로토콜을 아는 클라이언트가 initialize 전에 보내는 탐색이다.
    io.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
    });
    const discover = await io.reply(1);
    assert.equal((discover.error as { code?: number } | undefined)?.code, -32601);
    io.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.deepEqual((await io.reply(2)).result, {});
    assert.equal(sessions.snapshot().total, 0, '탐색은 데몬 세션을 만들지 않는다');

    io.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'relay-discover-test', version: '1.0.0' },
      },
    });
    assert.equal((await io.reply(3)).error, undefined, 'initialize must succeed');
    io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.ok(toolCount(await listToolsVia(io, 4)) > 0);
    assert.equal(sessions.snapshot().total, 1);
  } finally {
    io.stdin.end();
    await withTimeout(relay, 5000, 'relay did not close').catch(() => undefined);
    await daemon.stop();
  }
});

test('relay re-establishes a daemon session that was reaped while idle', async () => {
  // 운영에서는 mcp.idleTimeoutMs 기본 30분이 이 역할을 한다. 릴레이는 keepalive 를
  // 보내지 않으므로 유휴 세션은 반드시 수확되고, 그 다음 요청이 404 를 맞는다.
  const { daemon, endpoint, sessions } = await fixture({ idleTimeoutMs: 1000 });
  const relayConfig = relayConfigFile({
    port: Number(endpoint.port),
    path: endpoint.pathname,
  });
  const relay = new StdioClientTransport({
    command: process.execPath,
    args: RELAY_ARGS,
    cwd: path.join(here, '..'),
    env: relayEnv(relayConfig),
  });
  const client = new Client({ name: 'relay-idle-test', version: '1.0.0' });
  try {
    await client.connect(relay);
    const pid = relay.pid;
    assert.ok(pid && pid > 0);
    assert.equal(sessions.snapshot().total, 1);

    const deadline = Date.now() + 8000;
    while (sessions.snapshot().total > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(sessions.snapshot().total, 0, 'daemon must reap the idle session');

    const tools = await Promise.race([
      client.listTools(),
      rejectAfter(10_000, 'relay did not recover the session'),
    ]);
    assert.ok(tools.tools.length > 0);
    assert.equal(sessions.snapshot().total, 1, 'relay must have opened a fresh session');
    assert.doesNotThrow(
      () => process.kill(pid, 0),
      'relay process must survive a reaped session',
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.stop();
  }
});

// ---------------------------------------------------------------- cli 세션
//
// cli 는 명령 하나를 처리하고 끝나는 짧은 세션이다. 데몬은 따로 세고, 짧게 치우고,
// 호출 도중 연결이 끊기면 바로 닫아 대기와 lease 를 푼다.

const INITIALIZE_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'daemon-cli-test', version: '1.0.0' },
  },
};

/** SDK 없이 initialize 하나만 보낸다. 상한과 청소 테스트는 세션만 있으면 된다. */
async function rawInitialize(
  endpoint: URL,
  kind?: 'relay' | 'cli',
): Promise<{ status: number; text: string; sessionId: string | null }> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(kind ? { [MCP_TRANSPORT_HEADER]: kind } : {}),
    },
    body: JSON.stringify(INITIALIZE_BODY),
  });
  return {
    status: response.status,
    text: await response.text(),
    sessionId: response.headers.get('mcp-session-id'),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${ms}ms`);
    await sleep(20);
  }
}

/** CLI 가 쓰는 연결 모양. agent 를 직접 쥐고 있어야 프로세스 종료처럼 소켓을 끊을 수 있다. */
function agentTransport(
  endpoint: URL,
  agent: http.Agent,
  kind: 'relay' | 'cli',
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(endpoint, {
    fetch: createRelayFetch({ agent }),
    requestInit: {
      headers: { authorization: `Bearer ${TOKEN}`, [MCP_TRANSPORT_HEADER]: kind },
    },
  });
}

/**
 * 유휴 keep-alive 소켓을 닫아 다음 요청이 새 연결을 쓰게 한다.
 * 재사용 소켓에서 끊긴 요청은 relayFetch 가 한 번 다시 보낸다. 프로세스가 죽는 실제 상황에는
 * 다시 보낼 쪽이 없으므로, 끊김 테스트는 새 연결에서 끊어 그 재시도를 빼고 본다.
 */
async function dropIdleSockets(agent: http.Agent): Promise<void> {
  // SDK 가 연결 직후 따로 보내는 GET(405)이 끝나 소켓을 돌려놓을 때까지 기다린다.
  await until(
    () => Object.values(agent.sockets).flat().length === 0,
    2000,
    'agent still has requests in flight',
  );
  for (const sockets of Object.values(agent.freeSockets)) {
    for (const socket of sockets ?? []) socket.destroy();
  }
}

interface ToolProbe {
  /** arma_status 의 준비 대기가 게이트웨이 연결을 물은 횟수. 폴링이 멈췄는지 이 값으로 본다. */
  readinessChecks: number;
  /** arma_exec 가 exec 에 넘긴 취소 신호. */
  execSignals: AbortSignal[];
}

const CANCELLED_EXEC: ExecOutcome = {
  ok: false,
  error: 'client session closed',
  timedOut: false,
  completedBy: 'cancelled',
  durationMs: 0,
  reqId: '',
  results: [],
  rptErrors: [],
  rptCursor: null,
  sanitized: false,
};

/**
 * 게임이 붙지 않은 데몬의 공유 의존성. arma_status 의 waitFor 는 타임아웃까지 폴링하고,
 * arma_exec 는 취소될 때까지 결과를 주지 않는다.
 */
function waitingShared(probe: ToolProbe): (cfg: Config, sessions: SessionRegistry) => SharedDeps {
  return (cfg, sessions) => ({
    ...fakeShared(cfg, sessions),
    gateway: {
      getListenerState: () => 'ok',
      isConnected: () => {
        probe.readinessChecks += 1;
        return false;
      },
      generation: () => 0,
      sessionInfoReceived: () => false,
      send: () => false,
      linkPhase: () => 'none',
      connectedVia: () => '',
      connectedForMs: () => 0,
      lastFrameAgeMs: () => -1,
    } as unknown as SharedDeps['gateway'],
    telemetry: {
      current: () => ({ world: '', mission: '', dedicated: false, receivedAt: 0 }),
      ace: () => false,
      aceVersion: () => '',
      aceComponents: () => [],
      tacmap: () => null,
      tacmapZeusTool: () => null,
      dllVersion: () => '',
      cba: () => false,
      cacheAgeMs: () => -1,
    } as unknown as SharedDeps['telemetry'],
    exec: {
      pendingCount: () => 0,
      run: (opts: ExecOptions) =>
        new Promise<ExecOutcome>((resolve, reject) => {
          const signal = opts.context?.signal;
          if (!signal) {
            reject(new Error('arma_exec must pass a cancellation signal'));
            return;
          }
          probe.execSignals.push(signal);
          signal.addEventListener('abort', () => resolve(CANCELLED_EXEC), { once: true });
        }),
    } as unknown as SharedDeps['exec'],
    web: { statusInfo: () => ({ state: 'disabled' }) } as unknown as SharedDeps['web'],
  });
}

async function toolFixture(probe: ToolProbe): ReturnType<typeof fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-daemon-tools-'));
  return fixture({}, undefined, {
    shared: waitingShared(probe),
    // 사용자의 프로필 파일을 읽지 않게 격리한다.
    config: { arma: { profilesFile: path.join(dir, 'launch-profiles.json') } },
  });
}

/** 취소된 arma_status 가 더는 폴링하지 않는지 본다. 폴링 주기는 100ms 다. */
async function assertPollingStopped(probe: ToolProbe): Promise<void> {
  // 대기가 멈춘 뒤 본문이 준비 상태를 한 번 더 읽는다. 그 한 번은 봐준다.
  await sleep(300);
  const before = probe.readinessChecks;
  await sleep(600);
  assert.ok(
    probe.readinessChecks - before <= 1,
    `arma_status kept polling after it was aborted (${probe.readinessChecks - before} checks)`,
  );
}

test('cli 세션은 따로 세고 relay 상한과 다른 자기 상한을 쓴다', async () => {
  const { daemon, endpoint, sessions } = await fixture({ maxSessions: 1, maxCliSessions: 1 });
  try {
    assert.equal((await rawInitialize(endpoint, 'relay')).status, 200);
    const relayFull = await rawInitialize(endpoint, 'relay');
    assert.equal(relayFull.status, 429);
    assert.match(relayFull.text, /mcp\.maxSessions=1/);

    // relay 자리가 다 찼어도 cli 는 자기 자리로 붙는다.
    const cli = await rawInitialize(endpoint, 'cli');
    assert.equal(cli.status, 200);
    assert.ok(cli.sessionId);
    const cliFull = await rawInitialize(endpoint, 'cli');
    assert.equal(cliFull.status, 429);
    assert.match(cliFull.text, /mcp\.maxCliSessions=1/);

    // 원격 HTTP 는 지금처럼 relay 와 같은 상한을 함께 쓴다.
    const remoteFull = await rawInitialize(endpoint);
    assert.equal(remoteFull.status, 429);
    assert.match(remoteFull.text, /mcp\.maxSessions=1/);

    assert.deepEqual(sessions.snapshot().byTransport, {
      relay: 1,
      'remote-http': 0,
      standalone: 0,
      cli: 1,
    });
    assert.equal(sessions.get(cli.sessionId!)?.transport, 'cli');
  } finally {
    await daemon.stop();
  }
});

test('cli 세션은 짧은 유휴 만료로 치우고 relay 세션은 남긴다', async () => {
  // 청소 주기가 relay 만료(60초)를 따랐다면 몇 초 안에 cli 세션을 치우지 못한다.
  const { daemon, endpoint, sessions } = await fixture({
    idleTimeoutMs: 60_000,
    cliIdleTimeoutMs: 1000,
  });
  try {
    const relay = await rawInitialize(endpoint, 'relay');
    const cli = await rawInitialize(endpoint, 'cli');
    assert.equal(relay.status, 200);
    assert.equal(cli.status, 200);
    assert.equal(sessions.snapshot().byTransport.cli, 1);

    await until(
      () => sessions.snapshot().byTransport.cli === 0,
      4000,
      'daemon did not reap the idle cli session',
    );
    assert.equal(sessions.snapshot().byTransport.relay, 1);
    assert.equal(
      await daemon.sweepIdleSessions(Date.now() + 30_000),
      0,
      'relay 세션은 relay 만료를 따른다',
    );
    assert.ok(sessions.get(relay.sessionId!));
  } finally {
    await daemon.stop();
  }
});

test('cli 가 호출 도중 연결을 끊으면 세션을 닫고 대기를 멈춘다', async () => {
  const probe: ToolProbe = { readinessChecks: 0, execSignals: [] };
  const { daemon, endpoint, sessions } = await toolFixture(probe);
  const infoLines: string[] = [];
  const originalInfo = log.info;
  log.info = (...args: unknown[]) => {
    infoLines.push(args.map(String).join(' '));
  };
  const agent = new http.Agent({ keepAlive: true });
  const client = new Client({ name: 'cli-disconnect-test', version: '1.0.0' });
  try {
    await client.connect(agentTransport(endpoint, agent, 'cli'));
    assert.equal(sessions.snapshot().byTransport.cli, 1);
    const session = [...sessions.values()][0]!;
    await dropIdleSockets(agent);

    const settled = client
      .callTool(
        { name: 'arma_status', arguments: { waitFor: 'game', timeoutMs: 30_000 } },
        undefined,
        { timeout: 60_000 },
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await until(() => probe.readinessChecks >= 3, 3000, 'arma_status did not start polling');

    // 셸이 CLI 프로세스를 죽이면 소켓이 이렇게 닫힌다.
    agent.destroy();
    await until(() => sessions.snapshot().total === 0, 2000, 'daemon did not close the cli session');
    assert.equal(session.abortController.signal.aborted, true, 'the session signal must abort');
    assert.equal(await settled, 'rejected');
    await assertPollingStopped(probe);
    assert.ok(
      infoLines.some((line) =>
        line.includes(
          `[mcp-daemon] cli session ${session.shortId} closed: client disconnected mid-request`,
        ),
      ),
      `missing disconnect log line: ${JSON.stringify(infoLines)}`,
    );
  } finally {
    log.info = originalInfo;
    agent.destroy();
    await client.close().catch(() => undefined);
    await daemon.stop();
  }
});

test('daemon stop() 이 끊은 cli 호출과 멈추는 중에 거절한 cli 요청은 끊김으로 세지 않는다', async () => {
  // stop() 은 세션을 지운 뒤에 503 을 쓰고 연결을 닫는다. cli 끊김 규칙이 그 close 를
  // 클라이언트 끊김으로 읽고 세션을 두 번 닫거나 끊김 로그를 남기면 안 된다.
  const GRACE_MS = 500;
  const { daemon, endpoint, sessions } = await daemonWithRptDir(GRACE_MS);
  const infoLines: string[] = [];
  const originalInfo = log.info;
  log.info = (...args: unknown[]) => {
    infoLines.push(args.map(String).join(' '));
  };
  const agent = new http.Agent({ keepAlive: true });
  const client = new Client({ name: 'cli-stop-test', version: '1.0.0' });
  let request: http.ClientRequest | null = null;
  let stopping: Promise<void> | null = null;
  try {
    await client.connect(agentTransport(endpoint, agent, 'cli'));
    const late = await rawInitialize(endpoint, 'cli');
    assert.equal(late.status, 200, late.text);
    assert.ok(late.sessionId);
    assert.equal(sessions.snapshot().byTransport.cli, 2);

    const call = waitCall(client, 600_000);
    await sleep(300);

    // 이미 열린 cli 세션으로 가는 요청. 본문을 읽는 도중에 stop() 이 시작된다.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const pending = http.request({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(Buffer.byteLength(body)),
        'mcp-session-id': late.sessionId,
        [MCP_TRANSPORT_HEADER]: 'cli',
      },
    });
    request = pending;
    const answered = new Promise<{ status: number; text: string }>((resolve, reject) => {
      pending.once('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
      });
      pending.once('error', reject);
    });
    pending.write(body.slice(0, 10));
    await sleep(100);

    stopping = daemon.stop();
    await sleep(50);
    pending.end(body.slice(10));
    const rejected = await withTimeout(answered, 3000, 'no answer while stopping');
    assert.equal(rejected.status, 503);
    assert.match(rejected.text, /daemon is stopping; this request was not run/);

    await withTimeout(stopping, 5000, 'stop() did not finish');
    const outcome = await withTimeout(call, 2000, 'the in-flight cli call did not settle');
    assert.match(outcome, /daemon stopped before this request finished.*may or may not have run/);
    assert.equal(sessions.size(), 0);
    assert.ok(
      !infoLines.some((line) => line.includes('client disconnected mid-request')),
      `stop() must not look like a cli disconnect: ${JSON.stringify(infoLines)}`,
    );
  } finally {
    log.info = originalInfo;
    request?.destroy();
    agent.destroy();
    await client.close().catch(() => undefined);
    await (stopping ?? daemon.stop());
  }
});

test('relay 가 호출 도중 연결을 끊어도 세션은 지금처럼 남는다', async () => {
  const probe: ToolProbe = { readinessChecks: 0, execSignals: [] };
  const { daemon, endpoint, sessions } = await toolFixture(probe);
  const agent = new http.Agent({ keepAlive: true });
  const client = new Client({ name: 'relay-disconnect-test', version: '1.0.0' });
  try {
    await client.connect(agentTransport(endpoint, agent, 'relay'));
    await dropIdleSockets(agent);
    const settled = client
      .callTool(
        { name: 'arma_status', arguments: { waitFor: 'game', timeoutMs: 1500 } },
        undefined,
        { timeout: 60_000 },
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await until(() => probe.readinessChecks >= 3, 3000, 'arma_status did not start polling');
    agent.destroy();
    assert.equal(await settled, 'rejected');
    await sleep(300);
    assert.equal(sessions.snapshot().byTransport.relay, 1, 'relay sessions keep their lifetime');
  } finally {
    agent.destroy();
    await client.close().catch(() => undefined);
    await daemon.stop();
  }
});

test('호출 하나를 취소하면 그 도구만 멈추고 세션은 남는다', async () => {
  const probe: ToolProbe = { readinessChecks: 0, execSignals: [] };
  const { daemon, endpoint, sessions } = await toolFixture(probe);
  const client = new Client({ name: 'request-cancel-test', version: '1.0.0' });
  try {
    await client.connect(directTransport(endpoint));
    const session = [...sessions.values()][0]!;

    // SDK 는 취소할 때 POST 를 열어 둔 채 notifications/cancelled 만 보낸다.
    const statusCancel = new AbortController();
    const status = client
      .callTool(
        { name: 'arma_status', arguments: { waitFor: 'game', timeoutMs: 30_000 } },
        undefined,
        { signal: statusCancel.signal, timeout: 60_000 },
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await until(() => probe.readinessChecks >= 3, 3000, 'arma_status did not start polling');
    statusCancel.abort();
    assert.equal(await status, 'rejected');
    await assertPollingStopped(probe);

    const execCancel = new AbortController();
    const exec = client
      .callTool({ name: 'arma_exec', arguments: { code: 'sleep 60; 1' } }, undefined, {
        signal: execCancel.signal,
        timeout: 60_000,
      })
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await until(() => probe.execSignals.length === 1, 3000, 'arma_exec did not reach exec');
    assert.equal(probe.execSignals[0]!.aborted, false);
    execCancel.abort();
    assert.equal(await exec, 'rejected');
    await until(
      () => probe.execSignals[0]!.aborted,
      2000,
      'the request cancel did not reach the exec signal',
    );

    assert.equal(session.abortController.signal.aborted, false, 'the session stays open');
    assert.equal(sessions.snapshot().total, 1);
    assert.ok((await client.listTools()).tools.length > 0, 'the session is still usable');
  } finally {
    await client.close().catch(() => undefined);
    await daemon.stop();
  }
});

// ── lease 를 쥔 도구의 끊김과 취소 ─────────────────────
//
// arma_play, arma_launch, arma_kill 은 실행 lease 를 쥔 채 기다린다. 끊긴 cli 나 취소된 호출이
// lease 를 쥔 채 남으면 다음 kill 과 play 가 종료 코드 4 로 막힌다.

const LEASE_TOOLS = ['arma_play', 'arma_launch', 'arma_kill'] as const;

interface LeaseProbe extends ToolProbe {
  coordinator: OperationCoordinator;
  /** 대기에 들어간 도구 이름. 들어간 차례대로 쌓인다. */
  started: string[];
}

function leaseProbe(): LeaseProbe {
  return { readinessChecks: 0, execSignals: [], coordinator: new OperationCoordinator(), started: [] };
}

/** lease 를 쥔 도구가 취소 신호가 걸릴 때까지 돌아오지 않는 공유 의존성. */
function leaseShared(probe: LeaseProbe): (cfg: Config, sessions: SessionRegistry) => SharedDeps {
  return (cfg, sessions) => {
    const hold = (name: string, signal: AbortSignal | undefined): Promise<void> =>
      new Promise((resolve, reject) => {
        if (!signal) {
          reject(new Error(`${name} must pass a cancellation signal`));
          return;
        }
        probe.started.push(name);
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    return {
      ...waitingShared(probe)(cfg, sessions),
      operationCoordinator: probe.coordinator,
      launcher: {
        launch: async (opts: { signal?: AbortSignal }) => {
          await hold('arma_launch', opts.signal);
          return { ok: false, error: 'aborted' };
        },
      } as unknown as SharedDeps['launcher'],
      mpLauncher: {
        killMp: async (_target: string, opts: { signal?: AbortSignal }) => {
          await hold('arma_kill', opts.signal);
          return {};
        },
      } as unknown as SharedDeps['mpLauncher'],
      playOrchestrator: {
        play: async (_opts: unknown, signal?: AbortSignal) => {
          await hold('arma_play', signal);
          // dryRun 결과로 돌려 뒤처리(ready, then, RPT 요약)를 건너뛴다.
          return {
            ok: false,
            dryRun: true,
            mode: 'sp',
            phase: 'mission',
            error: 'aborted',
            steps: [],
            warnings: [],
            totalMs: 0,
          };
        },
      } as unknown as SharedDeps['playOrchestrator'],
    };
  };
}

async function leaseFixture(probe: LeaseProbe): ReturnType<typeof fixture> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-daemon-lease-'));
  return fixture({}, undefined, {
    shared: leaseShared(probe),
    config: { arma: { profilesFile: path.join(dir, 'launch-profiles.json') } },
  });
}

test('cli 가 lease 를 쥔 호출 도중 끊기면 2초 안에 lease 를 푼다', async () => {
  const probe = leaseProbe();
  const { daemon, endpoint, sessions } = await leaseFixture(probe);
  try {
    for (const tool of LEASE_TOOLS) {
      const agent = new http.Agent({ keepAlive: true });
      const client = new Client({ name: `cli-lease-${tool}`, version: '1.0.0' });
      try {
        await client.connect(agentTransport(endpoint, agent, 'cli'));
        await dropIdleSockets(agent);
        const settled = client
          .callTool({ name: tool, arguments: {} }, undefined, { timeout: 60_000 })
          .then(
            () => 'resolved',
            () => 'rejected',
          );
        await until(() => probe.started.includes(tool), 3000, `${tool} did not start waiting`);
        const held = probe.coordinator.snapshot();
        assert.equal(held?.operation, tool);
        assert.equal(held?.owner?.transport, 'cli');

        // 셸이 CLI 프로세스를 죽이면 소켓이 이렇게 닫힌다.
        agent.destroy();
        await until(
          () => probe.coordinator.snapshot() === null,
          2000,
          `${tool} kept the lease after the cli disconnected`,
        );
        await until(() => sessions.snapshot().total === 0, 2000, 'the cli session was not closed');
        assert.equal(await settled, 'rejected');
      } finally {
        agent.destroy();
        await client.close().catch(() => undefined);
      }
    }
  } finally {
    await daemon.stop();
  }
});

test('relay 에서 lease 를 쥔 호출 하나를 취소하면 lease 를 풀고 세션은 남는다', async () => {
  const probe = leaseProbe();
  const { daemon, endpoint, sessions } = await leaseFixture(probe);
  const agent = new http.Agent({ keepAlive: true });
  const client = new Client({ name: 'relay-lease-cancel', version: '1.0.0' });
  try {
    await client.connect(agentTransport(endpoint, agent, 'relay'));
    const session = [...sessions.values()][0]!;
    for (const tool of LEASE_TOOLS) {
      const cancel = new AbortController();
      const settled = client
        .callTool({ name: tool, arguments: {} }, undefined, {
          signal: cancel.signal,
          timeout: 60_000,
        })
        .then(
          () => 'resolved',
          () => 'rejected',
        );
      await until(() => probe.started.includes(tool), 3000, `${tool} did not start waiting`);
      assert.equal(probe.coordinator.snapshot()?.operation, tool);

      // SDK 는 취소할 때 POST 를 열어 둔 채 notifications/cancelled 만 보낸다.
      cancel.abort();
      assert.equal(await settled, 'rejected');
      await until(
        () => probe.coordinator.snapshot() === null,
        2000,
        `${tool} kept the lease after its request was cancelled`,
      );
    }
    assert.equal(session.abortController.signal.aborted, false, 'the session stays open');
    assert.equal(sessions.snapshot().byTransport.relay, 1);
  } finally {
    agent.destroy();
    await client.close().catch(() => undefined);
    await daemon.stop();
  }
});

// ── 세션 중 사라진 데몬 되살리기 ──
//
// 실측: 데몬이 멈춘 뒤 떠 있던 relay 의 다음 툴 호출은 ECONNREFUSED 로 실패했고 그 뒤로도 계속 실패했다.
// relay 는 시작할 때만 ensureDaemon 을 불렀다. 아래 테스트는 relay 를 같은 프로세스에서 돌리고
// ensureDaemon 을 가짜로 바꿔, 실제 데몬 프로세스를 띄우지 않고 같은 포트에 테스트 데몬을 다시 연다.

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface RelayIo {
  stdin: PassThrough;
  stdout: PassThrough;
  send(message: Record<string, unknown>): void;
  reply(id: number, ms?: number): Promise<Record<string, unknown>>;
}

function relayIo(): RelayIo {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const replies = new Map<number, Record<string, unknown>>();
  const waiters = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const index = buffer.indexOf('\n');
      if (index < 0) break;
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id !== 'number') continue;
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter(message);
      } else {
        replies.set(message.id, message);
      }
    }
  });
  return {
    stdin,
    stdout,
    send: (message) => {
      stdin.write(JSON.stringify(message) + '\n');
    },
    reply: (id, ms = 20_000) => {
      const ready = replies.get(id);
      if (ready) {
        replies.delete(id);
        return Promise.resolve(ready);
      }
      return withTimeout(
        new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve)),
        ms,
        `relay did not answer request ${id}`,
      );
    },
  };
}

async function openRelaySession(io: RelayIo): Promise<void> {
  io.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'relay-revive-test', version: '1.0.0' },
    },
  });
  assert.equal((await io.reply(1)).error, undefined, 'initialize must succeed');
  io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal((await listToolsVia(io, 2)).error, undefined, 'first tools/list must succeed');
}

function listToolsVia(io: RelayIo, id: number): Promise<Record<string, unknown>> {
  io.send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
  return io.reply(id);
}

function toolCount(reply: Record<string, unknown>): number {
  const tools = (reply.result as { tools?: unknown[] } | undefined)?.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

interface TestDaemon {
  daemon: McpHttpDaemon;
  sessions: SessionRegistry;
}

/** 멈춘 데몬과 같은 포트에 새 테스트 데몬을 연다. */
async function daemonOnPort(cfg: Config, port: number): Promise<TestDaemon> {
  const sessions = new SessionRegistry();
  const daemon = new McpHttpDaemon({
    cfg,
    shared: fakeShared(cfg, sessions),
    sessions,
    token: TOKEN,
    port,
  });
  await daemon.start();
  return { daemon, sessions };
}

async function reviveFixture(): Promise<{
  first: Awaited<ReturnType<typeof fixture>>;
  port: number;
  relayCfg: Config;
  io: RelayIo;
  revived: TestDaemon[];
}> {
  const first = await fixture();
  const port = Number(first.endpoint.port);
  const relayCfg = loadConfig(relayConfigFile({ port, path: first.endpoint.pathname }));
  return { first, port, relayCfg, io: relayIo(), revived: [] };
}

async function closeRevive(
  ctx: Awaited<ReturnType<typeof reviveFixture>>,
  relay: Promise<void>,
): Promise<void> {
  ctx.io.stdin.end();
  await withTimeout(relay, 5000, 'relay did not close').catch(() => undefined);
  await ctx.first.daemon.stop();
  for (const entry of ctx.revived) await entry.daemon.stop();
}

/**
 * 세션이 쉬는 동안 데몬을 멈춘다. 실제로는 데몬이 멈춘 뒤 다음 호출까지 relay 의 이벤트 루프가 돌아
 * 데몬이 닫은 유휴 keep-alive 소켓을 버린다. 같은 프로세스에서 곧바로 보내면 그 소켓을 재사용하고,
 * relay 는 그 호출을 데몬에 닿았을 수 있는 호출로 다룬다(아래 재사용 소켓 테스트).
 */
async function stopIdleDaemon(daemon: McpHttpDaemon): Promise<void> {
  await daemon.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

test('relay 는 세션 중 사라진 데몬을 다시 띄우고 그 요청을 한 번 재전송한다', async () => {
  const ctx = await reviveFixture();
  let ensureCalls = 0;
  const relay = runRelay(ctx.relayCfg, {
    stdin: ctx.io.stdin,
    stdout: ctx.io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => false,
    reviveSettleMs: 0,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      if (ensureCalls === 1) return { token: TOKEN, started: false };
      ctx.revived.push(await daemonOnPort(ctx.first.cfg, ctx.port));
      return { token: TOKEN, started: true };
    },
  });
  try {
    await openRelaySession(ctx.io);
    await stopIdleDaemon(ctx.first.daemon);

    const reply = await listToolsVia(ctx.io, 3);
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.ok(toolCount(reply) > 0);
    assert.equal(ensureCalls, 2, '시작할 때 한 번, 데몬이 사라진 뒤 한 번');
    assert.equal(ctx.revived[0]?.sessions.snapshot().total, 1, 'relay 가 새 데몬에 세션을 세운다');

    // 되살린 뒤에는 평소처럼 이어진다.
    assert.ok(toolCount(await listToolsVia(ctx.io, 4)) > 0);
    assert.equal(ensureCalls, 2);
  } finally {
    await closeRevive(ctx, relay);
  }
});

test('relay 는 자동 기동이 억제돼 있으면 데몬을 띄우지 않고 이전과 같은 오류 문구를 돌려준다', async () => {
  const ctx = await reviveFixture();
  let ensureCalls = 0;
  const relay = runRelay(ctx.relayCfg, {
    stdin: ctx.io.stdin,
    stdout: ctx.io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => true,
    reviveSettleMs: 0,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      return { token: TOKEN, started: false };
    },
  });
  try {
    await openRelaySession(ctx.io);
    await stopIdleDaemon(ctx.first.daemon);

    const reply = await listToolsVia(ctx.io, 3);
    const message = String((reply.error as { message?: unknown } | undefined)?.message);
    assert.match(
      message,
      /Arma-MCP daemon request failed at .*ECONNREFUSED.*Start the daemon on the server computer/s,
    );
    assert.equal(ensureCalls, 1, '억제 상태에서는 시작할 때 말고는 부르지 않는다');
  } finally {
    await closeRevive(ctx, relay);
  }
});

test('relay 의 데몬 되살리기는 15초에 한 번으로 제한된다', async () => {
  const ctx = await reviveFixture();
  let clock = 1_000_000;
  let ensureCalls = 0;
  const relay = runRelay(ctx.relayCfg, {
    stdin: ctx.io.stdin,
    stdout: ctx.io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => false,
    reviveSettleMs: 0,
    now: () => clock,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      // 두 번째 호출은 데몬을 띄우지 못한 척한다. 세 번째에야 뜬다.
      if (ensureCalls === 3) ctx.revived.push(await daemonOnPort(ctx.first.cfg, ctx.port));
      return { token: TOKEN, started: ensureCalls === 3 };
    },
  });
  try {
    await openRelaySession(ctx.io);
    await stopIdleDaemon(ctx.first.daemon);

    const failed = await listToolsVia(ctx.io, 3);
    assert.match(String((failed.error as { message?: unknown })?.message), /ECONNREFUSED/);
    assert.equal(ensureCalls, 2);

    clock += 5_000;
    const throttled = await listToolsVia(ctx.io, 4);
    assert.match(String((throttled.error as { message?: unknown })?.message), /ECONNREFUSED/);
    assert.equal(ensureCalls, 2, '15초 안에는 다시 시도하지 않는다');

    clock += 11_000;
    const recovered = await listToolsVia(ctx.io, 5);
    assert.equal(recovered.error, undefined, JSON.stringify(recovered.error));
    assert.equal(ensureCalls, 3);
  } finally {
    await closeRevive(ctx, relay);
  }
});

test('relay 는 데몬을 띄우기 전에 다른 relay 가 되살리는 데몬을 잠시 기다린다', async () => {
  const ctx = await reviveFixture();
  let ensureCalls = 0;
  let portOpenAtEnsure: boolean | null = null;
  const relay = runRelay(ctx.relayCfg, {
    stdin: ctx.io.stdin,
    stdout: ctx.io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => false,
    reviveSettleMs: 5_000,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      if (ensureCalls > 1) portOpenAtEnsure = await isPortOpen(ctx.first.endpoint);
      return { token: TOKEN, started: false };
    },
  });
  try {
    await openRelaySession(ctx.io);
    await stopIdleDaemon(ctx.first.daemon);
    // 업그레이드하는 다른 relay 가 400ms 뒤에 새 데몬을 띄우는 상황.
    const other = new Promise<void>((resolve) => {
      setTimeout(() => {
        void daemonOnPort(ctx.first.cfg, ctx.port).then((entry) => {
          ctx.revived.push(entry);
          resolve();
        });
      }, 400);
    });

    const startedAt = Date.now();
    const reply = await listToolsVia(ctx.io, 3);
    const elapsed = Date.now() - startedAt;
    await other;
    assert.equal(reply.error, undefined, JSON.stringify(reply.error));
    assert.equal(portOpenAtEnsure, true, 'ensureDaemon 은 포트가 다시 열린 뒤에 불린다');
    assert.ok(elapsed >= 300 && elapsed < 5_000, `포트가 열릴 때까지만 기다린다 (실제 ${elapsed}ms)`);
  } finally {
    await closeRevive(ctx, relay);
  }
});

test('relay 는 데몬 종료로 끊긴 진행 중 호출을 재전송하지 않고, 다음 호출에서 데몬을 다시 띄운다', async () => {
  // 끊긴 호출은 데몬이 이미 실행했을 수 있다. 툴 호출은 멱등이 아니므로 오류로 답한다.
  const first = await daemonWithRptDir();
  const port = Number(first.endpoint.port);
  const daemonCfg = loadConfig(configFile({ web: { enabled: false } }));
  const relayCfg = loadConfig(relayConfigFile({ port, path: first.endpoint.pathname }));
  const io = relayIo();
  const revived: TestDaemon[] = [];
  let ensureCalls = 0;
  const relay = runRelay(relayCfg, {
    stdin: io.stdin,
    stdout: io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => false,
    reviveSettleMs: 0,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      if (ensureCalls > 1) revived.push(await daemonOnPort(daemonCfg, port));
      return { token: TOKEN, started: ensureCalls > 1 };
    },
  });
  try {
    await openRelaySession(io);
    io.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'arma_rpt_wait',
        arguments: { pattern: 'NEVER_WRITTEN', timeoutMs: 600_000, fromEnd: true },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await first.daemon.stop();

    const cut = await io.reply(3);
    const message = String((cut.error as { message?: unknown } | undefined)?.message);
    // 데몬의 503 문구가 그대로 가야 한다. ECONNREFUSED 로 바뀌면 에이전트는 실행되지 않았다고 읽는다.
    assert.match(message, /daemon stopped before this request finished.*may or may not have run/s);
    assert.match(message, /next call/);
    assert.doesNotMatch(message, /ECONNREFUSED|Start the daemon on the server computer/);
    assert.equal(ensureCalls, 1, '끊긴 호출 때문에 데몬을 띄워 재전송하지 않는다');

    const next = await listToolsVia(io, 4);
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.equal(ensureCalls, 2, '다음 호출이 ECONNREFUSED 를 맞고 데몬을 다시 띄운다');
    assert.equal(revived[0]?.sessions.snapshot().total, 1);
  } finally {
    io.stdin.end();
    await withTimeout(relay, 5000, 'relay did not close').catch(() => undefined);
    await first.daemon.stop();
    for (const entry of revived) await entry.daemon.stop();
  }
});

/** 데몬 프로세스가 죽은 것처럼 리스너를 닫고 열린 연결을 모두 끊는다. 응답은 쓰지 않는다. */
function crashDaemon(daemon: McpHttpDaemon): void {
  const server = daemon['httpServer'] as http.Server | null;
  assert.ok(server?.listening, 'the daemon under test must be listening');
  server.close();
  server.closeAllConnections();
}

test('relay 는 재사용 소켓에서 끊긴 진행 중 호출을 데몬에 닿지 않은 호출로 보지 않는다', async () => {
  // keep-alive 소켓으로 보낸 호출을 데몬이 받아 실행하다 죽으면 재사용 소켓의 ECONNRESET 이 된다.
  // relay fetch 는 새 연결로 한 번 더 보내고, 그 재시도가 ECONNREFUSED 로 실패한다.
  // 이것을 "데몬에 닿지 않은 호출" 로 보면 데몬을 다시 띄워 같은 툴을 두 번 실행한다.
  const first = await daemonWithRptDir();
  const port = Number(first.endpoint.port);
  const daemonCfg = loadConfig(configFile({ web: { enabled: false } }));
  const relayCfg = loadConfig(relayConfigFile({ port, path: first.endpoint.pathname }));
  const io = relayIo();
  const revived: TestDaemon[] = [];
  let ensureCalls = 0;
  const relay = runRelay(relayCfg, {
    stdin: io.stdin,
    stdout: io.stdout,
    selfUpdate: () => undefined,
    autostartSuppressed: () => false,
    reviveSettleMs: 0,
    ensureDaemon: async (): Promise<DaemonHandle> => {
      ensureCalls += 1;
      if (ensureCalls > 1) revived.push(await daemonOnPort(daemonCfg, port));
      return { token: TOKEN, started: ensureCalls > 1 };
    },
  });
  try {
    // initialize, initialized, tools/list 가 같은 keep-alive 소켓을 탄다. 아래 호출은 그 소켓을 재사용한다.
    await openRelaySession(io);
    io.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'arma_rpt_wait',
        arguments: { pattern: 'NEVER_WRITTEN', timeoutMs: 600_000, fromEnd: true },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    crashDaemon(first.daemon);

    const cut = await io.reply(3);
    const message = String((cut.error as { message?: unknown } | undefined)?.message);
    assert.match(message, /may or may not have run/);
    assert.match(message, /next call/);
    assert.equal(ensureCalls, 1, '끊긴 호출 때문에 데몬을 띄워 재전송하지 않는다');
    assert.equal(revived.length, 0);

    const next = await listToolsVia(io, 4);
    assert.equal(next.error, undefined, JSON.stringify(next.error));
    assert.equal(ensureCalls, 2, '다음 호출이 ECONNREFUSED 를 맞고 데몬을 다시 띄운다');
    assert.equal(revived[0]?.sessions.snapshot().total, 1);
  } finally {
    io.stdin.end();
    await withTimeout(relay, 5000, 'relay did not close').catch(() => undefined);
    await first.daemon.stop();
    for (const entry of revived) await entry.daemon.stop();
  }
});
