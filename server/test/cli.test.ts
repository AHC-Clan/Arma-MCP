// cli.test.ts: arma-mcp CLI 의 인자, 출력, 종료 코드, 데몬 연결.
//
// 데몬은 같은 프로세스 안에 격리된 포트(0)로 띄우고 게임 대신 가짜 의존성을 쓴다.
// 실제 데몬(5303)과 게임 파이프는 건드리지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from '../src/config.js';
import type { SharedDeps } from '../src/mcp/deps.js';
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { resolveModset } from '../src/launch/mods.js';
import { McpHttpDaemon, MCP_TRANSPORT_HEADER } from '../src/daemon/httpDaemon.js';
import { SessionRegistry } from '../src/daemon/sessionRegistry.js';
import {
  parseResult,
  type ExecOptions,
  type ExecOutcome,
} from '../src/exec/execManager.js';
import { OperationCoordinator } from '../src/launch/operationCoordinator.js';
import { ARMA_MCP_VERSION } from '../src/version.js';
import { runCli, type CliIo } from '../src/cli/main.js';
import {
  normalizePathFlag,
  parseDuration,
  readStdin,
  readTextFile,
  stripBom,
} from '../src/cli/args.js';
import { CliError, EXIT } from '../src/cli/errors.js';
import {
  execExitCode,
  formatDuration,
  rawValue,
  renderExec,
  renderExecRaw,
  renderStatus,
  toolExitCode,
  type ToolPayload,
} from '../src/cli/render.js';
import { parseKeyValueValue, refusalFor } from '../src/cli/commands/call.js';
import { shotFormatFor, writeShot } from '../src/cli/commands/exec.js';
import { parseSince } from '../src/cli/commands/wait.js';
import { renderKill } from '../src/cli/commands/kill.js';
import {
  KILL_RESERVE_MS,
  PLAY_PHASE_DEFAULTS,
  READY_DEFAULT_MS,
  THEN_DEFAULT_MS,
  parseModsFile,
  parsePlayArgs,
  planPlayDeadline,
  renderPlay,
  roleValue,
} from '../src/cli/commands/play.js';
import { CliContext } from '../src/cli/context.js';
import {
  connectError,
  openCliSession,
  toCliError,
  versionSkewMessage,
  type CallOptions,
  type CliSession,
} from '../src/cli/session.js';
import { READY_DEFAULT_TIMEOUT_MS, THEN_DEFAULT_TIMEOUT_MS } from '../src/launch/playFollowUps.js';
import { KILL_WAIT_MS } from '../src/procs.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = '0123456789abcdef0123456789abcdef';
const WRONG_TOKEN = 'fedcba9876543210fedcba9876543210';

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

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// ── 입출력 ─────────────────────────────────────────────

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

function textSink(): { write(chunk: string): boolean; text(): string } {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(''),
  };
}

/** 터미널 표준 입력. 읽으려 하면 테스트가 실패한다. */
const TTY_STDIN = {
  isTTY: true,
  [Symbol.asyncIterator](): AsyncIterator<string> {
    throw new Error('the CLI must not read a terminal stdin');
  },
};

function noConfig(): Config {
  throw new Error('this command must not load the config');
}

async function cli(argv: string[], io: Partial<CliIo> = {}): Promise<Captured> {
  const stdout = textSink();
  const stderr = textSink();
  const code = await runCli(argv, {
    stdout,
    stderr,
    stdin: TTY_STDIN,
    env: {},
    cwd: tmpdir(),
    platform: 'win32',
    loadConfig: noConfig,
    ...io,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// ── 가짜 데몬 ──────────────────────────────────────────

interface ExecProbe {
  /** exec 에 들어온 코드. */
  codes: string[];
  /** 끝나지 않는 exec 가 받은 취소 신호. */
  signals: AbortSignal[];
}

function outcome(result: string, extra: Partial<ExecOutcome> = {}): ExecOutcome {
  return {
    ok: true,
    timedOut: false,
    completedBy: 'first',
    durationMs: 3,
    reqId: 'cli1-abc123',
    results: [{ machine: 'server', result, parsed: parseResult(result) }],
    rptErrors: [],
    rptCursor: { file: 'C:\\Arma 3\\arma3_x64.rpt', offset: 1234 },
    sanitized: false,
    ...extra,
  };
}

function fakeExec(probe: ExecProbe) {
  return (opts: ExecOptions): Promise<ExecOutcome> => {
    probe.codes.push(opts.code);
    const code = opts.code.trim();
    if (code === 'wait forever') {
      return new Promise((resolve) => {
        const signal = opts.context?.signal;
        if (!signal) throw new Error('arma_exec must pass a cancellation signal');
        probe.signals.push(signal);
        signal.addEventListener(
          'abort',
          () => resolve(outcome('', { ok: false, results: [], error: 'client session closed' })),
          { once: true },
        );
      });
    }
    // arma_watch 조립 SQF. 정지 신호에는 OK, 조건 HANG_FOREVER 는 취소될 때까지 붙잡고, 나머지는 곧바로 met.
    if (code.includes('AHC_MCP_watch')) {
      if (!code.includes('deleteAt')) return Promise.resolve(outcome('STRING: "OK:1"'));
      if (code.includes('HANG_FOREVER')) {
        return new Promise((resolve) => {
          const signal = opts.context?.signal;
          if (!signal) throw new Error('arma_watch must pass a cancellation signal');
          probe.signals.push(signal);
          signal.addEventListener(
            'abort',
            () => resolve(outcome('', { ok: false, results: [], error: 'client session closed' })),
            { once: true },
          );
        });
      }
      return Promise.resolve(outcome('STRING: "WATCH|met|3|750|1|0|SCALAR: 1"'));
    }
    if (code === '1+1') return Promise.resolve(outcome('SCALAR: 2'));
    if (code === 'quote') return Promise.resolve(outcome('STRING: "say ""hi"" now"'));
    if (code === 'throwme') return Promise.resolve(outcome('ERROR: aborted (see RPT)'));
    if (code === 'nilsoft') {
      return Promise.resolve(
        outcome('<nil>', {
          rptErrors: [{ line: 10, block: [' 1:00:00 Error in expression <x>', ' 1:00:00 Error Undefined variable'] }],
        }),
      );
    }
    return Promise.resolve(outcome('BOOL: true'));
  };
}

function fakeShared(probe: ExecProbe): (cfg: Config, sessions: SessionRegistry) => SharedDeps {
  return (cfg, sessions) => ({
    cfg,
    rptDir: '',
    rptSources: {
      resolve: () => ({ source: 'client', dir: '', re: /\.rpt$/i }),
    } as unknown as SharedDeps['rptSources'],
    gateway: {
      getListenerState: () => 'ok',
      isConnected: () => true,
      generation: () => 1,
      sessionInfoReceived: () => true,
      send: () => true,
      linkPhase: () => 'live',
      connectedVia: () => 'pipe',
      connectedForMs: () => 1000,
      lastFrameAgeMs: () => 10,
    } as unknown as SharedDeps['gateway'],
    telemetry: {
      current: () => ({
        world: 'Altis',
        mission: 'cli_test',
        dedicated: false,
        receivedAt: Date.now(),
      }),
      ace: () => false,
      aceVersion: () => '',
      aceComponents: () => [],
      tacmap: () => null,
      tacmapZeusTool: () => null,
      dllVersion: () => '',
      cba: () => false,
      cacheAgeMs: () => 10,
    } as unknown as SharedDeps['telemetry'],
    exec: {
      pendingCount: () => 0,
      run: fakeExec(probe),
    } as unknown as SharedDeps['exec'],
    launcher: {} as SharedDeps['launcher'],
    mpLauncher: {} as SharedDeps['mpLauncher'],
    playOrchestrator: {} as SharedDeps['playOrchestrator'],
    missionMarker: { cursor: () => null },
    web: { statusInfo: () => ({ state: 'disabled' }) } as unknown as SharedDeps['web'],
    serverStartMs: Date.now() - 65_000,
    sessions,
    operationCoordinator: new OperationCoordinator(),
  });
}

interface DaemonFixture {
  daemon: McpHttpDaemon;
  sessions: SessionRegistry;
  probe: ExecProbe;
  endpoint: URL;
  /** CLI 가 쓸 설정. 포트는 데몬이 실제로 연 포트다. */
  cliConfig(token?: string): Config;
  dir: string;
}

function writeConfig(dir: string, value: unknown): string {
  const file = path.join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}

async function startDaemon(
  mcp: Record<string, unknown> = {},
  opts: { stopGraceMs?: number } = {},
): Promise<DaemonFixture> {
  const dir = tempDir('arma-mcp-cli-');
  const cfg = loadConfig(
    writeConfig(dir, {
      pipeName: `\\\\.\\pipe\\arma_mcp_cli_test_${process.pid}`,
      web: { enabled: false },
      arma: { profilesFile: path.join(dir, 'launch-profiles.json') },
      mcp: { tokenFile: path.join(dir, 'daemon.token'), ...mcp },
    }),
    // 테스트를 돌리는 셸의 ARMA_MCP_* 가 격리된 설정을 덮지 않게 한다.
    { env: {} },
  );
  const sessions = new SessionRegistry();
  const probe: ExecProbe = { codes: [], signals: [] };
  const daemon = new McpHttpDaemon({
    cfg,
    shared: fakeShared(probe)(cfg, sessions),
    sessions,
    token: TOKEN,
    port: 0,
    stopGraceMs: opts.stopGraceMs,
  });
  const address = await daemon.start();
  return {
    daemon,
    sessions,
    probe,
    dir,
    endpoint: new URL(`http://${address.host}:${address.port}${address.mcpPath}`),
    cliConfig(token = TOKEN) {
      const tokenFile = path.join(dir, `cli-${token.slice(0, 4)}.token`);
      writeFileSync(tokenFile, token + '\n', 'utf8');
      return { ...cfg, mcp: { ...cfg.mcp, port: address.port, tokenFile } };
    },
  };
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

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** 설정만 있고 데몬은 없는 격리 설정. */
function isolatedConfig(port: number): Config {
  const dir = tempDir('arma-mcp-cli-none-');
  const tokenFile = path.join(dir, 'daemon.token');
  writeFileSync(tokenFile, TOKEN + '\n', 'utf8');
  return loadConfig(
    writeConfig(dir, {
      pipeName: `\\\\.\\pipe\\arma_mcp_cli_none_${process.pid}`,
      web: { enabled: false },
      mcp: { port, tokenFile },
    }),
    { env: {} },
  );
}

function assertNoToken(result: Captured, ...tokens: string[]): void {
  for (const token of tokens) {
    assert.ok(!result.stdout.includes(token), 'the token leaked to stdout');
    assert.ok(!result.stderr.includes(token), 'the token leaked to stderr');
  }
}

// ── 인자 ───────────────────────────────────────────────

test('parseDuration 은 ms 숫자와 ms, s, m 단위를 받는다', () => {
  assert.equal(parseDuration('1500'), 1500);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseDuration('9m'), 540_000);
  for (const bad of ['', 'abc', '10h', '-1s', '5 s']) {
    assert.throws(
      () => parseDuration(bad, '--timeout'),
      (error: unknown) => error instanceof CliError && error.exitCode === EXIT.usage,
      bad,
    );
  }
});

test('경로 플래그는 /x/ 를 드라이브로, 상대 경로를 절대 경로로 바꾸고 다른 / 경로는 거부한다', () => {
  const ctx = { cwd: 'E:\\work\\mission', platform: 'win32' as const };
  assert.equal(normalizePathFlag('/d/AHC/test/arm.sqf', '-f', ctx), 'D:\\AHC\\test\\arm.sqf');
  assert.equal(normalizePathFlag('/c', '-f', ctx), 'C:\\');
  assert.equal(normalizePathFlag('test/arm.sqf', '-f', ctx), 'E:\\work\\mission\\test\\arm.sqf');
  assert.equal(normalizePathFlag('..\\x.txt', '--out', ctx), 'E:\\work\\x.txt');
  assert.equal(normalizePathFlag('C:/shots/a.jpg', '--shot', ctx), 'C:\\shots\\a.jpg');
  assert.throws(
    () => normalizePathFlag('/tmp/arsenal.txt', '--out', ctx),
    (error: unknown) =>
      error instanceof CliError &&
      error.exitCode === EXIT.usage &&
      /cygpath -w/.test(error.message) &&
      /\/tmp\/arsenal\.txt/.test(error.message),
  );
  // Windows 가 아니면 셸 경로가 곧 실제 경로다.
  assert.equal(
    normalizePathFlag('/tmp/x.txt', '--out', { cwd: '/home/me', platform: 'linux' }),
    path.resolve('/home/me', '/tmp/x.txt'),
  );
});

test('파일과 표준 입력의 BOM 을 벗긴다', async () => {
  assert.equal(stripBom('\uFEFFhint "a"'), 'hint "a"');
  assert.equal(stripBom('hint "a"'), 'hint "a"');
  const dir = tempDir('arma-mcp-cli-bom-');
  const file = path.join(dir, 'code.sqf');
  writeFileSync(file, '\uFEFF1+1', 'utf8');
  assert.equal(readTextFile(file, '-f'), '1+1');
  assert.equal(await readStdin(Readable.from([Buffer.from('\uFEFF{"a":1}', 'utf8')]), 'x'), '{"a":1}');
  await assert.rejects(
    readStdin(TTY_STDIN, '코드를'),
    (error: unknown) => error instanceof CliError && error.exitCode === EXIT.usage,
  );
  assert.throws(
    () => readTextFile(path.join(dir, 'missing.sqf'), '-f'),
    (error: unknown) => error instanceof CliError && error.exitCode === EXIT.usage,
  );
});

test('모르는 옵션과 모르는 명령과 빈 exec 는 사용법 오류 2 이고 데몬에 붙지 않는다', async () => {
  const unknownFlag = await cli(['exec', '--nope', '1+1']);
  assert.equal(unknownFlag.code, EXIT.usage);
  assert.match(unknownFlag.stderr, /--nope/);
  assert.equal(unknownFlag.stdout, '');

  const missingValue = await cli(['exec', '1+1', '--timeout']);
  assert.equal(missingValue.code, EXIT.usage);
  assert.match(missingValue.stderr, /--timeout/);

  assert.equal((await cli(['frobnicate'])).code, EXIT.usage);
  assert.equal((await cli([])).code, EXIT.usage);
  assert.equal((await cli(['exec'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '-'])).code, EXIT.usage, 'stdin on a terminal is refused');
  assert.equal((await cli(['exec', 'a', 'b'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '1+1', '--mode', 'everyone'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '1+1', '--mode', 'client'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '1+1', '--raw', '--json'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '1+1', '--shot', 'a.jpg'])).code, EXIT.usage);
  assert.equal((await cli(['exec', '1+1', '--timeout', '20m'])).code, EXIT.usage);
  assert.equal((await cli(['status', '--timeout', '5s'])).code, EXIT.usage);
  assert.equal((await cli(['status', '--wait', 'forever'])).code, EXIT.usage);
  assert.equal((await cli(['call'])).code, EXIT.usage);
  assert.equal((await cli(['call', 'arma_status', 'not-a-pair'])).code, EXIT.usage);
  assert.equal((await cli(['call', 'arma_status', '{"a":'])).code, EXIT.usage);
  assert.equal((await cli(['help', 'frobnicate'])).code, EXIT.usage);
});

test('--token 은 어느 자리에서도 거부하고 값을 옮기지 않는다', async () => {
  for (const argv of [
    ['status', '--token', WRONG_TOKEN],
    ['exec', '1+1', `--token=${WRONG_TOKEN}`],
    ['--token', WRONG_TOKEN, 'status'],
  ]) {
    const result = await cli(argv);
    assert.equal(result.code, EXIT.usage, argv.join(' '));
    assert.match(result.stderr, /--token 은 받지 않는다/);
    assertNoToken(result, WRONG_TOKEN);
  }
  // -- 뒤는 코드다. 옵션으로 보지 않는다.
  const code = await cli(['exec', '--', '--token']);
  assert.notEqual(code.code, EXIT.usage);
  assert.doesNotMatch(code.stderr, /--token 은 받지 않는다/);
});

test('call 은 프로세스를 바꾸는 도구와 방송 도구를 종료 코드 2 로 거부한다', async () => {
  const kill = await cli(['call', 'arma_kill', '{}']);
  assert.equal(kill.code, EXIT.usage);
  assert.equal(
    kill.stderr.trim(),
    'arma_kill 은 call 로 부를 수 없다. 프로세스를 바꾸는 도구는 kill 과 play 명령으로만 부른다.',
  );
  for (const tool of [
    'arma_launch',
    'arma_launch_mp',
    'arma_launch_server',
    'arma_play',
    'arma_scaffold_mission',
    'arma_web_open',
    'arma_web_publish',
    'arma_tacmap_subtitle',
    'arma_tacmap_mark',
    'arma_tacmap_open',
    'arma_tacmap_future',
  ]) {
    const result = await cli(['call', tool]);
    assert.equal(result.code, EXIT.usage, tool);
    assert.ok(result.stderr.startsWith(`${tool} `), result.stderr);
    assert.match(result.stderr, /call 로 부를 수 없다/);
  }
  assert.match(refusalFor('arma_launch')!, /^arma_launch 는 call/);
  assert.match(refusalFor('arma_web_open')!, /^arma_web_open 은 call/);
  for (const allowed of ['arma_status', 'arma_exec', 'arma_rpt_wait', 'arma_watch', 'arma_capture']) {
    assert.equal(refusalFor(allowed), null, allowed);
  }
});

test('key=value 의 값은 JSON 으로 읽히면 JSON, 아니면 문자열이다', () => {
  assert.equal(parseKeyValueValue('5000'), 5000);
  assert.equal(parseKeyValueValue('true'), true);
  assert.equal(parseKeyValueValue('"x"'), 'x');
  assert.deepEqual(parseKeyValueValue('[1,2]'), [1, 2]);
  assert.equal(parseKeyValueValue('game'), 'game');
  assert.equal(parseKeyValueValue(''), '');
});

test('help 와 --version 은 데몬 없이 stdout 에 찍는다', async () => {
  const overview = await cli(['help']);
  assert.equal(overview.code, EXIT.ok);
  for (const name of ['status', 'exec', 'call', 'doctor']) assert.match(overview.stdout, new RegExp(`  ${name} `));
  assert.match(overview.stdout, /130 중단/);

  const exec = await cli(['help', 'exec']);
  assert.equal(exec.code, EXIT.ok);
  assert.match(exec.stdout, /--capture/);
  assert.match((await cli(['exec', '--help'])).stdout, /--verify EXPR/);
  assert.match((await cli(['status', '-h'])).stdout, /--wait game/);

  const version = await cli(['--version']);
  assert.equal(version.code, EXIT.ok);
  assert.equal(version.stdout, ARMA_MCP_VERSION + '\n');
  assert.equal(version.stderr, '');
});

test('CLI 소스는 데몬을 띄우거나 게이트웨이를 여는 코드를 가져오지 않는다', () => {
  const dir = path.join(here, '..', 'src', 'cli');
  const files = [
    ...readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => path.join(dir, name)),
    ...readdirSync(path.join(dir, 'commands')).map((name) => path.join(dir, 'commands', name)),
  ];
  assert.ok(files.length >= 8);
  const forbiddenImport = /from '(?:\.\.\/)+(?:daemon\/autostart|runtime|ipc\/gateway|launch\/[^']+)\.js'/;
  const forbiddenCall = /\b(?:ensureDaemon|startSharedRuntime|spawnDaemon|restartDaemon)\s*\(/;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbiddenImport, path.basename(file));
    assert.doesNotMatch(source, forbiddenCall, path.basename(file));
  }
});

// ── 렌더러와 종료 코드 ──────────────────────────────────

function payload(json: unknown, isError = false): ToolPayload {
  return { isError, text: JSON.stringify(json), json, images: [] };
}

test('도구 결과의 종료 코드: busy 4, 대기 초과 5, 실패 1', () => {
  assert.equal(toolExitCode(payload({ ok: true })), EXIT.ok);
  assert.equal(toolExitCode(payload({ ok: false, error: 'x' })), EXIT.failure);
  assert.equal(toolExitCode(payload({}, true)), EXIT.failure);
  assert.equal(
    toolExitCode(payload({ ok: false, busy: { operation: 'arma_play', startedAt: 0, elapsedMs: 1 } })),
    EXIT.busy,
  );
  assert.equal(toolExitCode(payload({ wait: { requested: 'game', timedOut: true } })), EXIT.timeout);
  assert.equal(toolExitCode(payload({ found: false, elapsedMs: 30_000 })), EXIT.timeout);
  assert.equal(toolExitCode(payload({ found: false, error: 'fromOffset needs file' })), EXIT.failure);
  assert.equal(toolExitCode(payload({ ok: true, met: false, reason: 'timeout' })), EXIT.timeout);

  assert.equal(execExitCode(outcome('SCALAR: 2') as unknown as Record<string, unknown>), EXIT.ok);
  assert.equal(execExitCode(outcome('ERROR: x') as unknown as Record<string, unknown>), EXIT.failure);
  assert.equal(
    execExitCode({ ...outcome(''), ok: false, results: [], error: 'game not connected' } as never),
    EXIT.failure,
  );
  assert.equal(execExitCode(outcome('<nil>') as never), EXIT.ok, 'a nil without RPT errors is a normal nil');
  assert.equal(
    execExitCode(outcome('<nil>', { rptErrors: [{ line: 1, block: ['Error in expression'] }] }) as never),
    EXIT.failure,
  );
  assert.equal(
    execExitCode({ ...outcome('BOOL: true'), verify: { result: 'ERROR: x', parsed: { kind: 'error' }, truncated: false } } as never),
    EXIT.failure,
  );
});

test('--raw 값은 STRING 따옴표를 벗기고 "" 를 되돌리며 잘림을 알린다', () => {
  const entry = (result: string) => ({ machine: 'server', result, parsed: parseResult(result) });
  assert.deepEqual(rawValue(entry('SCALAR: 2')), { kind: 'value', text: '2', truncated: false });
  assert.deepEqual(rawValue(entry('STRING: "say ""hi"" now"')), {
    kind: 'value',
    text: 'say "hi" now',
    truncated: false,
  });
  assert.deepEqual(rawValue(entry('STRING: ""')), { kind: 'value', text: '', truncated: false });
  assert.deepEqual(rawValue(entry('ARRAY: [1,"a"]')), { kind: 'value', text: '[1,"a"]', truncated: false });
  assert.deepEqual(rawValue(entry('STRING: "abc ""d ...(truncated)')), {
    kind: 'value',
    text: 'abc "d',
    truncated: true,
  });
  assert.equal(rawValue(entry('<nil>')).kind, 'nil');
  assert.equal(rawValue(entry('ERROR: aborted')).text, 'ERROR: aborted');

  const raw = renderExecRaw(outcome('STRING: "abc ...(truncated)') as never);
  assert.deepEqual(raw.stdout, ['abc']);
  assert.match(raw.stderr.join('\n'), /500자에서 잘렸다/);
});

test('exec 기본 출력은 결과 줄, verify, RPT 오류를 stdout 에 두고 실패는 stderr 로 보낸다', () => {
  const plain = renderExec(outcome('SCALAR: 2') as never);
  assert.deepEqual(plain, { stdout: ['SCALAR: 2'], stderr: [] });

  const all = renderExec(
    {
      ...outcome('SCALAR: 1'),
      results: [
        { machine: 'server', result: 'SCALAR: 1', parsed: parseResult('SCALAR: 1') },
        { machine: 'Alice', result: 'SCALAR: 2', parsed: parseResult('SCALAR: 2') },
      ],
    } as never,
    'all',
  );
  assert.deepEqual(all.stdout, ['server: SCALAR: 1', 'Alice: SCALAR: 2']);

  const failed = renderExec({ ...outcome(''), ok: false, results: [], error: 'game not connected' } as never);
  assert.deepEqual(failed.stdout, []);
  assert.deepEqual(failed.stderr, ['exec 실패: game not connected']);

  const soft = renderExec(
    outcome('<nil>', {
      rptErrors: [{ line: 3, block: [' 0:01:02 Error in expression <x>', ' 0:01:02 Error Undefined variable'] }],
    }) as never,
  );
  assert.deepEqual(soft.stdout.slice(0, 2), ['<nil>', 'RPT 오류 1건']);
  assert.match(soft.stdout.join('\n'), /Undefined variable/);
});

test('status 요약은 4줄, 프로필이 있으면 5줄이다', () => {
  const lines = renderStatus({
    daemon: { version: '0.4.3', uptimeMs: 3_725_000 },
    sessions: { total: 3, byTransport: { relay: 2, 'remote-http': 0, standalone: 0, cli: 1 } },
    linkPhase: 'live',
    mission: { world: 'Altis', mission: 'wc_test' },
    bridgeReady: true,
    dedicatedReady: true,
    armaProcessRunning: true,
    serverProcessRunning: true,
    serverProcessImage: 'arma3server_x64.exe',
    operation: {
      operation: 'arma_play',
      startedAt: 0,
      elapsedMs: 12_000,
      owner: { session: 'a1b2c3d4', transport: 'relay' },
    },
    profiles: ['wc', 'test'],
    wait: { requested: 'dedicated', satisfied: true, elapsedMs: 3200 },
  });
  assert.deepEqual(lines, [
    'daemon   0.4.3, 가동 1시간 2분, 다른 세션 relay 2',
    'game     live, Altis, wc_test, 데디 준비됨, 3.2초 기다림',
    'process  client 실행 중, server 실행 중(arma3server_x64.exe)',
    'lease    arma_play, 주인 relay a1b2c3d4, 12초째',
    'profiles wc, test',
  ]);

  const idle = renderStatus({
    daemon: { version: '0.4.3', uptimeMs: 5000 },
    sessions: { total: 1, byTransport: { relay: 0, cli: 1 } },
    linkPhase: 'none',
    armaProcessRunning: false,
    serverProcessRunning: false,
    operation: null,
    profiles: [],
  });
  assert.deepEqual(idle, [
    'daemon   0.4.3, 가동 5.0초, 다른 세션 없음',
    'game     연결 없음',
    'process  client 꺼짐, server 꺼짐',
    'lease    없음',
  ]);
  assert.equal(formatDuration(450), '450ms');
  assert.equal(formatDuration(45_000), '45초');
  assert.equal(formatDuration(185_000), '3분 5초');
});

test('409 안내는 어느 쪽이 낮은지에 따라 고치는 길을 다르게 말한다', () => {
  assert.equal(
    versionSkewMessage('0.0.1'),
    `CLI ${ARMA_MCP_VERSION} 와 데몬 0.0.1 의 버전이 다르다. ` +
      'CLI 는 다른 세션이 쓰는 데몬을 재시작하지 않는다. 에이전트 세션을 새로 열면 relay 가 데몬을 맞춘다.',
  );
  assert.match(versionSkewMessage('99.0.0'), /CLI 가 더 낮다/);
});

test('캡처 이미지는 지정한 경로에 폴더를 만들어 쓴다', () => {
  const dir = tempDir('arma-mcp-cli-shot-');
  const file = path.join(dir, 'nested', 'shot.jpg');
  const data = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(writeShot({ data: data.toString('base64'), mimeType: 'image/jpeg' }, file), file);
  assert.deepEqual(readFileSync(file), data);
});

// ── 데몬 왕복 ──────────────────────────────────────────

test('status 와 exec 가 격리된 데몬과 왕복하고 끝나면 세션을 닫는다', async () => {
  const fx = await startDaemon();
  try {
    const cfg = fx.cliConfig();
    const status = await cli(['status'], { loadConfig: () => cfg });
    assert.equal(status.code, EXIT.ok, status.stderr);
    const lines = status.stdout.trimEnd().split('\n');
    assert.ok(lines.length === 4 || lines.length === 5, status.stdout);
    assert.match(lines[0]!, new RegExp(`^daemon   ${ARMA_MCP_VERSION.replace(/\./g, '\\.')}, 가동 `));
    assert.equal(lines[1], 'game     live, Altis, cli_test, 브리지 준비됨');
    assert.equal(lines[3], 'lease    없음');
    await until(() => fx.sessions.size() === 0, 2000, 'the cli session was not closed');

    const statusJson = await cli(['status', '--json'], { loadConfig: () => cfg });
    assert.equal(statusJson.code, EXIT.ok);
    assert.equal(statusJson.stdout.trimEnd().split('\n').length, 1);
    assert.equal(JSON.parse(statusJson.stdout).sessions.byTransport.cli, 1);

    const exec = await cli(['exec', '1+1'], { loadConfig: () => cfg });
    assert.equal(exec.code, EXIT.ok, exec.stderr);
    assert.equal(exec.stdout, 'SCALAR: 2\n');
    assert.equal(exec.stderr, '', 'a clean run writes nothing to stderr');
    assert.equal(fx.probe.codes.at(-1), '1+1');

    const unknown = await cli(['call', 'arma_nope'], { loadConfig: () => cfg });
    assert.equal(unknown.code, EXIT.failure);
    assert.match(unknown.stderr, /arma_nope/);

    const raw = await cli(['exec', '1+1', '--raw'], { loadConfig: () => cfg });
    assert.equal(raw.stdout, '2\n');

    const quoted = await cli(['exec', 'quote', '--raw'], { loadConfig: () => cfg });
    assert.equal(quoted.stdout, 'say "hi" now\n');

    const json = await cli(['exec', '1+1', '--json', '--rpt'], { loadConfig: () => cfg });
    assert.equal(json.code, EXIT.ok);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.rptSince, 'C:\\Arma 3\\arma3_x64.rpt:1234');
    assert.deepEqual(parsed.rptCursor, { file: 'C:\\Arma 3\\arma3_x64.rpt', offset: 1234 });

    const rpt = await cli(['exec', '1+1', '--rpt'], { loadConfig: () => cfg });
    assert.match(rpt.stderr, /^rpt: C:\\Arma 3\\arma3_x64\.rpt:1234$/m);

    const failed = await cli(['exec', 'throwme'], { loadConfig: () => cfg });
    assert.equal(failed.code, EXIT.failure);
    const soft = await cli(['exec', 'nilsoft'], { loadConfig: () => cfg });
    assert.equal(soft.code, EXIT.failure);
    assert.match(soft.stdout, /RPT 오류 1건/);

    await until(() => fx.sessions.size() === 0, 2000, 'cli sessions were left open');
  } finally {
    await fx.daemon.stop();
  }
});

test('exec 는 -f 파일과 - 표준 입력의 BOM 을 벗겨 보내고 -- 뒤 코드를 받는다', async () => {
  const fx = await startDaemon();
  try {
    const cfg = fx.cliConfig();
    const dir = tempDir('arma-mcp-cli-code-');
    writeFileSync(path.join(dir, 'arm.sqf'), '\uFEFF1+1', 'utf8');
    const fromFile = await cli(['exec', '-f', 'arm.sqf'], { loadConfig: () => cfg, cwd: dir });
    assert.equal(fromFile.code, EXIT.ok, fromFile.stderr);
    assert.equal(fx.probe.codes.at(-1), '1+1');

    const fromStdin = await cli(['exec', '-', '--raw'], {
      loadConfig: () => cfg,
      stdin: Readable.from([Buffer.from('\uFEFF1+1\n', 'utf8')]),
    });
    assert.equal(fromStdin.stdout, '2\n');
    assert.equal(fx.probe.codes.at(-1), '1+1\n');

    const dashed = await cli(['exec', '--raw', '--', '-1'], { loadConfig: () => cfg });
    assert.equal(dashed.code, EXIT.ok, dashed.stderr);
    assert.equal(fx.probe.codes.at(-1), '-1');

    const outFile = path.join(dir, 'out', 'value.txt');
    const out = await cli(['exec', 'quote', '--raw', '--out', outFile], { loadConfig: () => cfg });
    assert.equal(out.stdout, outFile + '\n');
    assert.equal(readFileSync(outFile, 'utf8'), 'say "hi" now\n');
  } finally {
    await fx.daemon.stop();
  }
});

test('exec --capture 는 캡처가 막혀 있으면 이유를 stderr 에 쓰고 1 로 끝낸다', async () => {
  // 캡처 도구를 꺼 두어 실제 게임 창을 찍지 않는다.
  const fx = await startDaemon({ disableTools: ['arma_capture'] });
  try {
    const temp = tempDir('arma-mcp-cli-temp-');
    const result = await cli(['exec', '1+1', '--capture', '--delay', '0'], {
      loadConfig: () => fx.cliConfig(),
      env: { TEMP: temp },
    });
    assert.equal(result.code, EXIT.failure);
    assert.equal(result.stdout, 'SCALAR: 2\n');
    assert.match(result.stderr, /캡처 실패: arma_capture 가 disableTools 로 꺼져 있다/);
    assert.deepEqual(readdirSync(temp), [], 'no shot file without an image');
  } finally {
    await fx.daemon.stop();
  }
});

test('exec --capture 는 이미지를 TEMP 아래나 --shot 경로에 쓰고 작업 폴더에는 쓰지 않는다', async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const sent: Array<Record<string, unknown>> = [];
  // arma_exec capture 처럼 이미지가 먼저, 결과 JSON 이 뒤에 온다.
  const openSession = async (): Promise<CliSession> => ({
    endpoint: new URL('http://127.0.0.1:1/mcp'),
    async call(_name, args) {
      sent.push(args);
      const isPng = (args.capture as { format?: string }).format === 'png';
      return {
        content: [
          {
            type: 'image',
            data: (isPng ? png : jpeg).toString('base64'),
            mimeType: isPng ? 'image/png' : 'image/jpeg',
          },
          {
            type: 'text',
            text: JSON.stringify({ ...outcome('SCALAR: 2'), capture: { ok: true } }),
          },
        ],
      };
    },
    async close() {},
  });
  const temp = tempDir('arma-mcp-cli-shot-temp-');
  const cwd = tempDir('arma-mcp-cli-shot-cwd-');
  const io = { openSession, env: { TEMP: temp }, cwd };

  const plain = await cli(['exec', '1+1', '--capture'], io);
  assert.equal(plain.code, EXIT.ok, plain.stderr);
  const expected = path.join(temp, 'arma-mcp', 'shot-cli1-abc123.jpg');
  assert.equal(plain.stdout, `SCALAR: 2\nshot: ${expected}\n`);
  assert.equal(plain.stderr, '');
  assert.deepEqual(readFileSync(expected), jpeg);
  assert.deepEqual(sent.at(-1)!.capture, { returnImage: true }, 'no format without --shot');

  const json = await cli(['exec', '1+1', '--capture', '--json'], io);
  assert.equal(json.code, EXIT.ok, json.stderr);
  assert.equal(JSON.parse(json.stdout).shot, expected);

  const raw = await cli(['exec', '1+1', '--capture', '--raw'], io);
  assert.equal(raw.stdout, '2\n');
  assert.equal(raw.stderr, `shot: ${expected}\n`);
  assert.deepEqual(readdirSync(cwd), [], 'the default shot never lands in the work folder');

  // --shot 은 셸의 현재 폴더 기준이다. 확장자로 캡처 형식을 골라 파일 내용과 맞춘다.
  const named = await cli(['exec', '1+1', '--capture', '--delay', '0', '--shot', 'out/after.png'], io);
  assert.equal(named.code, EXIT.ok, named.stderr);
  const target = path.join(cwd, 'out', 'after.png');
  assert.equal(named.stdout, `SCALAR: 2\nshot: ${target}\n`);
  assert.deepEqual(sent.at(-1)!.capture, { returnImage: true, delayMs: 0, format: 'png' });
  assert.deepEqual(readFileSync(target), png);

  const jpg = await cli(['exec', '1+1', '--capture', '--shot', 'a.JPEG'], io);
  assert.equal(jpg.code, EXIT.ok, jpg.stderr);
  assert.deepEqual(sent.at(-1)!.capture, { returnImage: true, format: 'jpeg' });
  assert.deepEqual(readFileSync(path.join(cwd, 'a.JPEG')), jpeg);

  assert.equal(shotFormatFor('C:\\shots\\x.jpg'), 'jpeg');
  assert.equal(shotFormatFor('C:\\shots\\x.PNG'), 'png');
  for (const bad of ['after.gif', 'after', 'after.png.txt']) {
    const result = await cli(['exec', '1+1', '--capture', '--shot', bad], { openSession: neverOpen, cwd });
    assert.equal(result.code, EXIT.usage, bad);
    assert.match(result.stderr, /--shot 파일은 \.jpg, \.jpeg, \.png 로 끝나야 한다/);
  }
});

test('call 은 key=value 인자로 도구를 부르고 rpt_errors 의 lastExec 를 경고한다', async () => {
  const fx = await startDaemon();
  try {
    const cfg = fx.cliConfig();
    const status = await cli(['call', 'arma_status', 'waitFor=none', '--json'], { loadConfig: () => cfg });
    assert.equal(status.code, EXIT.ok, status.stderr);
    assert.equal(JSON.parse(status.stdout).wait.requested, 'none');

    const exec = await cli(['call', 'arma_exec', '{"code":"throwme"}'], { loadConfig: () => cfg });
    assert.equal(exec.code, EXIT.ok, 'a tool result with ok:true is success for call');
    assert.match(exec.stdout, /^\{\n {2}"ok": true/);

    const errors = await cli(['call', 'arma_rpt_errors'], { loadConfig: () => cfg });
    assert.match(errors.stderr, /since:'lastExec' 는 CLI 호출 사이에 이어지지 않는다/);
    const withOffset = await cli(['call', 'arma_rpt_errors', 'file=a.rpt', 'fromOffset=0'], {
      loadConfig: () => cfg,
    });
    assert.doesNotMatch(withOffset.stderr, /lastExec/);
  } finally {
    await fx.daemon.stop();
  }
});

test('중단 신호는 진행 중인 호출을 끊고 세션을 닫은 뒤 130 으로 끝낸다', async () => {
  const fx = await startDaemon();
  try {
    const interrupt = new AbortController();
    const running = cli(['exec', 'wait forever', '--timeout', '10m'], {
      loadConfig: () => fx.cliConfig(),
      interrupt: interrupt.signal,
    });
    await until(() => fx.probe.signals.length === 1, 3000, 'exec did not start');
    const startedAt = Date.now();
    interrupt.abort();
    const result = await running;
    assert.equal(result.code, EXIT.interrupted);
    assert.match(result.stderr, /중단했다/);
    assert.ok(Date.now() - startedAt < 2000, 'shutdown must not wait for the pending call');
    await until(() => fx.probe.signals[0]!.aborted, 2000, 'the exec was not cancelled');
    await until(() => fx.sessions.size() === 0, 2000, 'the cli session was not closed');
  } finally {
    await fx.daemon.stop();
  }
});

// ── 연결 실패 ──────────────────────────────────────────

test('토큰이 틀리면 401 을 종료 코드 3 으로 알리고 토큰을 어디에도 찍지 않는다', async () => {
  const fx = await startDaemon();
  try {
    const result = await cli(['status'], { loadConfig: () => fx.cliConfig(WRONG_TOKEN) });
    assert.equal(result.code, EXIT.connection);
    assert.match(result.stderr, /HTTP 401/);
    assert.equal(result.stdout, '');
    assertNoToken(result, TOKEN, WRONG_TOKEN);

    // 터널로 붙는 셸에는 env 로 맞추라고 알린다.
    const tunnel = await cli(['status'], {
      loadConfig: () => fx.cliConfig(),
      env: { ARMA_MCP_TOKEN: WRONG_TOKEN },
    });
    assert.equal(tunnel.code, EXIT.connection);
    assert.match(tunnel.stderr, /ARMA_MCP_TOKEN 을 에이전트 세션과 같은 값으로 export 한다/);
    assertNoToken(tunnel, TOKEN, WRONG_TOKEN);
    assert.equal(fx.sessions.size(), 0);
  } finally {
    await fx.daemon.stop();
  }
});

test('409 버전 차이와 429 상한은 종료 코드 3 이다', async () => {
  const replies: Array<{ status: number; version: string; body: string }> = [];
  const fake = http.createServer((req, res) => {
    req.resume();
    const reply = replies.shift() ?? { status: 500, version: '', body: '{}' };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (reply.version) headers['x-arma-mcp-version'] = reply.version;
    res.writeHead(reply.status, headers);
    res.end(reply.body);
  });
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const address = fake.address();
  assert.ok(address && typeof address !== 'string');
  const cfg = isolatedConfig(address.port);
  try {
    replies.push({ status: 409, version: '0.0.1', body: '{"error":"version"}' });
    const skew = await cli(['status'], { loadConfig: () => cfg });
    assert.equal(skew.code, EXIT.connection);
    assert.match(skew.stderr, new RegExp(`CLI ${ARMA_MCP_VERSION.replace(/\./g, '\\.')} 와 데몬 0\\.0\\.1 의 버전이 다르다`));
    assertNoToken(skew, TOKEN);

    replies.push({ status: 404, version: '', body: 'not here' });
    const foreign = await cli(['status'], { loadConfig: () => cfg });
    assert.equal(foreign.code, EXIT.connection);
    assert.match(foreign.stderr, /Arma-MCP 데몬이 아닌 응답\(HTTP 404\)/);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }

  const fx = await startDaemon({ maxCliSessions: 1 });
  try {
    // 다른 CLI 명령이 자리를 쥐고 있다.
    const held = await fetch(fx.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [MCP_TRANSPORT_HEADER]: 'cli',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'holder', version: '1.0.0' },
        },
      }),
    });
    assert.equal(held.status, 200);
    await held.text();
    const full = await cli(['status'], { loadConfig: () => fx.cliConfig() });
    assert.equal(full.code, EXIT.connection);
    assert.match(full.stderr, /HTTP 429, mcp\.maxCliSessions=1/);
  } finally {
    await fx.daemon.stop();
  }
});

test('아무것도 듣지 않으면 종료 코드 3 이고 데몬을 띄우지 않는다', async () => {
  const port = await reserveUnusedPort();
  const cfg = isolatedConfig(port);
  const result = await cli(['exec', '1+1'], { loadConfig: () => cfg });
  assert.equal(result.code, EXIT.connection);
  assert.equal(result.stdout, '');
  assert.ok(
    result.stderr.includes(
      `데몬에 연결하지 못했다(127.0.0.1:${port}). CLI 는 데몬을 띄우지 않는다.`,
    ),
    result.stderr,
  );
  assert.match(result.stderr, /arma-mcp doctor/);
  assert.doesNotMatch(result.stderr, /ARMA_MCP_TOKEN 이 설정돼 있어/);
  assertNoToken(result, TOKEN);

  await sleep(1000);
  assert.equal(await portOpen(port), false, 'the CLI must not start a daemon');
  // 포트만 보면 놓친다. 띄운 자식은 이 격리 설정을 모르고 다른 포트를 열기 때문이다.
  // spawnDaemon 은 토큰 파일 옆 상태 폴더에 daemon.log 와 daemon.stdout.log 를 먼저 연다.
  const stateDir = path.dirname(cfg.mcp.tokenFile);

  const tunnel = await cli(['status'], { loadConfig: () => cfg, env: { ARMA_MCP_TOKEN: TOKEN } });
  assert.equal(tunnel.code, EXIT.connection);
  assert.match(tunnel.stderr, /ARMA_MCP_TOKEN 과 ARMA_MCP_CONFIG 를 이 셸에 export 한다/);
  assertNoToken(tunnel, TOKEN);

  // 토큰 파일이 없으면 연결 전에 멈추고 고치는 길을 말한다.
  const noToken = await cli(['status'], {
    loadConfig: () => ({ ...cfg, mcp: { ...cfg.mcp, tokenFile: path.join(tmpdir(), 'nope', 'daemon.token') } }),
  });
  assert.equal(noToken.code, EXIT.connection);
  assert.match(noToken.stderr, /데몬 토큰을 읽지 못했다/);

  assert.deepEqual(
    readdirSync(stateDir).sort(),
    ['config.json', 'daemon.token'],
    'the CLI must not spawn a daemon or write logs into the state folder',
  );
});

test('포트는 받지만 initialize 에 답하지 않는 데몬은 대기 초과가 아니라 연결 문제 3 이다', async () => {
  const sockets = new Set<net.Socket>();
  const hung = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => hung.listen(0, '127.0.0.1', resolve));
  const address = hung.address();
  assert.ok(address && typeof address !== 'string');
  const cfg = isolatedConfig(address.port);
  try {
    for (const env of [{}, { ARMA_MCP_TOKEN: TOKEN }] as NodeJS.ProcessEnv[]) {
      const startedAt = Date.now();
      const error = await openCliSession(cfg, env, { connectTimeoutMs: 300 }).then(
        () => null,
        (e: unknown) => e,
      );
      assert.ok(error instanceof CliError, String(error));
      assert.equal(error.exitCode, EXIT.connection);
      assert.ok(
        error.message.startsWith(
          `데몬이 300ms 안에 initialize 에 답하지 않았다(127.0.0.1:${address.port}).`,
        ),
        error.message,
      );
      assert.match(error.message, /진단은 arma-mcp doctor/);
      assert.doesNotMatch(error.message, /도구 호출/);
      assert.equal(/ARMA_MCP_TOKEN 이 설정돼 있어/.test(error.message), env.ARMA_MCP_TOKEN !== undefined);
      assert.ok(!error.message.includes(TOKEN), 'the token leaked into the message');
      assert.ok(Date.now() - startedAt < 5000, 'connect must give up at its own limit');
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => hung.close(() => resolve()));
  }

  // initialize 의 시간 초과만 3 이다. 도구 호출의 시간 초과는 그대로 5 다.
  const timeout = new McpError(ErrorCode.RequestTimeout, 'Request timed out');
  assert.equal((connectError(timeout, 'h', {}) as CliError).exitCode, EXIT.connection);
  assert.equal((toCliError(timeout, 'h', 60_000) as CliError).exitCode, EXIT.timeout);
  const refused = connectError(new McpError(ErrorCode.InvalidRequest, 'bad'), 'h', {});
  assert.equal((refused as CliError).exitCode, EXIT.connection);
});

test('데몬이 멈추면서 503 으로 답하면 데몬 문구를 싣고 종료 코드 3 으로 끝나며 다시 보내지 않는다', async () => {
  const fx = await startDaemon({}, { stopGraceMs: 300 });
  let stopping: Promise<void> | null = null;
  try {
    const running = cli(['exec', 'wait forever', '--timeout', '10m'], {
      loadConfig: () => fx.cliConfig(),
    });
    await until(() => fx.probe.signals.length === 1, 3000, 'exec did not start');
    stopping = fx.daemon.stop();
    const result = await running;
    assert.equal(result.code, EXIT.connection, result.stderr);
    assert.match(
      result.stderr,
      /데몬이 멈추는 중이다\(HTTP 503, 127\.0\.0\.1:\d+\): Arma-MCP daemon stopped before this request finished; the tool may or may not have run\. CLI 는 명령을 다시 보내지 않는다\./,
    );
    // 이미 돌았을 수 있는 명령을 다시 실행하라고 하지 않는다. arma-mcp status 는 SQF 가 돌았는지 보여 주지 않는다.
    assert.match(result.stderr, /이미 실행됐을 수 있다\. 다시 실행하기 전에 .*게임 상태를 확인한다\./);
    assert.doesNotMatch(result.stderr, /다시 떴는지 본 뒤 다시 실행한다/);
    assert.equal(result.stdout, '');
    assert.deepEqual(fx.probe.codes, ['wait forever'], 'the CLI must not resend the call');
  } finally {
    await (stopping ?? fx.daemon.stop());
  }

  // 멈추는 중에 거절된 요청은 실행되지 않았다고 그대로 알린다.
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Arma-MCP daemon is stopping; this request was not run' },
    id: null,
  });
  const notRun = toCliError(
    new StreamableHTTPError(503, `Error POSTing to endpoint: ${body}`),
    'h',
  ) as CliError;
  assert.equal(notRun.exitCode, EXIT.connection);
  assert.match(
    notRun.message,
    /^데몬이 멈추는 중이다\(HTTP 503, h\): Arma-MCP daemon is stopping; this request was not run\./,
  );
  // 이때만 다시 실행하라고 안내한다.
  assert.match(notRun.message, /arma-mcp status 로 데몬이 다시 떴는지 본 뒤 다시 실행한다\.$/);
  assert.doesNotMatch(notRun.message, /이미 실행됐을 수 있다/);

  // 데몬 문구를 읽지 못하면 실행됐는지 모른다. 다시 실행하라고 하지 않는다.
  const unknown = toCliError(
    new StreamableHTTPError(503, 'Error POSTing to endpoint: Service Unavailable'),
    'h',
  ) as CliError;
  assert.equal(unknown.exitCode, EXIT.connection);
  assert.match(unknown.message, /이미 실행됐을 수 있다/);
  assert.doesNotMatch(unknown.message, /다시 떴는지 본 뒤 다시 실행한다/);
});

// ── 가짜 세션 ──────────────────────────────────────────
//
// wait, kill, play 의 인자 매핑은 데몬 없이 본다. 세션은 호출만 기록하고 준비한 도구 JSON 을 돌려준다.

interface FakeCall {
  name: string;
  args: Record<string, unknown>;
  opts: CallOptions;
}

type Responder = (call: FakeCall, signal: AbortSignal | undefined) => unknown;

function toolResult(json: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(json) }] };
}

function fakeSession(respond: Responder) {
  const calls: FakeCall[] = [];
  let closed = 0;
  const openSession = async (opts: { signal?: AbortSignal }): Promise<CliSession> => ({
    endpoint: new URL('http://127.0.0.1:1/mcp'),
    async call(name, args, callOpts = {}) {
      const call: FakeCall = { name, args, opts: callOpts };
      calls.push(call);
      const signal = callOpts.ignoreInterrupt ? undefined : opts.signal;
      return toolResult(await respond(call, signal));
    },
    async close() {
      closed += 1;
    },
  });
  return { calls, openSession, closed: () => closed };
}

/** 사용법 오류는 세션을 열기 전에 끝나야 한다. */
async function neverOpen(): Promise<CliSession> {
  throw new Error('a usage error must not open a session');
}

const BUSY = {
  ok: false,
  error: 'another launch operation is already in progress',
  busy: {
    operation: 'arma_play',
    startedAt: 0,
    elapsedMs: 12_000,
    owner: { session: 'a1b2c3d4', transport: 'relay' },
  },
};

// ── wait ───────────────────────────────────────────────

test('--since 는 마지막 콜론에서 파일과 오프셋으로 나눈다', () => {
  assert.deepEqual(parseSince('C:\\Arma 3\\arma3_x64.rpt:1234'), {
    file: 'C:\\Arma 3\\arma3_x64.rpt',
    offset: 1234,
  });
  assert.deepEqual(parseSince('a.rpt:0'), { file: 'a.rpt', offset: 0 });
  for (const bad of ['a.rpt', 'a.rpt:', ':5', 'C:\\x.rpt', 'a.rpt:-1', 'a.rpt:1.5']) {
    assert.throws(
      () => parseSince(bad),
      (error: unknown) => error instanceof CliError && error.exitCode === EXIT.usage,
      bad,
    );
  }
});

test('wait rpt 는 --since 를 file 과 fromOffset 으로 보내고 찾으면 0 이다', async () => {
  const fake = fakeSession(() => ({
    found: true,
    file: 'arma3_x64.rpt',
    line: ' 10:00:01 [AHCWC] ready ',
    lineNumber: 42,
    offset: 2000,
    elapsedMs: 800,
    resolvedSource: 'server',
  }));
  const result = await cli(
    [
      'wait',
      'rpt',
      '\\[AHCWC\\] ready',
      '--source',
      'server',
      '--since',
      'C:\\Arma 3\\arma3_x64.rpt:1234',
      '--timeout',
      '30s',
    ],
    { openSession: fake.openSession },
  );
  assert.equal(result.code, EXIT.ok, result.stderr);
  assert.deepEqual(
    fake.calls.map((call) => [call.name, call.args]),
    [
      [
        'arma_rpt_wait',
        {
          pattern: '\\[AHCWC\\] ready',
          timeoutMs: 30_000,
          source: 'server',
          file: 'C:\\Arma 3\\arma3_x64.rpt',
          fromOffset: 1234,
        },
      ],
    ],
  );
  assert.equal(
    result.stdout,
    'rpt "\\[AHCWC\\] ready" 800ms, arma3_x64.rpt\n10:00:01 [AHCWC] ready\n',
  );
  assert.equal(result.stderr, '');
  assert.equal(fake.closed(), 1);

  const json = await cli(['wait', 'rpt', 'x', '--json'], { openSession: fake.openSession });
  assert.equal(JSON.parse(json.stdout).found, true);
});

test('wait rpt 가 시간 안에 못 찾으면 5, 파일이 없거나 도구가 거절하면 1 이다', async () => {
  const plain = fakeSession(() => ({ found: false, file: 'arma3_x64.rpt', elapsedMs: 100_000 }));
  const timedOut = await cli(['wait', 'rpt', 'x', '--file', 'next'], {
    openSession: plain.openSession,
  });
  assert.equal(timedOut.code, EXIT.timeout);
  assert.deepEqual(plain.calls[0]!.args, { pattern: 'x', timeoutMs: 100_000, file: 'next' });
  assert.match(timedOut.stderr, /1분 40초 기다렸지만 rpt 에 "x" 줄이 나오지 않았다/);

  const noFile = await cli(['wait', 'rpt', 'x'], {
    openSession: fakeSession(() => ({
      found: false,
      file: '',
      elapsedMs: 0,
      resolvedSource: 'client',
    })).openSession,
  });
  assert.equal(noFile.code, EXIT.failure);
  assert.match(noFile.stderr, /기다릴 RPT 파일을 찾지 못했다\(source client\)/);

  const refused = await cli(['wait', 'rpt', 'x', '--since', 'a.rpt:0'], {
    openSession: fakeSession(() => ({ found: false, file: '', elapsedMs: 0, error: 'needs file' }))
      .openSession,
  });
  assert.equal(refused.code, EXIT.failure);
  assert.match(refused.stderr, /wait rpt 실패: needs file/);
});

test('wait rpt 의 --file 과 --since 는 셸 기준으로 풀지 않고 /x/ 모양만 드라이브로 바꾼다', async () => {
  const fake = fakeSession(() => ({ found: true, file: 'a.rpt', line: 'x', elapsedMs: 1 }));
  const open = { openSession: fake.openSession, cwd: 'E:\\work' };

  // 이름이나 상대 값은 데몬이 RPT 폴더 아래에서 찾는다. 이 셸의 폴더를 붙이지 않는다.
  await cli(['wait', 'rpt', 'x', '--file', 'logs/a.rpt'], open);
  assert.equal(fake.calls.at(-1)!.args.file, 'logs/a.rpt');
  await cli(['wait', 'rpt', 'x', '--file', 'C:\\Arma 3\\a.rpt'], open);
  assert.equal(fake.calls.at(-1)!.args.file, 'C:\\Arma 3\\a.rpt');

  // bin/arma-mcp 가 Git Bash 변환을 끄므로 /c/... 는 여기서 바꾼다.
  await cli(['wait', 'rpt', 'x', '--file', '/c/Arma 3/a.rpt'], open);
  assert.equal(fake.calls.at(-1)!.args.file, 'C:\\Arma 3\\a.rpt');
  await cli(['wait', 'rpt', 'x', '--since', '/c/Arma 3/a.rpt:77'], open);
  assert.deepEqual(
    { file: fake.calls.at(-1)!.args.file, fromOffset: fake.calls.at(-1)!.args.fromOffset },
    { file: 'C:\\Arma 3\\a.rpt', fromOffset: 77 },
  );

  // 패턴과 call 의 값은 경로가 아니다. / 로 시작해도 그대로 보낸다.
  await cli(['wait', 'rpt', '/ahc_ready/'], open);
  assert.equal(fake.calls.at(-1)!.args.pattern, '/ahc_ready/');
  await cli(['call', 'arma_rpt_search', 'pattern=/foo', 'code="/x"'], open);
  assert.deepEqual(fake.calls.at(-1)!.args, { pattern: '/foo', code: '/x' });
});

test('wait game 과 dedicated 는 arma_status waitFor 로 기다리고 시간 초과는 5 다', async () => {
  const ready = fakeSession(() => ({
    linkPhase: 'live',
    mission: { world: 'Altis', mission: 'm' },
    bridgeReady: true,
    dedicatedReady: true,
    wait: { requested: 'dedicated', satisfied: true, timedOut: false, elapsedMs: 3200 },
  }));
  const ok = await cli(['wait', 'dedicated', '--timeout', '55s', '--deadline', '60s'], {
    openSession: ready.openSession,
  });
  assert.equal(ok.code, EXIT.ok, ok.stderr);
  assert.deepEqual(ready.calls[0]!.args, { waitFor: 'dedicated', timeoutMs: 55_000 });
  assert.equal(ok.stdout, 'game     live, Altis, m, 데디 준비됨, 3.2초 기다림\n');

  const slow = fakeSession(() => ({
    linkPhase: 'none',
    wait: { requested: 'game', satisfied: false, timedOut: true, elapsedMs: 100_000 },
  }));
  const timedOut = await cli(['wait', 'game'], { openSession: slow.openSession });
  assert.equal(timedOut.code, EXIT.timeout);
  assert.deepEqual(slow.calls[0]!.args, { waitFor: 'game', timeoutMs: 100_000 });
  assert.equal(timedOut.stdout, 'game     연결 없음\n');
  assert.match(timedOut.stderr, /game 준비를 1분 40초 기다렸지만 오지 않았다/);
});

test('--deadline 안에 대기 한도와 여유 5초가 들지 않으면 기다리지 않고 2 로 끝낸다', async () => {
  const refused = await cli(['wait', 'game', '--deadline', '60s'], { openSession: neverOpen });
  assert.equal(refused.code, EXIT.usage);
  assert.match(
    refused.stderr,
    /대기 한도\(1분 40초\)에 여유 5초를 더하면 --deadline\(1분 0초\)보다 길다\. --timeout 을 55초 이하로 준다/,
  );
  assert.equal(refused.stdout, '');
  for (const argv of [
    ['wait', 'dedicated', '--timeout', '56s', '--deadline', '60s'],
    ['wait', 'rpt', 'x', '--timeout', '10s', '--deadline', '3s'],
    ['wait', 'sqf', 'x', '--timeout', '10m', '--deadline', '10m'],
    ['wait', 'game', '--deadline', '0'],
  ]) {
    assert.equal((await cli(argv, { openSession: neverOpen })).code, EXIT.usage, argv.join(' '));
  }
});

test('wait 인자 오류는 세션을 열지 않고 2 로 끝낸다', async () => {
  for (const argv of [
    ['wait'],
    ['wait', 'forever'],
    ['wait', 'rpt'],
    ['wait', 'rpt', 'a', 'b'],
    ['wait', 'rpt', '('],
    ['wait', 'rpt', 'x', '--since', 'a.rpt'],
    ['wait', 'rpt', 'x', '--since', 'a.rpt:1', '--file', 'b.rpt'],
    ['wait', 'rpt', 'x', '--source', 'both'],
    ['wait', 'rpt', 'x', '--sample', 'y'],
    ['wait', 'game', '--sample', 'x'],
    ['wait', 'game', '--since', 'a.rpt:1'],
    ['wait', 'dedicated', 'extra'],
    ['wait', 'game', '--timeout', '11m'],
    ['wait', 'sqf'],
    ['wait', 'sqf', ' '],
    ['wait', 'sqf', 'x', '--interval', '10ms'],
    ['wait', 'sqf', 'x', '--interval', '6s'],
    ['wait', 'sqf', 'x', '--timeout', '61m'],
    ['wait', 'sqf', 'x', '--timeout', '500ms'],
    ['wait', 'sqf', 'x', '--source', 'client'],
  ]) {
    const result = await cli(argv, { openSession: neverOpen });
    assert.equal(result.code, EXIT.usage, `${argv.join(' ')}: ${result.stderr}`);
  }
});

test('wait sqf 는 300초 조각으로 이어 부르고 조각마다 같은 watchId 를 쓴다', async () => {
  let n = 0;
  const fake = fakeSession(() => {
    n += 1;
    return n === 1
      ? {
          ok: true,
          met: false,
          reason: 'timeout',
          iterations: 1200,
          samples: ['SCALAR: 0'],
          samplesDropped: 3,
        }
      : { ok: true, met: true, reason: 'met', iterations: 5, samples: ['SCALAR: 1'], samplesDropped: 0 };
  });
  const result = await cli(
    ['wait', 'sqf', 'X_done', '--sample', 'X_count', '--interval', '500', '--timeout', '7m'],
    { openSession: fake.openSession },
  );
  assert.equal(result.code, EXIT.ok, result.stderr);
  assert.equal(fake.calls.length, 2);
  const [first, second] = fake.calls;
  const watchId = first!.args.watchId;
  assert.match(String(watchId), /^cli_[0-9a-f]{8}$/);
  assert.deepEqual(first!.args, {
    condition: 'X_done',
    watchId,
    label: 'cli-wait',
    sample: 'X_count',
    intervalMs: 500,
    timeoutMs: 300_000,
  });
  assert.equal(second!.name, 'arma_watch');
  assert.equal(second!.args.watchId, watchId);
  const rest = Number(second!.args.timeoutMs);
  assert.ok(rest > 110_000 && rest <= 120_000, `second slice ${rest}`);
  const lines = result.stdout.trimEnd().split('\n');
  assert.match(lines[0]!, /^met \S+, 1205회$/);
  assert.equal(lines[1], 'samples SCALAR: 1');
});

test('wait sqf 결과: 시간 초과는 5, 조건식 오류와 실행 실패는 1 이다', async () => {
  const slow = fakeSession(() => ({
    ok: true,
    met: false,
    reason: 'timeout',
    iterations: 20,
    samples: ['SCALAR: 0'],
    samplesDropped: 12,
  }));
  const timedOut = await cli(['wait', 'sqf', 'X', '--timeout', '5s'], {
    openSession: slow.openSession,
  });
  assert.equal(timedOut.code, EXIT.timeout);
  assert.equal(slow.calls.length, 1, 'a 5 s wait is one slice');
  assert.equal(slow.calls[0]!.args.timeoutMs, 5000);
  assert.match(timedOut.stdout, /^timeout \S+, 20회\nsamples SCALAR: 0 \(중간 12개는 버렸다\)\n$/);
  assert.match(timedOut.stderr, /5\.0초 안에 조건이 참이 되지 않았다/);

  const threw = await cli(['wait', 'sqf', 'round allUnits'], {
    openSession: fakeSession(() => ({
      ok: true,
      met: false,
      reason: 'threw:cond',
      iterations: 1,
      samples: [],
      note: 'condition 식이 예외로 종료됐습니다',
      rptErrors: [{ line: 1, block: [' 0:00:01 Error in expression <round allUnits>'] }],
    })).openSession,
  });
  assert.equal(threw.code, EXIT.failure);
  assert.match(threw.stderr, /조건식이 실패했다: threw:cond/);
  assert.match(threw.stderr, /Error in expression/);

  const lost = await cli(['wait', 'sqf', 'X'], {
    openSession: fakeSession(() => ({
      ok: false,
      met: false,
      reason: 'no-result',
      error: 'game not connected',
    })).openSession,
  });
  assert.equal(lost.code, EXIT.failure);
  assert.equal(lost.stdout, '');
  assert.match(lost.stderr, /wait sqf 실패: game not connected/);
});

test('wait sqf 가 중단되면 같은 watchId 로 게임 안 워치를 멈춘 뒤 130 으로 끝낸다', async () => {
  const interrupt = new AbortController();
  const fake = fakeSession((call, signal) => {
    if (call.args.stop !== undefined) return { ok: true, stopped: call.args.stop, ack: 'OK:1' };
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      setImmediate(() => interrupt.abort());
    });
  });
  const result = await cli(['wait', 'sqf', 'X'], {
    openSession: fake.openSession,
    interrupt: interrupt.signal,
  });
  assert.equal(result.code, EXIT.interrupted);
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(fake.calls[1]!.args, { stop: fake.calls[0]!.args.watchId });
  assert.deepEqual(fake.calls[1]!.opts, { ignoreInterrupt: true, timeoutMs: 1500 });
  assert.equal(fake.closed(), 1);
});

test('wait sqf 가 격리된 데몬과 왕복하고 중단 때 게임 안 워치에 정지 신호를 보낸다', async () => {
  const fx = await startDaemon();
  try {
    const cfg = fx.cliConfig();
    const met = await cli(['wait', 'sqf', 'X_done', '--sample', 'X_count'], {
      loadConfig: () => cfg,
    });
    assert.equal(met.code, EXIT.ok, met.stderr);
    assert.match(met.stdout, /^met \S+, 3회\nsamples SCALAR: 1\n$/);
    assert.match(fx.probe.codes.at(-1)!, /"cli_[0-9a-f]{8}"/, 'the caller chose the watch key');

    // 키는 SQF 문자열 리터럴로 심기므로 안전한 문자만 받는다.
    const execCount = fx.probe.codes.length;
    const badKey = await cli(['call', 'arma_watch', 'condition=X', 'watchId=a"b'], {
      loadConfig: () => cfg,
    });
    assert.equal(badKey.code, EXIT.failure);
    assert.equal(fx.probe.codes.length, execCount, 'a rejected key never reaches the game');

    const interrupt = new AbortController();
    const running = cli(['wait', 'sqf', 'HANG_FOREVER'], {
      loadConfig: () => cfg,
      interrupt: interrupt.signal,
    });
    await until(() => fx.probe.signals.length === 1, 3000, 'the watch did not start');
    const watchId = /"(cli_[0-9a-f]{8})"/.exec(fx.probe.codes.at(-1)!)![1]!;
    interrupt.abort();
    const result = await running;
    assert.equal(result.code, EXIT.interrupted);
    assert.ok(fx.probe.signals[0]!.aborted, 'the request cancel reached the exec');
    const stop = fx.probe.codes.find(
      (code) => code.includes(watchId) && !code.includes('deleteAt'),
    );
    assert.ok(stop, 'the CLI sent the stop signal for its own watch');
    assert.match(stop!, /"stop", true/);
    await until(() => fx.sessions.size() === 0, 2000, 'the cli session was not closed');
  } finally {
    await fx.daemon.stop();
  }
});

// ── kill ───────────────────────────────────────────────

test('kill 은 preempt:false 를 늘 보내고 --unlock 을 게임 경로로 바꾼다', async () => {
  const fake = fakeSession(() => ({
    ok: true,
    client: { killed: true, gone: true, waitedMs: 800, detail: 'arma3_x64.exe 종료' },
    server: { killed: false, gone: true, waitedMs: 0, detail: 'arma3server_x64.exe 미실행' },
    unlock: [{ path: 'D:\\mods\\@x', ok: true, waitedMs: 300 }],
    interruptedOperation: null,
  }));
  const result = await cli(
    [
      'kill',
      'client',
      '--unlock',
      'D:/mods/@x',
      '--unlock',
      '/e/y',
      '--unlock',
      'rel\\z',
      '--wait',
      '20s',
    ],
    { openSession: fake.openSession, cwd: 'E:\\work' },
  );
  assert.equal(result.code, EXIT.ok, result.stderr);
  assert.deepEqual(fake.calls[0]!.args, {
    preempt: false,
    target: 'client',
    waitMs: 20_000,
    unlockPaths: ['D:\\mods\\@x', 'E:\\y', 'E:\\work\\rel\\z'],
  });
  assert.equal(
    result.stdout,
    'client   끝냈다, 800ms\nserver   실행 중이 아니었다\nunlock   D:\\mods\\@x 풀림, 300ms\n',
  );
  assert.equal(result.stderr, '');

  const preempt = fakeSession(() => ({ ok: true }));
  assert.equal((await cli(['kill', '--preempt'], { openSession: preempt.openSession })).code, EXIT.ok);
  assert.deepEqual(preempt.calls[0]!.args, { preempt: true });

  for (const argv of [
    ['kill', 'both'],
    ['kill', 'client', 'server'],
    ['kill', '--wait', '2m'],
    ['kill', '--unlock', '/tmp/x'],
  ]) {
    assert.equal((await cli(argv, { openSession: neverOpen })).code, EXIT.usage, argv.join(' '));
  }
});

test('kill 은 lease 가 잡혀 있으면 주인을 알리고 4, 남은 프로세스나 잠금이 있으면 1 이다', async () => {
  const busy = await cli(['kill'], { openSession: fakeSession(() => BUSY).openSession });
  assert.equal(busy.code, EXIT.busy);
  assert.equal(busy.stdout, '');
  assert.match(busy.stderr, /끝내지 않았다: arma_play, 주인 relay a1b2c3d4, 12초째/);
  assert.match(busy.stderr, /--preempt/);

  const stuck = await cli(['kill', '--unlock', 'D:\\mods\\@x'], {
    openSession: fakeSession(() => ({
      ok: false,
      client: { killed: true, gone: false, waitedMs: 15_000, detail: 'taskkill 성공' },
      unlock: [
        { path: 'D:\\mods\\@x', ok: false, waitedMs: 15_000, code: 'EBUSY', reason: '잠김' },
      ],
    })).openSession,
  });
  assert.equal(stuck.code, EXIT.failure);
  assert.match(stuck.stdout, /^client {3}남아 있다: taskkill 성공$/m);
  assert.match(stuck.stderr, /client 프로세스가 아직 남아 있다/);
  assert.match(stuck.stderr, /잠금이 풀리지 않았다: D:\\mods\\@x \(잠김, EBUSY\)/);

  const rendered = renderKill({
    ok: true,
    client: { killed: true, waitedMs: 0, detail: '' },
    interruptedOperation: BUSY.busy,
  });
  assert.deepEqual(rendered.stdout, [
    'client   종료 신호를 보냈다. 사라졌는지는 보지 않았다',
    '끊은 작업 arma_play, 주인 relay a1b2c3d4, 12초째',
  ]);
});

test('터널 연결에서는 게임 기계의 상대 경로를 거부하고 절대 경로는 그대로 보낸다', async () => {
  const env = { ARMA_MCP_TOKEN: TOKEN };
  for (const argv of [
    ['kill', '--unlock', 'mods\\x'],
    ['play', '--mod', '@x'],
    ['play', '--mission', '.\\m.VR'],
    ['play', '--mission', 'sub/m.VR'],
  ]) {
    const result = await cli(argv, { env, openSession: neverOpen });
    assert.equal(result.code, EXIT.usage, argv.join(' '));
    assert.match(result.stderr, /게임 기계의 절대 경로로 준다/);
    assertNoToken(result, TOKEN);
  }

  const kill = fakeSession(() => ({ ok: true }));
  const killed = await cli(
    ['kill', '--unlock', 'D:\\mods\\@x', '--unlock', '/e/y', '--unlock', '\\\\host\\share\\@z'],
    { env, openSession: kill.openSession },
  );
  assert.equal(killed.code, EXIT.ok, killed.stderr);
  assert.deepEqual(kill.calls[0]!.args.unlockPaths, [
    'D:\\mods\\@x',
    'E:\\y',
    '\\\\host\\share\\@z',
  ]);

  // 경로 구분자가 없는 미션 이름은 게임 기계의 missionsDir 에서 찾으므로 그대로 보낸다.
  const play = fakeSession(() => ({ ok: true }));
  await cli(['play', '--mission', 'm.VR', '--mod', 'D:/x'], { env, openSession: play.openSession });
  assert.deepEqual(play.calls[0]!.args, { mission: 'm.VR', mods: ['D:\\x'], modset: 'explicit' });
});

// ── play ───────────────────────────────────────────────

test('play 는 사용자가 준 플래그만 보내고 --setup 은 호출마다 새로 읽는다', async () => {
  const dir = tempDir('arma-mcp-cli-play-');
  const setup = path.join(dir, 'setup.sqf');
  writeFileSync(setup, '\uFEFFhint "x"; true', 'utf8');
  const fake = fakeSession(() => ({ ok: true }));
  const open = { openSession: fake.openSession, cwd: dir };

  await cli(['play', 'wc'], open);
  assert.deepEqual(fake.calls.at(-1)!.args, { profile: 'wc' }, 'no CLI defaults override the profile');

  const full = await cli(
    [
      'play',
      'wc',
      '--mode',
      'mp',
      '--mission',
      '/d/m/x.Altis',
      '--mod',
      '/d/@a',
      '--mod',
      'D:\\@b',
      '--kill',
      '--ready',
      '\\[X\\] ok',
      '--ready-source',
      'server',
      '--ready-timeout',
      '30s',
      '--setup',
      'setup.sqf',
      '--save',
      'wc2',
      '--dry-run',
    ],
    open,
  );
  assert.equal(full.code, EXIT.ok, full.stderr);
  assert.deepEqual(fake.calls.at(-1)!.args, {
    profile: 'wc',
    mode: 'mp',
    mission: 'D:\\m\\x.Altis',
    mods: ['D:\\@a', 'D:\\@b'],
    modset: 'explicit',
    killRunning: true,
    ready: { rpt: '\\[X\\] ok', source: 'server', timeoutMs: 30_000 },
    then: { code: 'hint "x"; true' },
    saveProfile: 'wc2',
    dryRun: true,
  });

  writeFileSync(setup, 'hint "y"; true', 'utf8');
  await cli(['play', '--setup', 'setup.sqf'], open);
  assert.deepEqual(fake.calls.at(-1)!.args, { then: { code: 'hint "y"; true' } });

  // 이름만 준 미션은 이 폴더에 있을 때만 경로로 풀고, 없으면 missionsDir 이름으로 보낸다.
  mkdirSync(path.join(dir, 'here.VR'));
  await cli(['play', '--mission', 'here.VR'], open);
  assert.deepEqual(fake.calls.at(-1)!.args, { mission: path.join(dir, 'here.VR') });
  await cli(['play', '--mission', 'elsewhere.VR'], open);
  assert.deepEqual(fake.calls.at(-1)!.args, { mission: 'elsewhere.VR' });
});

test('play --mods-file 은 줄과 ; 로 나누고 상대 경로는 그 파일 폴더 기준이다', async () => {
  const text = '# 모드 목록\n-mod=D:\\@a;D:\\@b\n\n"E:\\@c"\n// 끈 모드\nrel\\@d\n';
  assert.deepEqual(parseModsFile(text), ['D:\\@a', 'D:\\@b', 'E:\\@c', 'rel\\@d']);

  const dir = tempDir('arma-mcp-cli-mods-');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'mods.txt'), '\uFEFF' + text, 'utf8');
  const fake = fakeSession(() => ({ ok: true }));
  const result = await cli(['play', '--mods-file', 'sub/mods.txt', '--mod', 'F:\\@e'], {
    openSession: fake.openSession,
    cwd: dir,
  });
  assert.equal(result.code, EXIT.ok, result.stderr);
  assert.deepEqual(fake.calls[0]!.args, {
    mods: ['D:\\@a', 'D:\\@b', 'E:\\@c', path.join(dir, 'sub', 'rel', '@d'), 'F:\\@e'],
    modset: 'explicit',
  });

  writeFileSync(path.join(dir, 'empty.txt'), '# nothing\n', 'utf8');
  const empty = await cli(['play', '--mods-file', 'empty.txt'], { openSession: neverOpen, cwd: dir });
  assert.equal(empty.code, EXIT.usage);
  const missing = await cli(['play', '--mods-file', 'nope.txt'], { openSession: neverOpen, cwd: dir });
  assert.equal(missing.code, EXIT.usage);
});

function profilesConfig(profiles: Record<string, unknown>): Config {
  const dir = tempDir('arma-mcp-cli-profiles-');
  const profilesFile = path.join(dir, 'launch-profiles.json');
  writeFileSync(profilesFile, JSON.stringify({ v: 1, profiles }), 'utf8');
  return loadConfig(writeConfig(dir, { arma: { profilesFile }, web: { enabled: false } }), {
    env: {},
  });
}

const SAVED = '2026-09-23T00:00:00.000Z';

test('play --modset 은 --mod 나 모드가 저장된 프로필과 함께 쓰면 사용법 오류다', async () => {
  const cfg = profilesConfig({
    wc: { mode: 'sp', mods: ['D:\\@a'], savedAt: SAVED },
    bare: { mode: 'sp', modset: 'none', savedAt: SAVED },
  });
  const both = await cli(['play', '--modset', 'rpt', '--mod', 'D:\\@a'], { openSession: neverOpen });
  assert.equal(both.code, EXIT.usage);
  assert.match(both.stderr, /--modset 은 --mod, --mods-file 과 함께 쓰지 않는다/);

  const withMods = await cli(['play', 'wc', '--modset', 'rpt'], {
    openSession: neverOpen,
    loadConfig: () => cfg,
  });
  assert.equal(withMods.code, EXIT.usage);
  assert.match(withMods.stderr, /프로필 wc 에는 모드 1개가 저장돼 있어 --modset 과 함께 쓰지 않는다/);

  const fake = fakeSession(() => ({ ok: true }));
  const bare = await cli(['play', 'bare', '--modset', 'rpt'], {
    openSession: fake.openSession,
    loadConfig: () => cfg,
  });
  assert.equal(bare.code, EXIT.ok, bare.stderr);
  assert.deepEqual(fake.calls.at(-1)!.args, { profile: 'bare', modset: 'rpt' });

  // 없는 프로필은 데몬이 있는 이름과 함께 알려 준다.
  await cli(['play', 'ghost', '--modset', 'none'], {
    openSession: fake.openSession,
    loadConfig: () => cfg,
  });
  assert.deepEqual(fake.calls.at(-1)!.args, { profile: 'ghost', modset: 'none' });

  const tunnel = await cli(['play', 'bare', '--modset', 'rpt'], {
    openSession: neverOpen,
    env: { ARMA_MCP_TOKEN: TOKEN },
  });
  assert.equal(tunnel.code, EXIT.usage);
  assert.match(tunnel.stderr, /확인하지 못해 --modset 과 함께 쓰지 않는다/);

  const noProfile = await cli(['play', '--modset', 'rpt'], { openSession: fake.openSession });
  assert.equal(noProfile.code, EXIT.ok);
  assert.deepEqual(fake.calls.at(-1)!.args, { modset: 'rpt' });
});

test('play --mod 는 프로필이 없어도 modset explicit 을 보내 데몬이 그 모드만 쓴다', async () => {
  const fake = fakeSession(() => ({ ok: true }));
  const result = await cli(
    ['play', '--mission', 'D:\\m\\rv.VR', '--mod', '/d/FakeMods/@reviewA', '--dry-run'],
    { openSession: fake.openSession },
  );
  assert.equal(result.code, EXIT.ok, result.stderr);
  const args = fake.calls[0]!.args;
  assert.deepEqual(args, {
    mission: 'D:\\m\\rv.VR',
    mods: ['D:\\FakeMods\\@reviewA'],
    modset: 'explicit',
    dryRun: true,
  });

  // 데몬의 모드 해석을 그대로 거친다. modset 이 빠지면 최근 RPT 나 fallbackMods 로 떨어진다.
  const dir = tempDir('arma-mcp-cli-modset-');
  const cfg = loadConfig(writeConfig(dir, { web: { enabled: false } }), { env: {} });
  const rptDir = tempDir('arma-mcp-cli-modset-rpt-');
  const sent = args as { modset?: 'explicit'; mods?: string[] };
  const resolved = resolveModset(cfg, rptDir, sent);
  assert.equal(resolved.modSource, 'explicit');
  assert.match(resolved.modString, /D:\\FakeMods\\@reviewA/);
  assert.notEqual(
    resolveModset(cfg, rptDir, { mods: sent.mods }).modSource,
    'explicit',
    'without modset the daemon ignores mods',
  );

  // --mods-file 도 같고, 프로필과 함께 줄 때도 같다. 프로필 병합은 explicit 을 그대로 둔다.
  writeFileSync(path.join(dir, 'mods.txt'), 'D:\\@a\n', 'utf8');
  await cli(['play', '--mods-file', 'mods.txt'], { openSession: fake.openSession, cwd: dir });
  assert.deepEqual(fake.calls.at(-1)!.args, { mods: ['D:\\@a'], modset: 'explicit' });
  await cli(['play', 'wc', '--mod', 'D:\\@b'], { openSession: fake.openSession });
  assert.deepEqual(fake.calls.at(-1)!.args, { profile: 'wc', mods: ['D:\\@b'], modset: 'explicit' });
  // 모드를 주지 않으면 modset 도 보내지 않는다. 프로필의 모드가 그대로 쓰인다.
  await cli(['play', 'wc'], { openSession: fake.openSession });
  assert.deepEqual(fake.calls.at(-1)!.args, { profile: 'wc' });
});

test('play --deadline 이 ready 한도를 줄이면 --save 와 함께 쓰지 않는다', async () => {
  const refused = await cli(
    ['play', '--ready', 'X ready', '--ready-timeout', '60s', '--deadline', '2m', '--save', 'dev'],
    { openSession: neverOpen },
  );
  assert.equal(refused.code, EXIT.usage);
  assert.match(refused.stderr, /--deadline 이 ready 한도를 1분 0초에서 \S+로 줄인다/);
  assert.match(refused.stderr, /줄인 한도가 프로필에 남는다/);

  // 프로필에서 온 ready 도 같다.
  const cfg = profilesConfig({
    dev: { mode: 'sp', mods: ['D:\\@a'], ready: { rpt: 'READY', timeoutMs: 60_000 }, savedAt: SAVED },
  });
  const fromProfile = await cli(['play', 'dev', '--deadline', '2m', '--save', 'dev'], {
    openSession: neverOpen,
    loadConfig: () => cfg,
  });
  assert.equal(fromProfile.code, EXIT.usage);

  // 줄이지 않으면 저장해도 된다. ready 는 준 그대로 간다.
  const fake = fakeSession(() => ({ ok: true }));
  const roomy = await cli(
    ['play', '--ready', 'X ready', '--ready-timeout', '60s', '--deadline', '9m', '--save', 'dev'],
    { openSession: fake.openSession },
  );
  assert.equal(roomy.code, EXIT.ok, roomy.stderr);
  assert.deepEqual(fake.calls.at(-1)!.args.ready, { rpt: 'X ready', timeoutMs: 60_000 });
  assert.equal(fake.calls.at(-1)!.args.saveProfile, 'dev');

  // 프로필의 ready 를 줄이지 않으면 보내지 않는다. 데몬이 프로필에서 그대로 얹는다.
  const kept = await cli(['play', 'dev', '--deadline', '9m', '--save', 'dev'], {
    openSession: fake.openSession,
    loadConfig: () => cfg,
  });
  assert.equal(kept.code, EXIT.ok, kept.stderr);
  assert.equal(fake.calls.at(-1)!.args.ready, undefined);

  // 저장하지 않는 실행은 줄인 ready 를 보낸다.
  await cli(['play', 'dev', '--deadline', '2m'], { openSession: fake.openSession, loadConfig: () => cfg });
  const shrunk = fake.calls.at(-1)!.args.ready as { rpt: string; timeoutMs: number };
  assert.equal(shrunk.rpt, 'READY');
  assert.ok(shrunk.timeoutMs < 60_000, `${shrunk.timeoutMs}`);
});

test('play 인자 오류는 세션을 열지 않고 2 로 끝낸다', async () => {
  const dir = tempDir('arma-mcp-cli-play-bad-');
  writeFileSync(path.join(dir, 'empty.sqf'), '\uFEFF  \n', 'utf8');
  writeFileSync(path.join(dir, 'x.sqf'), 'true', 'utf8');
  for (const argv of [
    ['play', 'a', 'b'],
    ['play', 'bad name'],
    ['play', '__proto__'],
    ['play', '--mode', 'coop'],
    ['play', '--modset', 'explicit'],
    ['play', '--ready-source', 'client'],
    ['play', '--ready-timeout', '30s'],
    ['play', '--ready', '('],
    ['play', '--ready', 'x', '--ready-source', 'both'],
    ['play', '--ready', 'x', '--ready-timeout', '10m'],
    ['play', '--mode', 'sp', '--ready', 'x', '--ready-source', 'server'],
    ['play', '--save', 'a/b'],
    ['play', '--setup', 'empty.sqf'],
    ['play', '--setup', 'missing.sqf'],
    ['play', '--mission', '/tmp/m.VR'],
    ['play', '--deadline', '20s'],
    ['play', '--deadline', '59s', '--kill', '--setup', 'x.sqf'],
  ]) {
    const result = await cli(argv, { openSession: neverOpen, cwd: dir });
    assert.equal(result.code, EXIT.usage, `${argv.join(' ')}: ${result.stderr}`);
  }
});

test('play --deadline 은 대기 단계 한도의 합이 남은 시간에 들도록 줄여 보낸다', async () => {
  const fake = fakeSession(() => ({ ok: true }));
  const sum = (args: Record<string, unknown>, keys: string[]): number =>
    keys.reduce((total, key) => total + Number(args[key] ?? 0), 0);

  await cli(['play', '--deadline', '2m'], { openSession: fake.openSession });
  const sp = fake.calls.at(-1)!;
  assert.deepEqual(Object.keys(sp.args).sort(), ['bridgeReadyTimeoutMs', 'waitForNewRptMs']);
  assert.ok(sum(sp.args, ['bridgeReadyTimeoutMs', 'waitForNewRptMs']) <= 120_000 - 5000);
  assert.ok(Number(sp.args.bridgeReadyTimeoutMs) < PLAY_PHASE_DEFAULTS.sp.bridgeReadyTimeoutMs);
  const callTimeout = sp.opts.timeoutMs ?? 0;
  assert.ok(callTimeout <= 120_000 && callTimeout > 110_000, `${callTimeout}`);

  // 넉넉하면 기본값을 그대로 보낸다.
  await cli(['play', '--deadline', '9m'], { openSession: fake.openSession });
  assert.deepEqual(fake.calls.at(-1)!.args, { ...PLAY_PHASE_DEFAULTS.sp });

  const dir = tempDir('arma-mcp-cli-deadline-');
  writeFileSync(path.join(dir, 'setup.sqf'), 'true', 'utf8');
  await cli(
    ['play', '--mode', 'mp', '--ready', 'x', '--setup', 'setup.sqf', '--kill', '--deadline', '9m'],
    { openSession: fake.openSession, cwd: dir },
  );
  const mp = fake.calls.at(-1)!.args;
  const mpKeys = Object.keys(PLAY_PHASE_DEFAULTS.mp);
  for (const key of mpKeys) assert.ok(Number(mp[key]) > 0, key);
  assert.equal(mp.waitForNewRptMs, undefined, 'sp-only phases are not sent to mp');
  const budget = 540_000 - 5000 - KILL_RESERVE_MS - THEN_DEFAULT_MS;
  const readyMs = Number((mp.ready as { timeoutMs: number }).timeoutMs);
  assert.ok(sum(mp, mpKeys) + readyMs <= budget, 'phases and ready fit the budget');
  assert.ok(readyMs < READY_DEFAULT_MS);

  // 프로필의 mode 와 ready 도 이 셸에서 읽어 한도를 줄인다.
  const cfg = profilesConfig({
    mpwc: {
      mode: 'mp',
      mods: ['D:\\@a'],
      ready: { rpt: 'READY', timeoutMs: 120_000 },
      savedAt: SAVED,
    },
  });
  await cli(['play', 'mpwc', '--deadline', '5m'], {
    openSession: fake.openSession,
    loadConfig: () => cfg,
  });
  const fromProfile = fake.calls.at(-1)!.args;
  assert.equal(fromProfile.profile, 'mpwc');
  assert.ok(Number(fromProfile.clientConnectTimeoutMs) > 0, 'the profile mode picks the mp phases');
  const ready = fromProfile.ready as { rpt: string; timeoutMs: number };
  assert.equal(ready.rpt, 'READY');
  assert.ok(ready.timeoutMs < 120_000);
  assert.ok(sum(fromProfile, mpKeys) + ready.timeoutMs <= 300_000 - 5000);

  const tunnel = await cli(['play', 'mpwc', '--deadline', '5m'], {
    openSession: neverOpen,
    env: { ARMA_MCP_TOKEN: TOKEN },
  });
  assert.equal(tunnel.code, EXIT.usage);
  assert.match(tunnel.stderr, /--mode 를 함께 준다/);
  const tunnelMode = await cli(['play', 'mpwc', '--mode', 'mp', '--deadline', '5m'], {
    openSession: fake.openSession,
    env: { ARMA_MCP_TOKEN: TOKEN },
  });
  assert.equal(tunnelMode.code, EXIT.ok, tunnelMode.stderr);

  const plan = planPlayDeadline(60_000, { mode: 'sp', kill: false });
  assert.equal(plan.budgetMs, 55_000);
  assert.ok(Object.values(plan.phases).reduce((a, b) => a + b, 0) <= 55_000);
});

test('play --deadline 이 지나면 호출을 끊고 5 로 끝낸다', async () => {
  const fake = fakeSession(() => {
    throw new CliError(EXIT.timeout, '도구 호출이 2분 안에 끝나지 않았다.');
  });
  const result = await cli(['play', '--deadline', '2m'], { openSession: fake.openSession });
  assert.equal(result.code, EXIT.timeout);
  assert.match(result.stderr, /--deadline 2분 0초 안에 play 가 끝나지 않아 호출을 끊었다/);
  assert.match(result.stderr, /떠 있는 게임은 그대로 두었다/);
});

test('CLI 가 나눠 쓰는 play 기본값은 데몬의 기본값과 같다', () => {
  assert.equal(READY_DEFAULT_MS, READY_DEFAULT_TIMEOUT_MS);
  assert.equal(THEN_DEFAULT_MS, THEN_DEFAULT_TIMEOUT_MS);
  assert.equal(KILL_RESERVE_MS, KILL_WAIT_MS);
  const src = (file: string): string =>
    readFileSync(path.join(here, '..', 'src', 'launch', file), 'utf8');
  const { sp, mp } = PLAY_PHASE_DEFAULTS;
  assert.match(src('launcher.ts'), new RegExp(`waitForNewRptMs \\?\\? ${sp.waitForNewRptMs};`));
  const orchestrator = src('playOrchestrator.ts');
  assert.match(orchestrator, new RegExp(`DEFAULT_SP_BRIDGE_TIMEOUT_MS = ${sp.bridgeReadyTimeoutMs};`));
  assert.match(orchestrator, new RegExp(`DEFAULT_IN_GAME_TIMEOUT_MS = ${mp.inGameTimeoutMs};`));
  const launcher = src('mpLauncher.ts');
  assert.match(launcher, new RegExp(`serverReadyTimeoutMs \\?\\? ${mp.serverReadyTimeoutMs};`));
  assert.match(launcher, new RegExp(`bridgeReadyTimeoutMs \\?\\? ${mp.bridgeReadyTimeoutMs};`));
  assert.match(launcher, new RegExp(`clientConnectTimeoutMs \\?\\? ${mp.clientConnectTimeoutMs};`));
});

const PLAY_OK = {
  ok: true,
  mode: 'sp',
  dryRun: false,
  phase: 'in-game',
  steps: [
    { name: 'mission', ok: true, elapsedMs: 100 },
    { name: 'launched', ok: true, elapsedMs: 2000 },
    { name: 'bridge', ok: true, elapsedMs: 30_000 },
    { name: 'inGame', ok: true, elapsedMs: 2000 },
  ],
  mission: { origin: 'given', ref: 'x.VR', world: 'VR' },
  launch: { ok: true, pid: 1234, modCount: 14, mods: [] },
  inGame: { confirmed: true, waitedMs: 32_000 },
  ready: { ok: true, source: 'client', pattern: '\\[AHCWC\\] extIndex', elapsedMs: 800 },
  rpt: { client: { file: 'x.rpt', errorBlocks: 0, first: [], warningMessages: 2 } },
  then: {
    ok: true,
    exec: {
      ok: true,
      results: [
        {
          machine: 'server',
          result: 'BOOL: true',
          parsed: { kind: 'value', type: 'BOOL', value: 'true' },
        },
      ],
    },
  },
  profile: { file: 'p.json', name: 'wc', saved: 'wc' },
  warnings: ['mission 을 지정해 스캐폴드 인자는 무시했다.'],
  totalMs: 35_000,
};

test('play 결과는 인게임, ready, rpt, then 을 한 줄씩 요약한다', async () => {
  assert.deepEqual(renderPlay(PLAY_OK, 'wc'), {
    stdout: [
      'play wc sp: in-game 34초 (VR, 14 mods, pid 1234)',
      'ready "\\[AHCWC\\] extIndex" 800ms',
      'rpt errors 0',
      'then BOOL: true',
      'profile wc 저장',
    ],
    stderr: ['경고: mission 을 지정해 스캐폴드 인자는 무시했다.'],
  });

  const failed = renderPlay({
    ok: false,
    mode: 'mp',
    dryRun: false,
    phase: 'lobby',
    error: 'in-game timed out',
    nextSteps: '서버는 살려 두었다.',
    steps: [],
    mission: { world: 'Altis' },
    launch: { modCount: 3, client: { pid: 77 } },
    ready: {
      ok: false,
      skipped: true,
      source: 'client',
      pattern: 'x',
      elapsedMs: 0,
      reason: '인게임 실패',
    },
    rpt: { client: { errorBlocks: 1 }, server: { errorBlocks: 2 } },
    then: { ok: false, skipped: true, reason: 'ready 가 실패해 실행하지 않았다' },
    profile: { file: 'p.json', notSaved: '인게임 진입을 확인하지 못해 저장하지 않았다' },
    warnings: [],
    totalMs: 185_000,
  });
  assert.deepEqual(failed.stdout, [
    'play mp: 실패(lobby) 3분 5초 (Altis, 3 mods, pid 77)',
    'ready "x" 건너뜀: 인게임 실패',
    'rpt errors client 1, server 2',
    'then 건너뜀: ready 가 실패해 실행하지 않았다',
  ]);
  assert.deepEqual(failed.stderr, [
    '프로필을 저장하지 않았다: 인게임 진입을 확인하지 못해 저장하지 않았다',
    'play 실패: in-game timed out',
    '서버는 살려 두었다.',
  ]);

  assert.deepEqual(renderPlay({ ok: false, error: '없는 프로필이다: "x"' }), {
    stdout: [],
    stderr: ['play 실패: 없는 프로필이다: "x"'],
  });

  const dry = renderPlay({
    ok: true,
    mode: 'sp',
    dryRun: true,
    phase: 'mission',
    mission: { world: 'VR' },
    launch: { modCount: 2, argString: '-autotest=x' },
    warnings: [],
  });
  assert.deepEqual(dry.stdout, ['play sp: dry-run (VR, 2 mods)', 'args -autotest=x']);

  const ok = await cli(['play', 'wc'], { openSession: fakeSession(() => PLAY_OK).openSession });
  assert.equal(ok.code, EXIT.ok);
  assert.match(ok.stdout, /^play wc sp: in-game 34초/);
  const json = await cli(['play', 'wc', '--json'], {
    openSession: fakeSession(() => PLAY_OK).openSession,
  });
  assert.equal(json.stdout.trimEnd().split('\n').length, 1);
  assert.equal(JSON.parse(json.stdout).then.ok, true);
  const bad = await cli(['play'], {
    openSession: fakeSession(() => ({ ...PLAY_OK, ok: false, error: 'ready 실패: timeout' }))
      .openSession,
  });
  assert.equal(bad.code, EXIT.failure);
  assert.match(bad.stderr, /play 실패: ready 실패: timeout/);
});

test('play 는 lease 가 잡혀 있으면 주인을 알리고 4 로 끝낸다', async () => {
  const busy = await cli(['play', 'wc'], { openSession: fakeSession(() => BUSY).openSession });
  assert.equal(busy.code, EXIT.busy);
  assert.equal(busy.stdout, '');
  assert.match(busy.stderr, /띄우지 않았다: arma_play, 주인 relay a1b2c3d4, 12초째/);
});

test('help 는 wait, kill, play 를 보여 준다', async () => {
  const overview = await cli(['help']);
  for (const name of ['wait', 'kill', 'play']) {
    assert.match(overview.stdout, new RegExp(`  ${name} `));
  }
  assert.match((await cli(['help', 'wait'])).stdout, /--since FILE:OFFSET/);
  assert.match((await cli(['kill', '--help'])).stdout, /--preempt/);
  assert.match((await cli(['play', '-h'])).stdout, /--mods-file FILE/);
  assert.match((await cli(['wait', 'sqf', '--help'])).stdout, /--interval 250/);
});

// ── 스택 ───────────────────────────────────────────────

test('--stack 은 명령 뒤 어디에 두어도 모든 도구 호출에 stack 으로 얹힌다', async () => {
  const fake = fakeSession(() => ({ ok: true, results: [{ machine: 'server', result: 'SCALAR: 2', parsed: { kind: 'value', type: 'SCALAR', value: '2' } }] }));
  const res = await cli(['exec', '1+1', '--stack', 'b', '--raw'], { openSession: fake.openSession });
  assert.equal(res.code, EXIT.ok, res.stderr);
  assert.equal(fake.calls[0]?.args.stack, 'b');
  assert.equal(fake.calls[0]?.args.code, '1+1');

  const eq = fakeSession(() => ({ daemonVersion: '0.5.0', stacks: [] }));
  await cli(['status', '--stack=c'], { openSession: eq.openSession });
  assert.equal(eq.calls[0]?.args.stack, 'c');
});

test('ARMA_MCP_STACK 는 --stack 이 없을 때만 쓰이고, call JSON 의 stack 이 이긴다', async () => {
  const fake = fakeSession(() => ({ daemonVersion: '0.5.0' }));
  await cli(['status'], { openSession: fake.openSession, env: { ARMA_MCP_STACK: 'envstack' } });
  assert.equal(fake.calls[0]?.args.stack, 'envstack');
  await cli(['status', '--stack', 'flag'], { openSession: fake.openSession, env: { ARMA_MCP_STACK: 'envstack' } });
  assert.equal(fake.calls[1]?.args.stack, 'flag');
  await cli(['call', 'arma_mission_info', '{"stack":"json"}', '--stack', 'flag'], { openSession: fake.openSession });
  assert.equal(fake.calls[2]?.args.stack, 'json');
  await cli(['status'], { openSession: fake.openSession });
  assert.equal(fake.calls[3]?.args.stack, undefined, '고르지 않으면 얹지 않는다');
});

test('--stack 값이 없으면 사용법 오류이고 세션을 열지 않는다', async () => {
  for (const argv of [['status', '--stack'], ['status', '--stack', '--json'], ['status', '--stack=']]) {
    assert.equal((await cli(argv, { openSession: neverOpen })).code, EXIT.usage, argv.join(' '));
  }
  // -- 뒤의 --stack 은 코드로 본다.
  const fake = fakeSession(() => ({ ok: true, results: [] }));
  await cli(['exec', '--', '--stack'], { openSession: fake.openSession });
  assert.equal(fake.calls[0]?.args.stack, undefined);
  assert.equal(fake.calls[0]?.args.code, '--stack');
});

test('play --test-mod 와 --clients 를 arma_play 인자로 보낸다', () => {
  const ctx = new CliContext({
    stdout: textSink(),
    stderr: textSink(),
    stdin: TTY_STDIN,
    env: {},
    cwd: 'E:\\work',
    platform: 'win32',
    loadConfig: noConfig,
  });
  const req = parsePlayArgs(
    ['--mode', 'mp', '--test-mod', 'build\\a.pbo', '--test-mod', 'E:\\out\\@x', '--clients', '3'],
    ctx,
  );
  assert.deepEqual(req?.args.testMods, ['E:\\work\\build\\a.pbo', 'E:\\out\\@x']);
  assert.equal(req?.args.clients, 3);
  assert.throws(() => parsePlayArgs(['--clients', '0'], ctx), /--clients/);
  assert.throws(() => parsePlayArgs(['--mode', 'sp', '--clients', '2'], ctx), /mp 에서만/);
});

test('play --role 은 클라 순서대로 roles 가 된다. 숫자는 역할 번호, "" 는 서버 기본 배정이다', () => {
  const ctx = new CliContext({
    stdout: textSink(),
    stderr: textSink(),
    stdin: TTY_STDIN,
    env: {},
    cwd: 'E:\\work',
    platform: 'win32',
    loadConfig: noConfig,
  });
  const req = parsePlayArgs(['--mode', 'mp', '--role', ' Squad Leader ', '--role', '3', '--role', ''], ctx);
  assert.deepEqual(req?.args.roles, ['Squad Leader', 3, null]);
  // clients 는 보내지 않는다. 데몬이 roles 길이로 정한다.
  assert.equal(req?.args.clients, undefined);
  assert.deepEqual(parsePlayArgs(['--role', '분대장'], ctx)?.args.roles, ['분대장']);
  assert.equal(roleValue('0'), 0);
  assert.equal(roleValue('Alpha 1-1'), 'Alpha 1-1');
  assert.throws(() => parsePlayArgs(['--mode', 'sp', '--role', 'x'], ctx), /mp 에서만/);
  assert.throws(
    () => parsePlayArgs(['--mode', 'mp', '--clients', '1', '--role', 'a', '--role', 'b'], ctx),
    /--clients 는 1/,
  );
  assert.throws(() => roleValue('1000'), /999/);
  assert.throws(() => roleValue('x'.repeat(65)), /64/);
});

test('play 결과의 slot 줄은 클라마다 상태와 서버에서 읽은 역할을 적는다', () => {
  const base = {
    ok: true,
    mode: 'mp',
    phase: 'in-game',
    steps: [{ name: 'inGame', ok: true, elapsedMs: 1000 }],
    mission: { world: 'VR' },
    launch: { modCount: 1, client: { pid: 7 } },
    inGame: { confirmed: true },
    warnings: [],
    totalMs: 1000,
  };
  const run = renderPlay({
    ...base,
    dryRun: false,
    autoSlot: {
      requested: true,
      clients: [
        { index: 1, requested: 'OPFOR Rifleman', state: 'assigned', role: 'OPFOR Rifleman' },
        { index: 2, requested: 'medic', state: 'fallback', role: 'Alpha Squad Leader' },
      ],
    },
  });
  assert.equal(run.stdout[1], 'slot 1 assigned "OPFOR Rifleman", 2 fallback "Alpha Squad Leader"');

  const dry = renderPlay({
    ...base,
    dryRun: true,
    phase: 'mission',
    autoSlot: { requested: true, clients: [{ index: 1, requested: '#2' }, { index: 2, requested: 'auto' }] },
  });
  assert.ok(dry.stdout.includes('slot 1 #2, 2 auto'), dry.stdout.join('\n'));

  // 자동 배정을 끈 실행은 slot 줄이 없다.
  const off = renderPlay({ ...base, dryRun: false, autoSlot: { requested: false, clients: [{ index: 1 }] } });
  assert.ok(!off.stdout.some((l) => l.startsWith('slot ')));
});

test('status 는 스택이 여럿이면 스택 줄을 더한다', () => {
  const lines = renderStatus({
    daemonVersion: '0.5.0',
    stack: 'b',
    stacks: [
      { id: 'default', port: 2302, linkPhase: 'live', processes: [{}, {}] },
      { id: 'b', port: 2312, linkPhase: 'pre-bridge', processes: [] },
    ],
  });
  assert.ok(lines.includes('stacks   default(2302, live, 2 프로세스), *b(2312, pre-bridge, 0 프로세스)'), lines.join('\n'));
  assert.ok(!renderStatus({ daemonVersion: '0.5.0', stack: 'default', stacks: [{ id: 'default' }] }).some((l) => l.startsWith('stacks')));
});
