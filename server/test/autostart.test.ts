// autostart.test.ts — "플러그인만 설치하면 연결된다"는 계약.
//
// relay 는 아무도 듣고 있지 않을 때만 daemon 을 띄우고, 억제 신호가 있으면 절대 띄우지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  autostartSuppressed,
  compareVersions,
  DaemonSetupError,
  ensureDaemon,
  isArmaMcpDaemonCommandLine,
  isLegacyOwnerCommandLine,
  isPipeBusy,
  isPortOpen,
  LEGACY_LINGER_KILL_MS,
  LINGER_KILL_MS,
  loaderExecArgv,
  pickDaemonPid,
  planDaemonAction,
  probeDaemon,
  splitCommandLine,
  STOPPING_DAEMON_WAIT_MS,
  type DaemonLifecycleDeps,
  type DaemonProbe,
  type NodeProcessInfo,
} from '../src/daemon/autostart.js';
import type { DetachedProcess } from '../src/launch/spawn.js';
import { loadConfig } from '../src/config.js';
import { loadMcpToken } from '../src/daemon/token.js';
import { ARMA_MCP_VERSION } from '../src/version.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// 순수 함수 판정용 임의 버전. 실제 daemon 응답 검증에는 ARMA_MCP_VERSION 을 쓴다.
const OURS = '0.3.1';

function plan(probe: Parameters<typeof planDaemonAction>[0]['probe'], suppressed = false) {
  return planDaemonAction({ probe, ourVersion: OURS, suppressed });
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

function relayEnv(configPath: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  delete env.ARMA_MCP_TOKEN;
  delete env.ARMA_MCP_NO_AUTOSTART;
  env.ARMA_MCP_CONFIG = configPath;
  return { ...env, ...extra };
}

function relayTransport(env: Record<string, string>): StdioClientTransport {
  return new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.join(here, '..', 'src', 'index.ts'), 'relay'],
    cwd: path.join(here, '..'),
    env,
  });
}

test('compareVersions: 자리별 숫자 비교', () => {
  assert.equal(compareVersions('0.3.1', '0.3.1'), 0);
  assert.ok(compareVersions('0.3.1', '0.3.0') > 0);
  assert.ok(compareVersions('0.3.0', '0.4.0') < 0);
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
});

test('loaderExecArgv: 로더 플래그만 물려주고 테스트 러너 기본값은 버린다', () => {
  assert.deepEqual(
    loaderExecArgv([
      '--test-timeout=0',
      '--inspect-port=127.0.0.1:9229',
      '--require=C:\\tsx\\preflight.cjs',
      '--import',
      'file:///C:/tsx/loader.mjs',
      '--require',
      'C:\\tsx\\preflight.cjs',
    ]),
    ['--require=C:\\tsx\\preflight.cjs', '--import=file:///C:/tsx/loader.mjs'],
  );
  assert.deepEqual(loaderExecArgv([]), []);
});

test('autostartSuppressed: 명시 플래그와 원격 토큰 신호', () => {
  assert.equal(autostartSuppressed({}), false);
  assert.equal(autostartSuppressed({ ARMA_MCP_NO_AUTOSTART: '1' }), true);
  assert.equal(autostartSuppressed({ ARMA_MCP_NO_AUTOSTART: '0' }), false);
  assert.equal(autostartSuppressed({ ARMA_MCP_NO_AUTOSTART: 'false' }), false);
  assert.equal(autostartSuppressed({ ARMA_MCP_TOKEN: 'remote-token' }), true);
});

test('planDaemonAction: 관측 상태별 결정', () => {
  assert.deepEqual(plan({ kind: 'none' }), { kind: 'spawn' });
  assert.deepEqual(plan({ kind: 'healthy', version: OURS }), { kind: 'connect' });
  assert.deepEqual(plan({ kind: 'healthy', version: '0.3.0' }), { kind: 'restart' });

  const older = plan({ kind: 'healthy', version: '0.4.0' });
  assert.equal(older.kind, 'fail');
  assert.match((older as { reason: string }).reason, /older than the running daemon/i);

  const unauthorized = plan({ kind: 'unauthorized' });
  assert.equal(unauthorized.kind, 'fail');
  assert.match((unauthorized as { reason: string }).reason, /different bearer token/i);

  const foreign = plan({ kind: 'foreign', status: 404 });
  assert.equal(foreign.kind, 'fail');
  assert.match((foreign as { reason: string }).reason, /another service owns the port/i);

  const busy = plan({ kind: 'listening' });
  assert.equal(busy.kind, 'fail');
  assert.match((busy as { reason: string }).reason, /already listening/i);

  const legacy = plan({ kind: 'legacy-pipe', pids: [12180, 5068] });
  assert.equal(legacy.kind, 'fail');
  const reason = (legacy as { reason: string }).reason;
  assert.match(reason, /pre-0\.3 Arma-MCP server/i);
  assert.match(reason, /Close those sessions or stop those node processes/i);
  assert.match(reason, /12180, 5068/);

  // pre-0.3 후보가 없으면 업그레이드 중인 옛 daemon 일 수도 있다. 단정하지 않고 두 가능성과 조치를 알린다.
  const unknown = (plan({ kind: 'legacy-pipe', pids: [] }) as { reason: string }).reason;
  assert.match(unknown, /pre-0\.3 Arma-MCP server/i);
  assert.match(unknown, /previous Arma-MCP daemon may still be shutting down/i);
  assert.match(unknown, /Reconnect in a few seconds.*doctor/is);
});

test('planDaemonAction: 억제 상태면 어떤 관측이든 프로세스를 만들지 않는다', () => {
  for (const probe of [
    { kind: 'none' } as const,
    { kind: 'listening' } as const,
    { kind: 'healthy', version: '0.3.0' } as const,
  ]) {
    assert.deepEqual(plan(probe, true), { kind: 'connect' });
  }
});

test('isPipeBusy: 살아 있는 파이프만 점유로 본다', async () => {
  const name = `\\\\.\\pipe\\arma_mcp_busy_${process.pid}`;
  assert.equal(isPipeBusy(name), false);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(name, resolve));
  try {
    assert.equal(isPipeBusy(name), true);
    // 접두사 표기가 달라도 같은 파이프로 인식해야 한다.
    assert.equal(isPipeBusy(`\\\\?\\pipe\\ARMA_MCP_BUSY_${process.pid}`), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(isPipeBusy(name), false);
});

test('isLegacyOwnerCommandLine: 모드 인자가 없거나 standalone 인 옛 형태만 잡는다', () => {
  const bundle = String.raw`C:\plugins\cache\ahc\arma-mcp\0.4.3\server\bundle\index.mjs`;
  const legacy = [
    String.raw`"C:\Program Files\nodejs\node.exe" "${bundle}"`,
    `node ${bundle}`,
    `node "${bundle}" standalone`,
    `node ${bundle} --mode=standalone`,
    // 저장소 체크아웃은 대소문자가 달라도 같은 모양이다.
    String.raw`node E:\src\Arma-MCP\server\bundle\index.mjs`,
  ];
  for (const line of legacy) assert.equal(isLegacyOwnerCommandLine(line), true, line);

  const current = [
    `node "${bundle}" cli status`,
    // 뒤 인자에 index.mjs 가 또 나와도 첫 index.mjs 뒤의 모드만 본다.
    String.raw`node "${bundle}" cli exec -f D:\work\arma-mcp\index.mjs`,
    String.raw`node "${bundle}" selfupdate hook --root C:\x --cli host`,
    `node "${bundle}" doctor`,
    `node "${bundle}" relay`,
    `node "${bundle}" daemon`,
    `node ${bundle} --mode=relay`,
    `node "${bundle}" standalonex`,
    // arma-mcp 경로가 아닌 index.mjs 는 우리 프로세스가 아니다.
    String.raw`node C:\other-tool\index.mjs`,
  ];
  for (const line of current) assert.equal(isLegacyOwnerCommandLine(line), false, line);
});

test('probeDaemon: 포트는 죽었는데 파이프만 잡혀 있으면 legacy-pipe', async () => {
  const port = await reserveUnusedPort();
  const name = `\\\\.\\pipe\\arma_mcp_legacy_${process.pid}_${port}`;
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(name, resolve));
  try {
    const probe = await probeDaemon(new URL(`http://127.0.0.1:${port}/mcp`), null, name);
    assert.equal(probe.kind, 'legacy-pipe');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('probeDaemon: 토큰 없이 죽은 포트는 none', async () => {
  const port = await reserveUnusedPort();
  const probe = await probeDaemon(new URL(`http://127.0.0.1:${port}/mcp`), null);
  assert.deepEqual(probe, { kind: 'none' });
});

test('relay 가 daemon 없는 컴퓨터에서 daemon 을 띄우고 툴을 제공한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-autostart-'));
  const configPath = path.join(dir, 'config.json');
  const port = await reserveUnusedPort();
  writeFileSync(
    configPath,
    JSON.stringify({
      // 실제 게임 파이프와 5303 을 건드리지 않는 격리 설정.
      pipeName: `\\\\.\\pipe\\arma_mcp_autostart_${process.pid}_${port}`,
      web: { enabled: false },
      mcp: { port, tokenFile: path.join(dir, 'daemon.token') },
    }),
    'utf8',
  );

  const client = new Client({ name: 'autostart-test', version: '1.0.0' });
  const transport = relayTransport(relayEnv(configPath));
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'arma_status'));

    const cfg = loadConfig(configPath);
    const token = loadMcpToken(cfg);
    const probe = await probeDaemon(endpoint, token);
    assert.deepEqual(probe, { kind: 'healthy', version: ARMA_MCP_VERSION });
  } finally {
    await client.close().catch(() => undefined);
    const cfg = loadConfig(configPath);
    const token = (() => {
      try {
        return loadMcpToken(cfg);
      } catch {
        return null;
      }
    })();
    if (token) {
      await fetch(new URL('/shutdown', endpoint).href, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await probeDaemon(endpoint, token)).kind === 'none') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test('구버전 daemon 은 종료시키고 현재 번들로 다시 띄운다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-upgrade-'));
  const configPath = path.join(dir, 'config.json');
  const tokenFile = path.join(dir, 'daemon.token');
  const token = '0123456789abcdef0123456789abcdef';
  const port = await reserveUnusedPort();
  writeFileSync(tokenFile, token + '\n', 'utf8');
  writeFileSync(
    configPath,
    JSON.stringify({
      pipeName: `\\\\.\\pipe\\arma_mcp_upgrade_${process.pid}_${port}`,
      web: { enabled: false },
      mcp: { port, tokenFile },
    }),
    'utf8',
  );

  // 0.3.0 처럼 응답하는 가짜 daemon. /shutdown 을 받으면 포트를 놓는다.
  let shutdownSeen = false;
  const old = http.createServer((req, res) => {
    res.setHeader('x-arma-mcp-version', '0.3.0');
    if (req.url === '/shutdown') {
      shutdownSeen = true;
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, shuttingDown: true }));
      res.once('finish', () => {
        old.closeAllConnections?.();
        old.close();
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, version: '0.3.0' }));
  });
  await new Promise<void>((resolve) => old.listen(port, '127.0.0.1', resolve));

  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  try {
    const handle = await ensureDaemon({
      cfg: loadConfig(configPath),
      endpoint,
      entry: path.join(here, '..', 'src', 'index.ts'),
      configPath,
    });
    assert.equal(handle.started, true);
    assert.equal(handle.token, token);
    assert.equal(shutdownSeen, true, '구버전 daemon 에 종료를 요청해야 한다');
    assert.deepEqual(await probeDaemon(endpoint, token), {
      kind: 'healthy',
      version: ARMA_MCP_VERSION,
    });
  } finally {
    await fetch(new URL('/shutdown', endpoint).href, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    old.close();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await probeDaemon(endpoint, token)).kind === 'none') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});

test('pre-0.3 가 파이프를 쥐고 있으면 spawn 없이 조치 사유를 회신한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-legacy-'));
  const configPath = path.join(dir, 'config.json');
  const tokenFile = path.join(dir, 'daemon.token');
  const port = await reserveUnusedPort();
  const pipeName = `\\\\.\\pipe\\arma_mcp_legacyrelay_${process.pid}_${port}`;
  writeFileSync(tokenFile, '0123456789abcdef0123456789abcdef\n', 'utf8');
  writeFileSync(
    configPath,
    JSON.stringify({ pipeName, web: { enabled: false }, mcp: { port, tokenFile } }),
    'utf8',
  );

  // pre-0.3 서버 흉내: 게임 파이프만 쥐고 MCP 포트는 열지 않는다.
  const legacy = net.createServer();
  await new Promise<void>((resolve) => legacy.listen(pipeName, resolve));

  const relay = relayTransport(relayEnv(configPath));
  const response = new Promise<Record<string, unknown>>((resolve) => {
    relay.onmessage = (message) => resolve(message as Record<string, unknown>);
  });
  try {
    await relay.start();
    await relay.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'legacy-pipe-test', version: '1.0.0' },
      },
    });
    // pre-0.3 후보가 보이지 않으면 relay 는 업그레이드 중인 옛 daemon 이 끝나기를 먼저 기다린다.
    const failure = await Promise.race([
      response,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('relay did not fail within 20 seconds')), 20_000),
      ),
    ]);
    const message = String((failure.error as { message?: unknown } | undefined)?.message);
    // 후보가 보이면 그 pid 와 함께, 안 보이면 업그레이드 중인 옛 daemon 일 가능성과 함께 알린다.
    assert.match(message, /cannot connect.*pre-0\.3 Arma-MCP server.*doctor/is);
    assert.doesNotMatch(
      message,
      /Start the Arma-MCP daemon on the game computer/i,
      '자체 조치를 가진 사유에 일반 안내를 덧붙이면 안 된다',
    );
    assert.equal(
      await isPortOpen(new URL(`http://127.0.0.1:${port}/mcp`)),
      false,
      'daemon 을 띄우려는 시도조차 없어야 한다',
    );
    // 실패 사유는 파일로도 남는다.
    const relayLog = readFileSync(path.join(dir, 'relay.log'), 'utf8');
    assert.match(relayLog, /pre-0\.3 Arma-MCP server/i);
  } finally {
    await relay.close().catch(() => undefined);
    await new Promise<void>((resolve) => legacy.close(() => resolve()));
  }
});

test('ARMA_MCP_NO_AUTOSTART=1 이면 daemon 을 띄우지 않고 사유를 회신한다', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-noautostart-'));
  const configPath = path.join(dir, 'config.json');
  const port = await reserveUnusedPort();
  writeFileSync(
    configPath,
    JSON.stringify({
      web: { enabled: false },
      mcp: { port, tokenFile: path.join(dir, 'daemon.token') },
    }),
    'utf8',
  );

  const relay = relayTransport(relayEnv(configPath, { ARMA_MCP_NO_AUTOSTART: '1' }));
  const response = new Promise<Record<string, unknown>>((resolve) => {
    relay.onmessage = (message) => resolve(message as Record<string, unknown>);
  });
  await relay.start();
  await relay.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'no-autostart-test', version: '1.0.0' },
    },
  });
  const failure = await Promise.race([
    response,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('relay did not fail within 5 seconds')), 5000),
    ),
  ]);
  assert.match(
    String((failure.error as { message?: unknown } | undefined)?.message),
    /could not start.*token not found.*ARMA_MCP_TOKEN/is,
  );
  assert.deepEqual(
    await probeDaemon(new URL(`http://127.0.0.1:${port}/mcp`), null),
    { kind: 'none' },
    '억제 상태에서는 daemon 이 생기면 안 된다',
  );
  await relay.close().catch(() => undefined);
});

// ── 업그레이드 중 남은 옛 daemon 정리 ──
//
// 실측: 0.4.1 daemon 이 /shutdown 을 202 로 받아들이고 HTTP 포트는 바로 닫았지만, 프로세스는
// 90초 넘게 게임 파이프를 쥔 채 남았다. 새 daemon 은 "cannot own pipe" 로 죽었다.
// 아래 테스트는 프로세스 목록, 종료, health 를 가짜로 바꿔 실제 프로세스를 건드리지 않는다.

const SELF_PID = 1000;
const OLD_DAEMON_PID = 4242;
const OTHER_DAEMON_PID = 7777;
// 호스트 중립 플러그인 루트. 호스트별 설치 경로는 host adapter 만 안다.
const PLUGIN_ROOT = 'C:\\Users\\u\\plugin-root\\cache\\ahc\\arma-mcp\\0.4.1';
const PLUGIN = `${PLUGIN_ROOT}\\server\\bundle\\index.mjs`;
const PLUGIN_SLASH = 'C:/Users/u/plugin-root/cache/ahc/arma-mcp/0.4.1/server/bundle/index.mjs';
const DAEMON_CMD = `"C:\\Program Files\\nodejs\\node.exe" ${PLUGIN} daemon`;
const OTHER_DAEMON_CMD =
  '"C:\\Program Files\\nodejs\\node.exe" "E:\\work\\Arma-MCP\\server\\bundle\\index.mjs" daemon';
const RELAY_CMD = `node ${PLUGIN_SLASH} relay`;
const SELFUPDATE_CMD = `node ${PLUGIN_SLASH} selfupdate hook --root C:/x --cli host`;
const CLI_CMD = `node ${PLUGIN_SLASH} cli arma_status`;
const DOCTOR_CMD = `node ${PLUGIN_SLASH} doctor`;
// 이전 daemon 보다 늘 낮은 버전. 버전을 올려도 이 테스트는 그대로 돈다.
const ANCIENT = '0.0.1';

interface World {
  deps: Partial<DaemonLifecycleDeps>;
  events: string[];
  killed: number[];
  spawned: number;
  spawnedAt: number | null;
  shutdowns: number;
  probes: number;
  clock(): number;
}

function fakeWorld(opts: {
  processes: NodeProcessInfo[];
  listeners?: number[];
  healthPid?: number;
  daemonVersion?: string;
  acknowledged?: boolean;
  /** /shutdown 뒤 이 시간(ms)이 지나면 옛 daemon 이 스스로 끝난다. 없으면 끝나지 않는다. */
  exitsAfterMs?: number;
  /** 게임 파이프가 /shutdown 뒤 이 시간(ms) 동안 잡혀 있다. 없으면 파이프는 처음부터 비어 있다. */
  pipeHeldForMs?: number;
  /** /shutdown 뒤 이 시간(ms)이 지나면 다른 relay 가 띄운 현재 버전 daemon 이 포트에서 답한다. */
  currentAfterMs?: number;
  /** 프로세스 목록을 읽는 사이 다른 relay 가 이 버전 daemon 으로 업그레이드를 마친다. */
  upgradedDuringSnapshot?: string;
  /** /shutdown 뒤 다시 읽은 목록에서 옛 daemon pid 의 명령행. null 이면 목록에 없다(node 가 아닌 프로세스). */
  pidReusedBy?: string | null;
  /** 다른 relay 가 이미 /shutdown 을 보내 포트가 닫힌 채로 시작한다. */
  startsStopped?: boolean;
  /**
   * 처음 이 횟수만큼의 기동에서 같은 순간 다른 relay 가 띄운 daemon 이 파이프와 포트를 잡는다.
   * 이 relay 가 띄운 daemon 은 파이프를 잡지 못하고 끝난다. 이긴 daemon 은 옛 daemon pid 로 선다.
   */
  lostStarts?: number;
  /** lostStarts 에서 이긴 daemon 의 버전. 기본은 ANCIENT 다. */
  raceWinner?: string;
  env?: NodeJS.ProcessEnv;
}): World {
  let clock = 0;
  let shutdownAt: number | null = opts.startsStopped ? 0 : null;
  let upgradedTo: string | null = null;
  let winner: string | null = null;
  const alive = new Set(opts.processes.map((p) => p.pid));
  const world: World = {
    deps: {},
    events: [],
    killed: [],
    spawned: 0,
    spawnedAt: null,
    shutdowns: 0,
    probes: 0,
    clock: () => clock,
  };
  const settle = (): void => {
    const exitsAfterMs = opts.exitsAfterMs;
    if (shutdownAt !== null && exitsAfterMs !== undefined && clock >= shutdownAt + exitsAfterMs) {
      alive.delete(OLD_DAEMON_PID);
    }
  };
  const sinceShutdown = (): number => (shutdownAt === null ? -1 : clock - shutdownAt);
  const currentVersion = (): string | null => {
    if (upgradedTo) return upgradedTo;
    const after = opts.currentAfterMs;
    return after !== undefined && shutdownAt !== null && sinceShutdown() >= after
      ? ARMA_MCP_VERSION
      : null;
  };
  const portOpen = (): boolean => shutdownAt === null || currentVersion() !== null;
  const version = (): string => currentVersion() ?? winner ?? opts.daemonVersion ?? ANCIENT;
  const pipeBusy = (): boolean => {
    const heldFor = opts.pipeHeldForMs;
    if (heldFor === undefined) return false;
    return shutdownAt === null || sinceShutdown() < heldFor;
  };
  world.deps = {
    env: opts.env ?? {},
    selfPid: SELF_PID,
    // 실제 probeDaemon 처럼 파이프 이름을 주면, 포트가 닫혀 있고 파이프가 잡혀 있을 때 legacy-pipe 로 판정한다.
    // pre-0.3 후보 프로세스는 없다.
    probe: async (_endpoint, _token, pipeName): Promise<DaemonProbe> => {
      world.probes += 1;
      if (portOpen()) return { kind: 'healthy', version: version() };
      if (pipeName && pipeBusy()) return { kind: 'legacy-pipe', pids: [] };
      return { kind: 'none' };
    },
    readHealth: async () => {
      if (!portOpen()) return null;
      return opts.healthPid === undefined || currentVersion() !== null
        ? { version: version() }
        : { version: version(), pid: opts.healthPid };
    },
    isPipeBusy: () => pipeBusy(),
    snapshot: async () => {
      if (opts.upgradedDuringSnapshot) upgradedTo = opts.upgradedDuringSnapshot;
      const reused = opts.pidReusedBy;
      if (shutdownAt === null || reused === undefined) {
        return { processes: opts.processes, listeners: opts.listeners ?? [] };
      }
      const processes = opts.processes.flatMap((p) => {
        if (p.pid !== OLD_DAEMON_PID) return [p];
        return reused === null ? [] : [{ pid: p.pid, commandLine: reused }];
      });
      return { processes, listeners: [] };
    },
    requestShutdown: async () => {
      world.shutdowns += 1;
      world.events.push('shutdown');
      // 실측처럼 HTTP 포트는 곧바로 닫힌다. 프로세스가 남는지는 exitsAfterMs 가 정한다.
      shutdownAt = clock;
      return opts.acknowledged ?? true;
    },
    isPortOpen: async () => portOpen(),
    isAlive: (pid) => {
      settle();
      return alive.has(pid);
    },
    kill: (pid) => {
      world.killed.push(pid);
      world.events.push(`kill:${pid}@${clock}`);
      alive.delete(pid);
    },
    spawn: async () => {
      world.spawned += 1;
      world.spawnedAt = clock;
      world.events.push('spawn');
      if (world.spawned <= (opts.lostStarts ?? 0)) {
        winner = opts.raceWinner ?? ANCIENT;
        shutdownAt = null;
        alive.add(OLD_DAEMON_PID);
        world.events.push(`won:${winner}`);
      }
      return {
        child: {} as DetachedProcess['child'],
        pid: 9999,
        exitSignal: new AbortController().signal,
        exitInfo: () => undefined,
      };
    },
    // 포트에서 답하는 daemon 이 있으면 그 daemon 이다. 없으면 이 relay 가 띄운 현재 버전 daemon 이 답한다.
    waitReady: async () => ({
      token: '0123456789abcdef0123456789abcdef',
      version: portOpen() ? version() : ARMA_MCP_VERSION,
    }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return world;
}

function upgradeConfig(): ReturnType<typeof loadConfig> {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-linger-'));
  const configPath = path.join(dir, 'config.json');
  const tokenFile = path.join(dir, 'daemon.token');
  writeFileSync(tokenFile, '0123456789abcdef0123456789abcdef\n', 'utf8');
  writeFileSync(
    configPath,
    JSON.stringify({
      pipeName: `\\\\.\\pipe\\arma_mcp_linger_${process.pid}`,
      web: { enabled: false },
      mcp: { port: 1, tokenFile },
    }),
    'utf8',
  );
  return loadConfig(configPath);
}

async function runUpgrade(world: World): Promise<Awaited<ReturnType<typeof ensureDaemon>>> {
  return ensureDaemon({
    cfg: upgradeConfig(),
    endpoint: new URL('http://127.0.0.1:1/mcp'),
    entry: 'fake-entry.mjs',
    configPath: 'fake-config.json',
    deps: world.deps,
  });
}

const baseProcesses: NodeProcessInfo[] = [
  { pid: OLD_DAEMON_PID, commandLine: DAEMON_CMD },
  { pid: 5001, commandLine: RELAY_CMD },
  { pid: SELF_PID, commandLine: RELAY_CMD },
];

test('isArmaMcpDaemonCommandLine: 번들 index.mjs 를 daemon 모드로 실행한 것만 고른다', () => {
  assert.equal(isArmaMcpDaemonCommandLine(DAEMON_CMD), true);
  assert.equal(isArmaMcpDaemonCommandLine(OTHER_DAEMON_CMD), true);
  assert.equal(isArmaMcpDaemonCommandLine(`node --import=x ${PLUGIN_SLASH} daemon`), true);
  // 플러그인 루트에서 상대 경로로 띄운 relay 도 daemon 은 node 가 알려준 절대 경로(argv[1])로 띄운다.
  const resolved = path.win32.resolve(PLUGIN_ROOT, './server/bundle/index.mjs');
  assert.equal(resolved, PLUGIN);
  assert.equal(
    isArmaMcpDaemonCommandLine(`"C:\\Program Files\\nodejs\\node.exe" ${resolved} daemon`),
    true,
  );
  for (const cmd of [
    RELAY_CMD,
    SELFUPDATE_CMD,
    CLI_CMD,
    DOCTOR_CMD,
    `node ${PLUGIN_SLASH}`,
    'node ./server/bundle/index.mjs relay',
  ]) {
    assert.equal(isArmaMcpDaemonCommandLine(cmd), false, cmd);
  }
  // 모드 인자는 정확히 daemon 이어야 한다.
  assert.equal(isArmaMcpDaemonCommandLine(`node ${PLUGIN_SLASH} --mode=daemon`), false);
  assert.equal(isArmaMcpDaemonCommandLine(`node ${PLUGIN_SLASH} daemons`), false);
  // arma-mcp 번들이 아닌 index.mjs 는 모드가 daemon 이어도 해당하지 않는다.
  assert.equal(isArmaMcpDaemonCommandLine('node C:\\other\\server\\bundle\\index.mjs daemon'), false);
  assert.equal(isArmaMcpDaemonCommandLine('node C:\\arma-mcp\\src\\index.ts daemon'), false);
  assert.equal(isArmaMcpDaemonCommandLine(''), false);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\\\node.exe"  "a b" c'), [
    'C:\\Program Files\\nodejs\\\\node.exe',
    'a b',
    'c',
  ]);
});

test('isLegacyOwnerCommandLine: 게임 파이프를 열지 않는 모드는 pre-0.3 후보가 아니다', () => {
  assert.equal(isLegacyOwnerCommandLine(`node ${PLUGIN_SLASH}`), true);
  // 세션 시작 때 relay 와 함께 도는 selfupdate 를 후보로 세면 안 된다.
  for (const cmd of [RELAY_CMD, DAEMON_CMD, SELFUPDATE_CMD, CLI_CMD, DOCTOR_CMD]) {
    assert.equal(isLegacyOwnerCommandLine(cmd), false, cmd);
  }
  assert.equal(isLegacyOwnerCommandLine('node C:\\other\\index.mjs'), false);
});

test('pickDaemonPid: health pid 를 먼저 보고, 명령행이 daemon 이 아니면 고르지 않는다', () => {
  const snapshot = {
    processes: [
      ...baseProcesses,
      { pid: OTHER_DAEMON_PID, commandLine: OTHER_DAEMON_CMD },
      { pid: 5002, commandLine: SELFUPDATE_CMD },
    ],
    listeners: [OLD_DAEMON_PID],
  };
  assert.equal(pickDaemonPid({ snapshot, selfPid: SELF_PID }), OLD_DAEMON_PID);
  assert.equal(
    pickDaemonPid({ snapshot, healthPid: OTHER_DAEMON_PID, selfPid: SELF_PID }),
    OTHER_DAEMON_PID,
  );
  // health 가 daemon 이 아닌 프로세스를 가리키면 포트 소유자로 넘어간다.
  assert.equal(pickDaemonPid({ snapshot, healthPid: 5002, selfPid: SELF_PID }), OLD_DAEMON_PID);
  // 포트 소유자도 health 도 없으면 명령행만으로 고르지 않는다. 다른 포트의 daemon 일 수 있다.
  assert.equal(pickDaemonPid({ snapshot: { ...snapshot, listeners: [] }, selfPid: SELF_PID }), null);
  // relay 자신은 어떤 경우에도 대상이 아니다.
  assert.equal(
    pickDaemonPid({
      snapshot: { processes: [{ pid: SELF_PID, commandLine: DAEMON_CMD }], listeners: [SELF_PID] },
      healthPid: SELF_PID,
      selfPid: SELF_PID,
    }),
    null,
  );
});

test('업그레이드: /shutdown 을 받아들이고도 남은 옛 daemon 은 강제로 끝내고 새 daemon 을 띄운다', async () => {
  // health 에 pid 가 없는 0.4.1 이하 daemon. 스스로 끝나지 않으므로 짧게 기다린다.
  const world = fakeWorld({ processes: baseProcesses, listeners: [OLD_DAEMON_PID] });
  const handle = await runUpgrade(world);
  assert.equal(handle.started, true);
  assert.deepEqual(world.killed, [OLD_DAEMON_PID]);
  assert.equal(world.spawned, 1);
  assert.deepEqual(world.events, [
    'shutdown',
    `kill:${OLD_DAEMON_PID}@${LEGACY_LINGER_KILL_MS}`,
    'spawn',
  ]);
});

test('업그레이드: health 가 알린 pid 를 쓴다(0.4.2 이후 daemon)', async () => {
  const world = fakeWorld({
    processes: [...baseProcesses, { pid: OTHER_DAEMON_PID, commandLine: OTHER_DAEMON_CMD }],
    listeners: [],
    healthPid: OLD_DAEMON_PID,
  });
  await runUpgrade(world);
  assert.deepEqual(world.killed, [OLD_DAEMON_PID], '다른 포트의 daemon 은 건드리지 않는다');
  assert.equal(world.spawned, 1);
  // 0.4.2 이후 daemon 은 유예와 정리를 거쳐 끝나므로 더 오래 기다린 뒤에 끝낸다.
  assert.deepEqual(world.events, ['shutdown', `kill:${OLD_DAEMON_PID}@${LINGER_KILL_MS}`, 'spawn']);
});

test('업그레이드: 제시간에 끝난 옛 daemon 은 끝내지 않는다', async () => {
  const world = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    exitsAfterMs: 1500,
  });
  const handle = await runUpgrade(world);
  assert.equal(handle.started, true);
  assert.deepEqual(world.killed, []);
  assert.deepEqual(world.events, ['shutdown', 'spawn']);
  assert.ok(
    world.clock() >= 1500 && world.clock() < LEGACY_LINGER_KILL_MS,
    `끝나기를 기다렸다 (${world.clock()}ms)`,
  );
});

test('업그레이드: daemon 이 아닌 arma-mcp 프로세스는 남아 있어도 끝내지 않는다', async () => {
  for (const [label, commandLine] of [
    ['relay', RELAY_CMD],
    ['selfupdate', SELFUPDATE_CMD],
    ['cli', CLI_CMD],
    ['doctor', DOCTOR_CMD],
  ] as const) {
    // 포트 소유자와 health pid 가 모두 daemon 이 아닌 프로세스를 가리키는 경우.
    const world = fakeWorld({
      processes: [
        { pid: OLD_DAEMON_PID, commandLine },
        { pid: OTHER_DAEMON_PID, commandLine: OTHER_DAEMON_CMD },
        { pid: SELF_PID, commandLine: RELAY_CMD },
      ],
      listeners: [OLD_DAEMON_PID],
      healthPid: OLD_DAEMON_PID,
    });
    await runUpgrade(world);
    assert.deepEqual(world.killed, [], label);
    assert.equal(world.spawned, 1, label);
  }
});

test('업그레이드: 끝내기 직전 pid 가 다른 프로세스로 재사용됐으면 끝내지 않는다', async () => {
  // 옛 daemon 이 제대로 끝난 뒤 Windows 가 그 pid 를 다른 프로세스에 준 경우다.
  for (const reusedBy of [RELAY_CMD, OTHER_DAEMON_CMD, null]) {
    const world = fakeWorld({
      processes: baseProcesses,
      listeners: [OLD_DAEMON_PID],
      pidReusedBy: reusedBy,
    });
    const handle = await runUpgrade(world);
    assert.deepEqual(world.killed, [], String(reusedBy));
    assert.equal(handle.started, true);
    assert.deepEqual(world.events, ['shutdown', 'spawn'], String(reusedBy));
  }
});

test('업그레이드: 종료 요청을 받아들였다는 확인이 없으면 끝내지 않는다', async () => {
  const world = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    acknowledged: false,
  });
  await runUpgrade(world);
  assert.deepEqual(world.killed, []);
  assert.equal(world.spawned, 1);
});

test('업그레이드: 옛 daemon 을 집어내지 못해도 게임 파이프가 풀린 뒤에 새 daemon 을 띄운다', async () => {
  // 목록 조회가 실패했거나, 다른 relay 가 먼저 /shutdown 을 보내 포트 소유자가 없는 경우다.
  // 옛 daemon 은 파이프를 쥔 채 남아 있다가 2.5초 뒤 놓는다(그 relay 가 끝냈다).
  const world = fakeWorld({ processes: [], listeners: [], pipeHeldForMs: 2500 });
  const handle = await runUpgrade(world);
  assert.equal(handle.started, true);
  assert.deepEqual(world.killed, []);
  assert.deepEqual(world.events, ['shutdown', 'spawn']);
  assert.ok(
    (world.spawnedAt ?? 0) >= 2500,
    `파이프가 풀리기 전에 띄우면 새 daemon 이 cannot own pipe 로 죽는다 (${world.spawnedAt}ms)`,
  );
});

test('업그레이드: 옛 daemon 이 게임 파이프를 끝내 놓지 않으면 띄우지 않고 사유를 알린다', async () => {
  const world = fakeWorld({
    processes: [],
    listeners: [],
    pipeHeldForMs: Number.POSITIVE_INFINITY,
  });
  await assert.rejects(
    runUpgrade(world),
    (error: Error) =>
      error instanceof DaemonSetupError && /still holds the game pipe/.test(error.message),
  );
  assert.equal(world.spawned, 0);
  assert.deepEqual(world.killed, []);
});

test('업그레이드: 파이프가 잡혀 있어도 다른 relay 가 띄운 새 daemon 이 답하면 그 daemon 에 붙는다', async () => {
  const world = fakeWorld({
    processes: [],
    listeners: [],
    pipeHeldForMs: Number.POSITIVE_INFINITY,
    currentAfterMs: 1200,
  });
  const handle = await runUpgrade(world);
  assert.equal(handle.started, false);
  assert.equal(world.spawned, 0);
  assert.deepEqual(world.killed, []);
});

test('업그레이드: 목록을 읽는 사이 다른 relay 가 업그레이드를 마쳤으면 그 daemon 을 내리지 않는다', async () => {
  const same = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    upgradedDuringSnapshot: ARMA_MCP_VERSION,
  });
  const handle = await runUpgrade(same);
  assert.equal(handle.started, false);
  assert.equal(same.shutdowns, 0);
  assert.deepEqual(same.killed, []);
  assert.equal(same.spawned, 0);

  const newer = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    upgradedDuringSnapshot: '99.0.0',
  });
  await assert.rejects(runUpgrade(newer), /older than the running daemon/);
  assert.equal(newer.shutdowns, 0);
  assert.deepEqual(newer.killed, []);
  assert.equal(newer.spawned, 0);
});

test('기동: 파이프만 잡혀 있고 pre-0.3 후보가 없으면 옛 daemon 이 끝나기를 잠시 기다린다', async () => {
  // 다른 relay 가 업그레이드하느라 내린 옛 daemon 이 아직 파이프를 쥐고 있는 경우다.
  // 파이프가 풀리면 띄운다.
  const freed = fakeWorld({ processes: [], startsStopped: true, pipeHeldForMs: 2000 });
  const handle = await runUpgrade(freed);
  assert.equal(handle.started, true);
  assert.equal(freed.shutdowns, 0);
  assert.ok((freed.spawnedAt ?? 0) >= 2000, `파이프가 풀린 뒤에 띄운다 (${freed.spawnedAt}ms)`);

  // 그 relay 가 띄운 새 daemon 이 답하면 붙는다.
  const replaced = fakeWorld({
    processes: [],
    startsStopped: true,
    pipeHeldForMs: Number.POSITIVE_INFINITY,
    currentAfterMs: 1500,
  });
  const connected = await runUpgrade(replaced);
  assert.equal(connected.started, false);
  assert.equal(replaced.spawned, 0);

  // 끝내 풀리지 않으면 pre-0.3 로 단정하지 않고 두 가능성을 알린다.
  const stuck = fakeWorld({
    processes: [],
    startsStopped: true,
    pipeHeldForMs: Number.POSITIVE_INFINITY,
  });
  await assert.rejects(
    runUpgrade(stuck),
    (error: Error) =>
      error instanceof DaemonSetupError &&
      /may still be shutting down/.test(error.message) &&
      /pre-0\.3/.test(error.message) &&
      /doctor/.test(error.message),
  );
  assert.equal(stuck.spawned, 0);
  assert.ok(stuck.clock() >= STOPPING_DAEMON_WAIT_MS, `기다렸다 (${stuck.clock()}ms)`);
});

test('기동: 같은 순간 낮은 버전 relay 가 띄운 daemon 이 이기면 한 번 내리고 다시 띄운다', async () => {
  // 업그레이드 도중 옛 relay 도 ECONNREFUSED 에 daemon 을 띄웠고 그 daemon 이 파이프를 잡은 경우다.
  // 그대로 붙으면 첫 요청이 409 로 끝나 이 relay 는 도구를 잃는다.
  const world = fakeWorld({
    processes: baseProcesses,
    startsStopped: true,
    lostStarts: 1,
    healthPid: OLD_DAEMON_PID,
    exitsAfterMs: 1000,
  });
  const handle = await runUpgrade(world);
  assert.equal(handle.started, true);
  assert.equal(world.spawned, 2);
  assert.equal(world.shutdowns, 1);
  assert.deepEqual(world.killed, []);
  assert.deepEqual(world.events, ['spawn', `won:${ANCIENT}`, 'shutdown', 'spawn']);
});

test('기동: 낮은 버전 daemon 이 다시 이기면 더 띄우지 않고 경쟁을 알린다', async () => {
  const world = fakeWorld({
    processes: baseProcesses,
    startsStopped: true,
    lostStarts: 2,
    healthPid: OLD_DAEMON_PID,
    exitsAfterMs: 1000,
  });
  await assert.rejects(
    runUpgrade(world),
    (error: Error) =>
      error instanceof DaemonSetupError &&
      /won the start race/.test(error.message) &&
      error.message.includes(ANCIENT),
  );
  assert.equal(world.spawned, 2, '다시 띄우는 것은 한 번뿐이다');
  assert.equal(world.shutdowns, 1);
});

test('기동: 같은 순간 높은 버전 daemon 이 이기면 내리지 않고 플러그인을 업데이트하라고 알린다', async () => {
  const world = fakeWorld({
    processes: baseProcesses,
    startsStopped: true,
    lostStarts: 1,
    raceWinner: '99.0.0',
  });
  await assert.rejects(runUpgrade(world), /older than the running daemon 99\.0\.0/);
  assert.equal(world.spawned, 1);
  assert.equal(world.shutdowns, 0);
  assert.deepEqual(world.killed, []);
});

test('업그레이드: 억제 신호가 있으면 관측도 종료도 기동도 하지 않는다', async () => {
  for (const env of [
    { ARMA_MCP_NO_AUTOSTART: '1' },
    { ARMA_MCP_TOKEN: '0123456789abcdef0123456789abcdef' },
  ]) {
    const world = fakeWorld({ processes: baseProcesses, listeners: [OLD_DAEMON_PID], env });
    const handle = await runUpgrade(world);
    assert.equal(handle.started, false);
    assert.equal(world.probes, 0);
    assert.equal(world.shutdowns, 0);
    assert.deepEqual(world.killed, []);
    assert.equal(world.spawned, 0);
  }
});

test('업그레이드: 같거나 더 높은 버전 daemon 은 내리지도 끝내지도 않는다', async () => {
  const same = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    daemonVersion: ARMA_MCP_VERSION,
  });
  const handle = await runUpgrade(same);
  assert.equal(handle.started, false);
  assert.equal(same.shutdowns, 0);
  assert.deepEqual(same.killed, []);
  assert.equal(same.spawned, 0);

  const newer = fakeWorld({
    processes: baseProcesses,
    listeners: [OLD_DAEMON_PID],
    daemonVersion: '99.0.0',
  });
  await assert.rejects(runUpgrade(newer), DaemonSetupError);
  assert.equal(newer.shutdowns, 0);
  assert.deepEqual(newer.killed, []);
  assert.equal(newer.spawned, 0);
});
