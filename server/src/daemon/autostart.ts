// autostart.ts — 플러그인 설치만으로 연결되게 하는 relay 측 daemon 부트스트랩.
//
// relay 는 여전히 게임 게이트웨이를 직접 열지 않는다. 아무도 5303 을 듣고 있지 않을 때만
// 같은 번들을 daemon 모드로 detached 실행하고, 파이프/포트 독점이 중복 daemon 을 탈락시킨다.
// 구버전 daemon 을 업그레이드할 때는 /shutdown 을 받아들이고도 남은 그 프로세스 하나만 강제로 끝낸다.

import { execFile } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import { resolveConfigPath, resolveStateDir } from '../config.js';
import { loadMcpToken, tryLoadMcpToken } from './token.js';
import { MCP_VERSION_HEADER } from './httpDaemon.js';
import { spawnDetached, type DetachedProcess } from '../launch/spawn.js';
import { ARMA_MCP_VERSION, compareVersions } from '../version.js';
import { log } from '../log.js';
import { splitCommandLine } from '../cmdline.js';

// 버전 비교는 self-update 경로와 공유하기 위해 version.ts 로 옮겼다.
// 기존 import 경로를 쓰는 호출자와 테스트를 위해 여기서 계속 노출한다.
export { compareVersions };

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 2000;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;
const SHUTDOWN_TIMEOUT_MS = 10_000;
/**
 * /shutdown 을 받아들인 옛 daemon 이 스스로 끝나기를 기다리는 상한(ms). 넘으면 강제로 끝낸다.
 * 0.4.2 부터 daemon 은 2초 유예 뒤 연결을 끊고 끝나므로 보통은 여기까지 가지 않는다.
 */
export const LINGER_KILL_MS = 8_000;
/**
 * health 에 pid 가 없는 0.4.1 이하 daemon 의 상한(ms). 그 daemon 은 진행 중 요청이 없으면 곧바로 끝나고,
 * 있으면 끝나지 않는다. 오래 기다려도 얻는 것이 없고, relay 기동이 호스트의 MCP 기동 제한(흔히 10초)을 넘긴다.
 */
export const LEGACY_LINGER_KILL_MS = 3_000;
/** 강제 종료 뒤 프로세스가 사라지기를 기다리는 상한(ms). */
const KILL_EXIT_WAIT_MS = 5_000;
/**
 * 파이프는 잡혔는데 포트에 아무도 없고 pre-0.3 후보도 없을 때, 다른 relay 가 옛 daemon 을 내리고
 * 새 daemon 을 띄우기를 기다리는 상한(ms).
 */
export const STOPPING_DAEMON_WAIT_MS = 5_000;
const PROCESS_LIST_TIMEOUT_MS = 8_000;
/** 파이프는 잡혔는데 HTTP 는 아직인 자기 daemon 의 기동 구간을 legacy 로 오인하지 않기 위한 확인 대기. */
const PIPE_CONFIRM_MS = 750;
const PIPE_NAMESPACE = '\\\\.\\pipe\\';

/** 관측된 endpoint 상태. daemon 이 아닌 응답과 인증 실패를 구분한다. */
export type DaemonProbe =
  | { kind: 'none' }
  | { kind: 'listening' }
  | { kind: 'healthy'; version: string }
  | { kind: 'unauthorized' }
  | { kind: 'foreign'; status: number }
  /** 게임 파이프는 점유됐는데 MCP 포트에는 아무도 없다 = pre-0.3 서버가 살아 있다. */
  | { kind: 'legacy-pipe'; pids: number[] };

export type DaemonAction =
  | { kind: 'connect' }
  | { kind: 'spawn' }
  | { kind: 'restart' }
  | { kind: 'fail'; reason: string };

/** 이미 원인과 조치를 담고 있는 오류. 호출자가 일반 안내를 덧붙이면 안 된다. */
export class DaemonSetupError extends Error {}

export interface EnsureDaemonOptions {
  cfg: Config;
  endpoint: URL;
  /** daemon 모드로 다시 실행할 진입점. 기본값은 지금 실행 중인 스크립트. */
  entry?: string;
  /** 자식이 반드시 같은 설정을 읽게 명시한다. 기본값은 이 프로세스와 같은 해석 결과. */
  configPath?: string;
  readyTimeoutMs?: number;
  /** 테스트용. 관측과 프로세스 조작을 가짜로 바꿔 끼운다. */
  deps?: Partial<DaemonLifecycleDeps>;
}

/** node.exe 프로세스 하나. 권한이 없어 명령행을 못 읽으면 commandLine 은 빈 문자열이다. */
export interface NodeProcessInfo {
  pid: number;
  commandLine: string;
}

export interface ProcessSnapshot {
  processes: NodeProcessInfo[];
  /** 요청한 TCP 포트를 LISTEN 중인 프로세스 id. 조회하지 않았거나 실패하면 빈 배열. */
  listeners: number[];
}

/** /health 가 알린 daemon 정보. 0.4.1 이하 daemon 은 pid 를 알리지 않는다. */
export interface DaemonHealth {
  version: string;
  pid?: number;
}

/** 옛 daemon 을 내린 결과. current 면 그사이 같거나 높은 버전 daemon 이 답하고 있어 새로 띄울 필요가 없다. */
export type ReplaceOutcome = { kind: 'released' } | { kind: 'current'; version: string };

/** 띄운 뒤 처음 답한 daemon. 동시 기동 경쟁에서 다른 relay 가 띄운 daemon 일 수 있어 버전을 함께 본다. */
export interface DaemonReady {
  token: string;
  version: string;
}

/** ensureDaemon 이 바깥 세계를 보고 건드리는 지점. 기본값은 실제 구현이다. */
export interface DaemonLifecycleDeps {
  env: NodeJS.ProcessEnv;
  /** 이 relay 자신. 어떤 경우에도 종료 대상이 아니다. */
  selfPid: number;
  probe: (endpoint: URL, token: string | null, pipeName?: string) => Promise<DaemonProbe>;
  /** 지금 답하는 daemon 의 /health. 답이 없으면 null. */
  readHealth: (endpoint: URL, token: string) => Promise<DaemonHealth | null>;
  isPipeBusy: (pipeName: string) => boolean;
  snapshot: (port: number) => Promise<ProcessSnapshot>;
  /** /shutdown 을 보내고 daemon 이 받아들였는지(202) 돌려준다. */
  requestShutdown: (endpoint: URL, token: string) => Promise<boolean>;
  isPortOpen: (endpoint: URL) => Promise<boolean>;
  isAlive: (pid: number) => boolean;
  kill: (pid: number) => void;
  spawn: (cfg: Config, entry: string, configPath: string) => Promise<DetachedProcess>;
  /** 어느 daemon 이든 답할 때까지 기다리고 그 token 과 버전을 돌려준다. */
  waitReady: (
    cfg: Config,
    endpoint: URL,
    child: DetachedProcess,
    timeoutMs: number,
  ) => Promise<DaemonReady>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface DaemonHandle {
  token: string;
  /** 이 relay 가 daemon 을 새로 띄웠는지(로그·테스트용). */
  started: boolean;
}

/** 자동 기동을 끄는 신호. ARMA_MCP_TOKEN 은 문서상 원격 터널 사용 신호다. */
export function autostartSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = (env.ARMA_MCP_NO_AUTOSTART ?? '').trim().toLowerCase();
  if (explicit && explicit !== '0' && explicit !== 'false') return true;
  return Boolean(env.ARMA_MCP_TOKEN);
}

/**
 * 관측 결과만 보고 무엇을 할지 정하는 순수 함수. 억제 상태에서는 절대 프로세스를 만들지 않고,
 * 실패 보고는 평소의 요청 경로에 맡긴다.
 */
export function planDaemonAction(input: {
  probe: DaemonProbe;
  ourVersion: string;
  suppressed: boolean;
}): DaemonAction {
  const { probe, ourVersion, suppressed } = input;
  if (suppressed) return { kind: 'connect' };

  switch (probe.kind) {
    case 'healthy': {
      const diff = compareVersions(ourVersion, probe.version);
      if (diff === 0) return { kind: 'connect' };
      if (diff > 0) return { kind: 'restart' };
      return {
        kind: 'fail',
        reason:
          `Arma-MCP relay ${ourVersion} is older than the running daemon ${probe.version}; ` +
          'update this plugin instead of downgrading the daemon',
      };
    }
    case 'unauthorized':
      return {
        kind: 'fail',
        reason:
          'An Arma-MCP daemon is already running with a different bearer token; ' +
          'stop it or set ARMA_MCP_TOKEN to the value it uses',
      };
    case 'foreign':
      return {
        kind: 'fail',
        reason:
          `HTTP ${probe.status} from the MCP port without an Arma-MCP daemon header; ` +
          'another service owns the port — change mcp.port or stop that service',
      };
    case 'listening':
      return {
        kind: 'fail',
        reason:
          'Something is already listening on the MCP port but no daemon token is available; ' +
          'stop that process or set ARMA_MCP_TOKEN',
      };
    case 'legacy-pipe': {
      if (!probe.pids.length) {
        // pre-0.3 서버로 보이는 프로세스가 없다. 업그레이드 중인 옛 daemon 이 아직 끝나지 않은 경우가 더 흔하다.
        return {
          kind: 'fail',
          reason:
            'The Arma game pipe is held but nothing answers on the MCP port. A previous Arma-MCP daemon may ' +
            'still be shutting down, or a pre-0.3 Arma-MCP server holds the pipe. Reconnect in a few seconds. ' +
            'If it persists, run the bundle with the "doctor" argument to find the process.',
        };
      }
      const pids = ` Occupying process ids: ${probe.pids.join(', ')}.`;
      return {
        kind: 'fail',
        reason:
          'The Arma game pipe is held by a pre-0.3 Arma-MCP server, which blocks the shared daemon ' +
          'from starting. Those servers belong to agent sessions that were already open before the ' +
          `plugin was updated. Close those sessions or stop those node processes, then reconnect.${pids} ` +
          'Run the bundle with the "doctor" argument for a full diagnosis.',
      };
    }
    case 'none':
      return { kind: 'spawn' };
  }
}

function healthUrl(endpoint: URL): string {
  return new URL('/health', endpoint).href;
}

function shutdownUrl(endpoint: URL): string {
  return new URL('/shutdown', endpoint).href;
}

export async function isPortOpen(endpoint: URL): Promise<boolean> {
  const port = Number(endpoint.port || 80);
  return new Promise((resolve) => {
    const socket = net.connect({ host: endpoint.hostname, port });
    const settle = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * 게임 파이프 점유 여부. 연결하지 않고 이름만 본다 — 파이프에 실제로 connect 하면 살아 있는
 * gateway 가 그것을 DLL 접속으로 받아 세대를 넘겨 버린다.
 */
export function isPipeBusy(pipeName: string): boolean {
  const target = pipeName.replace(/^\\\\[.?]\\pipe\\/i, '').toLowerCase();
  if (!target) return false;
  try {
    return readdirSync(PIPE_NAMESPACE).some((name) => name.toLowerCase() === target);
  } catch {
    return false; // Windows 가 아니거나 열거 불가 — best-effort.
  }
}

function toPid(value: unknown): number | null {
  const pid = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * node.exe 프로세스 목록과, port 를 주면 그 TCP 포트를 LISTEN 하는 프로세스 id.
 * PowerShell 한 번으로 둘 다 읽는다. 실패하면 빈 결과를 돌려준다(best-effort).
 */
export async function snapshotNodeProcesses(port = 0): Promise<ProcessSnapshot> {
  const listenPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; cmd = [string]$_.CommandLine } })',
    '$listen = @()',
    listenPort
      ? `$listen = @(Get-NetTCPConnection -State Listen -LocalPort ${listenPort} | ` +
        'ForEach-Object { [int]$_.OwningProcess })'
      : '',
    'ConvertTo-Json -Compress -Depth 3 -InputObject @{ procs = $procs; listen = $listen }',
  ]
    .filter(Boolean)
    .join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', timeout: PROCESS_LIST_TIMEOUT_MS, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim() || '{}') as { procs?: unknown; listen?: unknown };
    const procs = Array.isArray(parsed.procs) ? parsed.procs : [];
    const listen = Array.isArray(parsed.listen) ? parsed.listen : [];
    const processes: NodeProcessInfo[] = [];
    for (const entry of procs) {
      const record = (entry ?? {}) as { pid?: unknown; cmd?: unknown };
      const pid = toPid(record.pid);
      if (pid !== null) {
        processes.push({ pid, commandLine: typeof record.cmd === 'string' ? record.cmd : '' });
      }
    }
    const listeners = listen.map(toPid).filter((pid): pid is number => pid !== null);
    return { processes, listeners: [...new Set(listeners)] };
  } catch {
    return { processes: [], listeners: [] };
  }
}

// 기존 import 경로를 쓰는 호출자와 테스트를 위해 여기서도 노출한다.
export { splitCommandLine };

const BUNDLE_ENTRY_RE = /arma-mcp.*[\\/]bundle[\\/]index\.mjs$/i;

/**
 * arma-mcp 번들 index.mjs 를 mode 인자 정확히 'daemon' 으로 실행한 명령행인가.
 * relay, doctor, selfupdate 처럼 다른 모드로 실행한 같은 번들은 해당하지 않는다.
 */
export function isArmaMcpDaemonCommandLine(commandLine: string): boolean {
  const args = splitCommandLine(commandLine);
  const entry = args.findIndex((arg) => BUNDLE_ENTRY_RE.test(arg));
  return entry >= 0 && args[entry + 1] === 'daemon';
}

/**
 * 끝낼 수 있는 옛 daemon 의 pid. health 가 알린 pid 를 먼저 보고, 없으면 MCP 포트의 LISTEN 소유자를 본다.
 * 어느 쪽이든 명령행이 arma-mcp daemon 인 node 프로세스여야 하고, 이 relay 자신은 제외한다.
 * 명령행만으로 고르지 않는 이유: 다른 포트와 설정으로 뜬 daemon 이 같은 컴퓨터에 있을 수 있다.
 */
export function pickDaemonPid(input: {
  snapshot: ProcessSnapshot;
  healthPid?: number;
  selfPid: number;
}): number | null {
  const daemons = new Set(
    input.snapshot.processes
      .filter((p) => p.pid !== input.selfPid && isArmaMcpDaemonCommandLine(p.commandLine))
      .map((p) => p.pid),
  );
  const candidates = input.healthPid
    ? [input.healthPid, ...input.snapshot.listeners]
    : input.snapshot.listeners;
  return candidates.find((pid) => daemons.has(pid)) ?? null;
}

/**
 * 파이프를 쥐는 옛 형태의 명령줄인가. arma-mcp 경로의 index.mjs 뒤에 모드 인자가 없거나
 * standalone 이면 그렇다. 모드는 index.mjs 바로 뒤의 첫 인자다(index.ts 의 parseMode).
 * cli, selfupdate, doctor, relay, daemon 처럼 다른 모드를 준 프로세스는 잡지 않는다.
 * 세션 시작 때 relay 와 함께 도는 selfupdate 를 후보로 세면 안 된다.
 * 뒤의 인자에 index.mjs 가 또 나와도 첫 index.mjs 만 본다.
 * docs/daemon.md 의 수동 확인 명령도 같은 규칙을 쓴다.
 */
export function isLegacyOwnerCommandLine(commandLine: string): boolean {
  const lower = commandLine.toLowerCase();
  const at = lower.indexOf('index.mjs');
  if (at < 0 || !lower.slice(0, at).includes('arma-mcp')) return false;
  const rest = commandLine.slice(at + 'index.mjs'.length).replace(/^"/, '');
  return /^\s*("?(--mode=)?standalone\b.*)?$/i.test(rest);
}

/**
 * 파이프를 쥐고 있을 만한 옛 형태 프로세스의 PID. 모드 인자가 붙은 프로세스는 제외한다.
 * 명령줄 판정은 isLegacyOwnerCommandLine 한 곳에서 한다.
 * 실패해도 진단 문구는 그대로 쓸모 있으므로 best-effort 로 둔다.
 */
export async function legacyOwnerPids(): Promise<number[]> {
  const { processes } = await snapshotNodeProcesses();
  return processes
    .filter(({ commandLine }) => isLegacyOwnerCommandLine(commandLine))
    .map(({ pid }) => pid);
}

/**
 * daemon 판별. client version 헤더는 일부러 보내지 않는다 — 구버전 daemon 도 409 대신
 * 정상 /health 로 자기 버전을 알려주게 해서 업그레이드 판단을 할 수 있다.
 *
 * pipeName 을 주면, MCP 포트가 죽어 있는데 게임 파이프만 잡혀 있는 pre-0.3 상황까지 구분한다.
 */
export async function probeDaemon(
  endpoint: URL,
  token: string | null,
  pipeName?: string,
): Promise<DaemonProbe> {
  const probe = await probeEndpoint(endpoint, token);
  if (probe.kind !== 'none' || !pipeName || !isPipeBusy(pipeName)) return probe;

  // 우리 daemon 도 파이프를 먼저 잡고 HTTP 를 나중에 연다. 한 번 더 확인하고 확정한다.
  await new Promise((resolve) => setTimeout(resolve, PIPE_CONFIRM_MS));
  const second = await probeEndpoint(endpoint, token);
  if (second.kind !== 'none') return second;
  if (!isPipeBusy(pipeName)) return second;
  return { kind: 'legacy-pipe', pids: await legacyOwnerPids() };
}

async function probeEndpoint(endpoint: URL, token: string | null): Promise<DaemonProbe> {
  if (!token) {
    return (await isPortOpen(endpoint)) ? { kind: 'listening' } : { kind: 'none' };
  }
  try {
    const response = await fetch(healthUrl(endpoint), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const version = response.headers.get(MCP_VERSION_HEADER);
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401) return { kind: 'unauthorized' };
    if (response.ok && version) return { kind: 'healthy', version };
    if (!version) return { kind: 'foreign', status: response.status };
    return { kind: 'healthy', version };
  } catch {
    return (await isPortOpen(endpoint)) ? { kind: 'listening' } : { kind: 'none' };
  }
}

/** 지금 답하는 daemon 의 /health. 답이 없거나 버전 헤더가 없으면 null. 0.4.1 이하 daemon 은 pid 가 없다. */
async function readHealth(endpoint: URL, token: string): Promise<DaemonHealth | null> {
  try {
    const response = await fetch(healthUrl(endpoint), {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const version = response.headers.get(MCP_VERSION_HEADER);
    if (!response.ok || !version) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const body = (await response.json()) as { pid?: unknown };
    const pid = typeof body.pid === 'number' ? toPid(body.pid) : null;
    return pid === null ? { version } : { version, pid };
  } catch {
    return null;
  }
}

/** /shutdown 을 보낸다. daemon 이 202 로 받아들였을 때만 true. */
async function postShutdown(endpoint: URL, token: string): Promise<boolean> {
  try {
    const response = await fetch(shutdownUrl(endpoint), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 202 && response.headers.get(MCP_VERSION_HEADER) !== null;
  } catch (error) {
    log.warn('[autostart] shutdown request failed: ' + String(error));
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 은 프로세스가 있는데 권한이 없다는 뜻이다.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 구버전 daemon 을 내린다. /shutdown 을 받아들이고도 남은 프로세스는 강제로 끝낸다.
 *
 * 0.4.1 이하 daemon 은 진행 중 요청이 남아 있으면 HTTP 포트만 닫고 게임 파이프를 쥔 채 남았다.
 * 그대로 새 daemon 을 띄우면 파이프를 잡지 못하고 죽는다.
 *
 * 끝낼 대상은 /shutdown 을 보내기 전에 정한다(pickDaemonPid). 이유는 둘이다.
 * 포트는 /shutdown 직후 닫혀 더는 소유자를 알려주지 않는다.
 * 뒤에 목록을 다시 읽으면 다른 relay 가 막 띄운 새 daemon 까지 섞인다.
 * 대상을 정하지 못했거나 daemon 이 종료 요청을 받아들이지 않았으면 아무것도 끝내지 않는다.
 * 끝내기 직전에는 그 pid 가 아직 같은 명령행인지 다시 본다. 옛 daemon 이 끝난 뒤 pid 가 재사용됐을 수 있다.
 *
 * 대상을 정하지 못해도 옛 daemon 은 게임 파이프를 쥔 채 남아 있을 수 있다. 그래서 돌아가기 전에
 * 파이프가 풀리거나 다른 relay 가 띄운 새 daemon 이 답할 때까지 기다린다.
 */
export async function replaceOldDaemon(
  endpoint: URL,
  token: string,
  deps: DaemonLifecycleDeps,
  pipeName?: string,
): Promise<ReplaceOutcome> {
  const port = Number(endpoint.port || 80);
  const snapshot = await deps.snapshot(port);
  // 목록을 읽는 데 수 초가 걸릴 수 있고, 그사이 다른 relay 가 업그레이드를 마쳤을 수 있다.
  // 지금 답하는 daemon 을 다시 보고, 더는 낮은 버전이 아니면 내리지 않는다.
  const health = await deps.readHealth(endpoint, token);
  if (health && compareVersions(health.version, ARMA_MCP_VERSION) >= 0) {
    return { kind: 'current', version: health.version };
  }
  let target = pickDaemonPid({ snapshot, healthPid: health?.pid, selfPid: deps.selfPid });
  const targetCommandLine = snapshot.processes.find((p) => p.pid === target)?.commandLine ?? '';
  const lingerMs = health?.pid === undefined ? LEGACY_LINGER_KILL_MS : LINGER_KILL_MS;
  const acknowledged = await deps.requestShutdown(endpoint, token);
  const startedAt = deps.now();

  // 같거나 높은 버전 daemon 이 답한 버전. 다른 relay 가 벌써 새 daemon 을 띄운 경우다.
  const seen: { current: string | null } = { current: null };
  const answeredByCurrent = async (): Promise<boolean> => {
    const probe = await deps.probe(endpoint, token);
    if (probe.kind !== 'healthy' || compareVersions(probe.version, ARMA_MCP_VERSION) < 0) {
      return false;
    }
    seen.current = probe.version;
    return true;
  };

  let portReleased = false;
  const released = async (): Promise<boolean> => {
    if (!portReleased) {
      // 새 daemon 이 답하면 포트는 열려 있어도 옛 daemon 은 놓은 것이다.
      portReleased = !(await deps.isPortOpen(endpoint)) || (await answeredByCurrent());
    }
    return portReleased && (target === null || !deps.isAlive(target));
  };
  const waitReleased = async (deadline: number): Promise<boolean> => {
    for (;;) {
      if (await released()) return true;
      if (deps.now() >= deadline) return false;
      await deps.sleep(READY_POLL_MS);
    }
  };

  const mayKill = target !== null && acknowledged;
  const settled = await waitReleased(startedAt + (mayKill ? lingerMs : SHUTDOWN_TIMEOUT_MS));

  if (!settled && mayKill && target !== null && deps.isAlive(target)) {
    const now = await deps.snapshot(0);
    const still = now.processes.find((p) => p.pid === target);
    if (!still || still.commandLine !== targetCommandLine) {
      log.warn(
        `[autostart] pid ${target} no longer runs the previous daemon; not killing it`,
      );
      target = null;
    } else {
      log.warn(
        `[autostart] previous daemon pid ${target} acknowledged shutdown but is still running ` +
          `after ${lingerMs}ms; killing it`,
      );
      try {
        deps.kill(target);
      } catch (error) {
        log.warn(`[autostart] failed to kill pid ${target}: ${String(error)}`);
      }
      if (!(await waitReleased(deps.now() + KILL_EXIT_WAIT_MS)) && deps.isAlive(target)) {
        throw new DaemonSetupError(
          `the previous Arma-MCP daemon (pid ${target}) acknowledged shutdown but could not be stopped; ` +
            'end that process, then reconnect',
        );
      }
    }
  }

  // 프로세스는 끝났거나 손댈 수 없는 대상이다. 남은 것은 포트다.
  const portDeadline = Math.max(startedAt + SHUTDOWN_TIMEOUT_MS, deps.now());
  for (;;) {
    await released();
    if (portReleased) break;
    if (deps.now() >= portDeadline) {
      throw new DaemonSetupError('the previous Arma-MCP daemon did not release the MCP port');
    }
    await deps.sleep(READY_POLL_MS);
  }
  if (target !== null && deps.isAlive(target)) {
    // 종료 요청을 받아들였다는 확인이 없어 끝내지 않는다.
    log.warn(
      `[autostart] previous daemon pid ${target} is still running without acknowledging shutdown; ` +
        'not killing it',
    );
  }

  // 새 daemon 은 파이프를 잡지 못하면 곧바로 끝난다. 옛 daemon 이 파이프를 놓을 때까지 띄우지 않는다.
  if (pipeName && seen.current === null) {
    const pipeDeadline = startedAt + lingerMs + KILL_EXIT_WAIT_MS;
    while (deps.isPipeBusy(pipeName)) {
      if (await answeredByCurrent()) break;
      if (deps.now() >= pipeDeadline) {
        throw new DaemonSetupError(
          `the previous Arma-MCP daemon still holds the game pipe ${pipeName} after it was asked to ` +
            'shut down; end that node process (its command line runs index.mjs with the daemon ' +
            'argument), then reconnect',
        );
      }
      await deps.sleep(READY_POLL_MS);
    }
  }
  return seen.current === null
    ? { kind: 'released' }
    : { kind: 'current', version: seen.current };
}

/**
 * 파이프는 잡혀 있는데 포트에 아무도 없고, pre-0.3 서버로 보이는 프로세스도 없다.
 * 다른 relay 가 업그레이드하느라 내린 옛 daemon 이 아직 끝나지 않은 경우가 대부분이다.
 * 포트가 다시 열리거나 파이프가 풀릴 때까지 잠시 기다린 뒤 다시 판정한다.
 */
async function waitForStoppingDaemon(
  endpoint: URL,
  token: string | null,
  pipeName: string,
  deps: DaemonLifecycleDeps,
): Promise<DaemonProbe> {
  log.info(
    '[autostart] the game pipe is held but nothing answers on the MCP port; ' +
      'waiting for a previous daemon to finish shutting down',
  );
  const deadline = deps.now() + STOPPING_DAEMON_WAIT_MS;
  for (;;) {
    const probe = await deps.probe(endpoint, token);
    if (probe.kind !== 'none' || !deps.isPipeBusy(pipeName)) return probe;
    if (deps.now() >= deadline) return { kind: 'legacy-pipe', pids: [] };
    await deps.sleep(READY_POLL_MS);
  }
}

/** token·로그가 함께 사는 상태 폴더. 없으면 만든다. */
export function stateDir(cfg: Config): string {
  const dir = resolveStateDir(cfg);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function logTail(file: string, lines = 12): string {
  try {
    const text = readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
    return text.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 자식 daemon 에게 물려줄 node 플래그. 로더 관련 플래그만 남긴다 —
 * 테스트 러너가 채워 넣는 `--test-*`, `--inspect-port` 같은 기본값까지 물려주면 안 된다.
 */
export function loaderExecArgv(execArgv: readonly string[] = process.execArgv): string[] {
  const loaderFlag = /^--(require|import|loader|experimental-loader)(=|$)/;
  const kept = new Set<string>();
  for (let i = 0; i < execArgv.length; i += 1) {
    const flag = execArgv[i]!;
    if (!loaderFlag.test(flag)) continue;
    if (flag.includes('=')) {
      kept.add(flag);
      continue;
    }
    const value = execArgv[i + 1];
    if (value === undefined) continue;
    kept.add(`${flag}=${value}`);
    i += 1;
  }
  return [...kept];
}

async function spawnDaemon(
  cfg: Config,
  entry: string,
  configPath: string,
): Promise<DetachedProcess> {
  const dir = stateDir(cfg);
  const out = openSync(path.join(dir, 'daemon.stdout.log'), 'a');
  const err = openSync(path.join(dir, 'daemon.log'), 'a');
  try {
    return await spawnDetached(
      process.execPath,
      [...loaderExecArgv(), entry, 'daemon'],
      {
        stdio: ['ignore', out, err],
        windowsHide: true,
        env: { ...process.env, ARMA_MCP_CONFIG: configPath },
      },
    );
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

/**
 * daemon 이 붙을 때까지 기다린다. token 은 daemon 이 만들므로 매 폴링마다 다시 읽는다.
 * 자식이 먼저 죽어도 곧바로 실패로 단정하지 않는다 — 동시 기동 경쟁에서 진 쪽은
 * 정상적으로 죽고 이긴 daemon 이 서비스 중일 수 있다.
 */
async function waitForDaemon(
  cfg: Config,
  endpoint: URL,
  child: DetachedProcess,
  timeoutMs: number,
): Promise<DaemonReady> {
  const deadline = Date.now() + timeoutMs;
  let lastProbe: DaemonProbe = { kind: 'none' };
  while (Date.now() < deadline) {
    const token = tryLoadMcpToken(cfg);
    if (token) {
      lastProbe = await probeDaemon(endpoint, token);
      if (lastProbe.kind === 'healthy') return { token, version: lastProbe.version };
      if (lastProbe.kind === 'unauthorized') {
        throw new DaemonSetupError(
          'the started daemon uses a different bearer token; remove ARMA_MCP_TOKEN or the stale token file',
        );
      }
    }
    if (child.exitInfo() && !(await isPortOpen(endpoint))) {
      const tail = logTail(path.join(stateDir(cfg), 'daemon.log'));
      throw new DaemonSetupError(
        'the Arma-MCP daemon exited during startup' + (tail ? `:\n${tail}` : ''),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new DaemonSetupError(
    `the Arma-MCP daemon did not become healthy within ${timeoutMs}ms (last probe: ${lastProbe.kind})`,
  );
}

function defaultLifecycleDeps(): DaemonLifecycleDeps {
  return {
    env: process.env,
    selfPid: process.pid,
    probe: probeDaemon,
    readHealth,
    isPipeBusy,
    snapshot: snapshotNodeProcesses,
    requestShutdown: postShutdown,
    isPortOpen,
    isAlive: isProcessAlive,
    kill: (pid) => {
      process.kill(pid);
    },
    spawn: spawnDaemon,
    waitReady: waitForDaemon,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/**
 * 연결 가능한 daemon 을 보장하고 token 을 돌려준다. 필요할 때만 daemon 을 만들거나
 * 업그레이드 재시작한다.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonHandle> {
  const { cfg, endpoint } = options;
  const deps: DaemonLifecycleDeps = { ...defaultLifecycleDeps(), ...options.deps };
  const suppressed = autostartSuppressed(deps.env);
  const token = tryLoadMcpToken(cfg);
  // 억제 상태에서는 관측조차 하지 않는다. 연결 실패 보고는 평소의 요청 경로가 맡는다.
  if (suppressed) return { token: token ?? loadMcpToken(cfg), started: false };

  let probe = await deps.probe(endpoint, token, cfg.pipeName);
  if (probe.kind === 'legacy-pipe' && probe.pids.length === 0) {
    probe = await waitForStoppingDaemon(endpoint, token, cfg.pipeName, deps);
  }
  const action = planDaemonAction({ probe, ourVersion: ARMA_MCP_VERSION, suppressed });

  if (action.kind === 'fail') throw new DaemonSetupError(action.reason);
  if (action.kind === 'connect') {
    // token 이 없으면 loadMcpToken 이 조치 문구가 담긴 표준 오류를 던진다.
    return { token: token ?? loadMcpToken(cfg), started: false };
  }

  const entry = options.entry ?? process.argv[1] ?? '';
  if (!entry) {
    throw new DaemonSetupError('cannot locate the Arma-MCP entrypoint to start the daemon');
  }

  if (action.kind === 'restart') {
    if (!token) throw new DaemonSetupError('cannot restart the daemon without its bearer token');
    log.info(`[autostart] upgrading daemon to ${ARMA_MCP_VERSION}`);
    const outcome = await replaceOldDaemon(endpoint, token, deps, cfg.pipeName);
    if (outcome.kind === 'current') return connectToCurrent(outcome.version, token);
  } else {
    log.info('[autostart] no daemon on ' + endpoint.href + ' — starting one');
  }

  const configPath = options.configPath ?? resolveConfigPath();
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const start = async (): Promise<DaemonReady> => {
    const child = await deps.spawn(cfg, entry, configPath);
    const ready = await deps.waitReady(cfg, endpoint, child, readyTimeoutMs);
    log.info(`[autostart] daemon ${ready.version} ready (pid ${child.pid ?? '?'})`);
    return ready;
  };

  let ready = await start();
  if (compareVersions(ready.version, ARMA_MCP_VERSION) < 0) {
    // 같은 순간 낮은 버전 relay 도 daemon 을 띄웠고 그 daemon 이 파이프를 잡았다.
    // 0.4.2 부터 relay 는 ECONNREFUSED 에 daemon 을 다시 띄우므로 업그레이드 도중에 생길 수 있다.
    // 그 daemon 에 붙으면 첫 요청이 409 로 끝나 이 relay 는 도구를 잃는다. 한 번만 내리고 다시 띄운다.
    log.warn(
      `[autostart] an older daemon ${ready.version} won the start race against ${ARMA_MCP_VERSION}; ` +
        'replacing it once',
    );
    const outcome = await replaceOldDaemon(endpoint, ready.token, deps, cfg.pipeName);
    if (outcome.kind === 'current') return connectToCurrent(outcome.version, ready.token);
    ready = await start();
    if (compareVersions(ready.version, ARMA_MCP_VERSION) < 0) {
      throw new DaemonSetupError(
        `an older Arma-MCP daemon ${ready.version} won the start race against this relay ` +
          `${ARMA_MCP_VERSION} twice; an agent session with the older plugin keeps starting it. ` +
          'Update or close that session, then reconnect',
      );
    }
  }
  // 더 높은 버전 relay 가 띄운 daemon 이 이겼으면 평소처럼 플러그인을 업데이트하라고 알린다.
  rejectNewerDaemon(ready.version);
  return { token: ready.token, started: true };
}

/** 같거나 높은 버전 daemon 이 답한다. 높은 버전이면 플러그인을 업데이트하라는 오류를 던진다. */
function rejectNewerDaemon(version: string): void {
  const next = planDaemonAction({
    probe: { kind: 'healthy', version },
    ourVersion: ARMA_MCP_VERSION,
    suppressed: false,
  });
  if (next.kind === 'fail') throw new DaemonSetupError(next.reason);
}

/** 옛 daemon 을 내리는 사이 다른 relay 가 새 daemon 을 띄웠다. 새로 띄우지 않고 그 daemon 에 붙는다. */
function connectToCurrent(version: string, token: string): DaemonHandle {
  rejectNewerDaemon(version);
  log.info(`[autostart] daemon ${version} is already running; connecting to it`);
  return { token, started: false };
}
