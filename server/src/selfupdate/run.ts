// run.ts — self-update 의 부작용 계층. detached 자식 프로세스가 이 경로를 실행한다.
//
// 판정은 전부 plan.ts 의 순수 함수에 맡기고, 여기서는 순서와 I/O 만 담당한다.
// 모든 외부 접근(파일·git·호스트 CLI)은 SelfUpdateIo 로 주입되므로 테스트는 네트워크 없이
// 명령 시퀀스까지 정확히 검증할 수 있다.

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearNotice,
  cooldownMs,
  isSafeCliName,
  isSafeRemoteUrl,
  isSafeScope,
  planInstallStage,
  planRemoteStage,
  selfUpdateSuppressed,
  shouldCheckRemote,
  urlMismatchNotice,
  type SelfUpdateCache,
  type SelfUpdateResult,
} from './plan.js';
import {
  detectHost,
  readSnapshotVersion,
  type CommandResult,
  type HostAdapter,
  type HostIo,
  type MarketplaceOwner,
} from './hosts.js';
import {
  acquireSelfUpdateLock,
  readSelfUpdateCache,
  writeSelfUpdateCache,
} from './state.js';

const GIT_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 120_000;
const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * git 이 어떤 이유로도 사람을 기다리지 않게 한다. 백그라운드에서 도는 코드가
 * 자격증명 프롬프트에 매달리면 락을 쥔 채 영원히 남는다.
 */
const GIT_BATCH_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new',
};

export interface SelfUpdateIo extends HostIo {
  now(): number;
  readCache(): SelfUpdateCache | null;
  writeCache(value: SelfUpdateCache): boolean;
  acquireLock(): (() => void) | null;
  git(args: string[], opts?: { cwd?: string }): CommandResult;
}

export interface SelfUpdateOutcome {
  result: SelfUpdateResult;
  host: string | null;
  marketplace: string | null;
  pluginName: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  /** 실제로 실행한 호스트 CLI argv. 테스트가 명령 시퀀스를 그대로 검증한다. */
  ran: string[][];
  /** 사용자에게 보여줄 안내(마켓플레이스 URL 불일치 등). 없으면 빈 문자열. */
  notice: string;
}

function outcome(partial: Partial<SelfUpdateOutcome> & { result: SelfUpdateResult }): SelfUpdateOutcome {
  return {
    host: null,
    marketplace: null,
    pluginName: null,
    installedVersion: null,
    latestVersion: null,
    ran: [],
    notice: '',
    ...partial,
  };
}

function parseSha(stdout: string): string | null {
  const first = stdout.trim().split(/\s+/)[0] ?? '';
  return SHA_RE.test(first) ? first.toLowerCase() : null;
}

/**
 * 세션 시작마다 도는 코드가 사용자 작업 트리를 건드리는 사고를 막는다.
 * 호스트 설치 캐시에 있지 않은데 .git 이 있으면 개발 체크아웃이다.
 */
function looksLikeDevCheckout(pluginRoot: string, io: HostIo): boolean {
  return io.exists(path.join(pluginRoot, '.git'));
}

export function performSelfUpdate(input: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  io: SelfUpdateIo;
  cliHint?: string | null;
  force?: boolean;
}): SelfUpdateOutcome {
  const { pluginRoot, env, io, cliHint, force = false } = input;
  const now = io.now();
  const ran: string[][] = [];

  if (!force && selfUpdateSuppressed(env)) return outcome({ result: 'disabled' });

  const adapter = detectHost(pluginRoot, env, cliHint);
  if (!adapter) {
    const result: SelfUpdateResult = looksLikeDevCheckout(pluginRoot, io)
      ? 'dev-checkout'
      : 'unknown-host';
    io.writeCache({ ...(io.readCache() ?? {}), lastCheck: now, lastResult: result });
    return outcome({ result });
  }

  // 락은 어댑터를 확정한 다음에 잡는다 — 판별만 하고 끝날 경로가 락을 점유할 이유가 없다.
  const release = io.acquireLock();
  if (!release) return outcome({ result: 'busy', host: adapter.name });
  try {
    return runWithLock({ pluginRoot, env, io, adapter, force, now, ran });
  } catch {
    // 자동 업데이트는 어떤 실패로도 세션을 막지 않는다.
    return outcome({ result: 'error', host: adapter.name, ran });
  } finally {
    release();
  }
}

function runWithLock(input: {
  pluginRoot: string;
  env: NodeJS.ProcessEnv;
  io: SelfUpdateIo;
  adapter: HostAdapter;
  force: boolean;
  now: number;
  ran: string[][];
}): SelfUpdateOutcome {
  const { pluginRoot, env, io, adapter, force, now, ran } = input;
  const cache = io.readCache();

  const owner = adapter.resolveOwner(pluginRoot, env, io);
  if (!owner) {
    io.writeCache({ ...(cache ?? {}), lastCheck: now, host: adapter.name, lastResult: 'no-marketplace' });
    return outcome({ result: 'no-marketplace', host: adapter.name });
  }

  const base = {
    host: adapter.name,
    marketplace: owner.marketplace,
    pluginName: owner.pluginName,
    installedVersion: owner.installedVersion,
  };

  if (
    !isSafeCliName(adapter.cli) ||
    !isSafeCliName(owner.marketplace) ||
    !isSafeCliName(owner.pluginName) ||
    (owner.scope !== null && !isSafeScope(owner.scope))
  ) {
    io.writeCache({ ...(cache ?? {}), lastCheck: now, host: adapter.name, lastResult: 'unsafe-name' });
    return outcome({ ...base, result: 'unsafe-name' });
  }

  // 스냅샷도 원격도 없으면 갱신해도 버전을 읽을 방법이 없다. CLI 를 부를 이유가 없다.
  if (!owner.snapshotRoot && !owner.sourceUrl) {
    io.writeCache({ ...(cache ?? {}), lastCheck: now, host: adapter.name, lastResult: 'no-marketplace' });
    return outcome({ ...base, result: 'no-marketplace' });
  }

  const finish = (
    result: SelfUpdateResult,
    extra: { latestVersion?: string | null; snapshotSha?: string | null; notice?: string; notify?: { fromVersion: string; toVersion: string } } = {},
  ): SelfUpdateOutcome => {
    const failStreak = result === 'no-remote' ? (cache?.failStreak ?? 0) + 1 : 0;
    const next: SelfUpdateCache = {
      ...(cache ?? {}),
      lastCheck: now,
      installedVersion: owner.installedVersion,
      host: adapter.name,
      lastResult: result,
      failStreak,
    };
    if (extra.snapshotSha) next.snapshotSha = extra.snapshotSha;
    if (extra.latestVersion) next.lastAttemptVersion = extra.latestVersion;
    if (extra.notify) next.notify = extra.notify;
    if (extra.notice && owner.sourceUrl && owner.manifestUrl) {
      // 다음 세션 훅이 한 번 전달하고 지운다. urlNotice 는 같은 쌍의 재알림을 막는 기록이다.
      next.message = extra.notice;
      next.urlNotice = { known: owner.sourceUrl, manifest: owner.manifestUrl };
    }
    io.writeCache(next);
    return outcome({
      ...base,
      result,
      latestVersion: extra.latestVersion ?? null,
      ran,
      notice: extra.notice ?? '',
    });
  };

  const snapshotVersion = (): string | null =>
    owner.snapshotRoot ? readSnapshotVersion(owner.snapshotRoot, owner.pluginName, io) : null;

  const install = (toVersion: string): SelfUpdateOutcome => {
    const args = adapter.installArgs(owner);
    ran.push(args);
    const result = io.hostCli(adapter.cli, args);
    if (!result.ok) return finish('install-failed', { latestVersion: toVersion });
    return finish('updated', {
      latestVersion: toVersion,
      notify: { fromVersion: owner.installedVersion, toVersion },
    });
  };

  // Stage 0 — 스냅샷이 이미 앞서 있으면 네트워크를 볼 필요가 없다.
  // 지난 세션에서 갱신은 됐는데 설치가 실패한 상태를 여기서 자력 복구한다.
  const stage0 = planInstallStage({
    installedVersion: owner.installedVersion,
    snapshotVersion: snapshotVersion(),
  });
  if (stage0.kind === 'install') return install(stage0.toVersion);

  // Stage 1 — 원격 HEAD 가 스냅샷과 같으면 받을 것이 없다. ls-remote 는 객체를 전송하지 않는다.
  let snapshotSha: string | null = null;
  if (owner.sourceUrl) {
    if (!isSafeRemoteUrl(owner.sourceUrl)) return finish('unsafe-name');
    const remote = io.git(['ls-remote', owner.sourceUrl, 'HEAD']);
    const remoteSha = remote.ok ? parseSha(remote.stdout) : null;
    if (owner.snapshotRoot) {
      const local = io.git(['-C', owner.snapshotRoot, 'rev-parse', 'HEAD']);
      snapshotSha = local.ok ? parseSha(local.stdout) : null;
    }
    const stage1 = planRemoteStage({ remoteSha, snapshotSha, force });
    if (stage1.kind === 'skip') {
      if (stage1.result !== 'no-remote') {
        return finish(stage1.result, { snapshotSha: remoteSha ?? snapshotSha });
      }
      const failStreak = (cache?.failStreak ?? 0) + 1;
      const notice = urlMismatchNotice({
        knownUrl: owner.sourceUrl,
        manifestUrl: owner.manifestUrl,
        marketplace: owner.marketplace,
        cache,
        failStreak,
        recoveryCommands: adapter.recoveryCommands(owner.marketplace, owner.manifestUrl ?? '', owner.pluginName),
      });
      return finish('no-remote', { notice });
    }
  }

  // Stage 2 — 마켓플레이스를 실제로 갱신하고 버전을 다시 읽는다.
  const syncArgs = adapter.syncArgs(owner);
  if (!syncArgs) {
    // 로컬 소스는 항상 라이브라 갱신할 것이 없다. Stage 0 이 이미 최종 판정이었다.
    return finish(stage0.result, { snapshotSha });
  }
  ran.push(syncArgs);
  const synced = io.hostCli(adapter.cli, syncArgs);
  if (!synced.ok) return finish('sync-failed', { snapshotSha });

  const refreshedSha = owner.snapshotRoot
    ? parseSha(io.git(['-C', owner.snapshotRoot, 'rev-parse', 'HEAD']).stdout)
    : null;

  const stage2 = planInstallStage({
    installedVersion: owner.installedVersion,
    snapshotVersion: snapshotVersion(),
  });
  if (stage2.kind === 'skip') {
    return finish(stage2.result, { snapshotSha: refreshedSha ?? snapshotSha });
  }
  // Stage 3
  const installed = install(stage2.toVersion);
  return installed;
}

// ---------------------------------------------------------------------------
// 기본 IO — 실제 파일 시스템과 프로세스
// ---------------------------------------------------------------------------

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function toResult(res: ReturnType<typeof spawnSync>): CommandResult {
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code;
  const stdout = typeof res.stdout === 'string' ? res.stdout : (res.stdout?.toString('utf8') ?? '');
  return {
    ok: !res.error && res.status === 0,
    status: typeof res.status === 'number' ? res.status : null,
    stdout,
    errorCode: code,
  };
}

/**
 * 호스트 CLI 실행. shell 은 절대 쓰지 않는다 — 셸이 없으면 인자 주입이 구조적으로 불가능하다.
 * Windows 는 런처가 .cmd 인 경우가 흔한데 Node 는 셸 없이 .cmd 를 직접 실행하지 못하므로
 * 그때만 ComSpec 을 명시적으로 경유한다. 인자는 이미 화이트리스트를 통과한 토큰뿐이다.
 */
export function runHostCli(cli: string, args: string[]): CommandResult {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    cwd: os.tmpdir(),
    maxBuffer: 8 * 1024 * 1024,
  };
  const candidates = process.platform === 'win32' ? [cli, `${cli}.exe`, `${cli}.cmd`] : [cli];
  let last: CommandResult = { ok: false, status: null, stdout: '', errorCode: 'ENOENT' };
  for (const candidate of candidates) {
    const isBatch = /\.(cmd|bat)$/i.test(candidate);
    const res = isBatch
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', candidate, ...args], options)
      : spawnSync(candidate, args, options);
    last = toResult(res);
    if (last.errorCode !== 'ENOENT') return last;
  }
  return last;
}

export function runGit(args: string[], opts: { cwd?: string } = {}): CommandResult {
  const options: SpawnSyncOptionsWithStringEncoding = {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    cwd: opts.cwd ?? os.tmpdir(),
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...GIT_BATCH_ENV },
  };
  return toResult(spawnSync('git', args, options));
}

export function createDefaultIo(env: NodeJS.ProcessEnv = process.env): SelfUpdateIo {
  return {
    now: () => Date.now(),
    readJson: readJsonFile,
    readText: (file) => {
      try {
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    exists: (file) => existsSync(file),
    hostCli: runHostCli,
    git: runGit,
    readCache: () => readSelfUpdateCache(env),
    writeCache: (value) => writeSelfUpdateCache(env, value),
    acquireLock: () => acquireSelfUpdateLock(env),
  };
}

/** check 서브커맨드가 사람에게 보여줄 한 줄 요약. */
export function describeOutcome(o: SelfUpdateOutcome): string {
  switch (o.result) {
    case 'updated':
      return `업데이트했습니다: ${o.installedVersion} → ${o.latestVersion}. 세션을 새로 열면 적용됩니다.`;
    case 'up-to-date':
      return `최신입니다 (설치본 ${o.installedVersion}).`;
    case 'remote-unchanged':
      return `원격에 새 커밋이 없습니다 (설치본 ${o.installedVersion}).`;
    case 'disabled':
      return '자동 업데이트가 꺼져 있습니다 (ARMA_MCP_NO_AUTOUPDATE 또는 ARMA_MCP_TOKEN).';
    case 'dev-checkout':
      return '개발 체크아웃입니다 — 작업 트리를 건드리지 않도록 자동 업데이트를 건너뜁니다.';
    case 'unknown-host':
      return '호스트 설치 캐시 안이 아닙니다 — 자동 업데이트 대상이 아닙니다.';
    case 'no-marketplace':
      return '이 설치본의 마켓플레이스를 찾지 못했습니다.';
    case 'no-marketplace-version':
      return '마켓플레이스 스냅샷에서 이 플러그인의 version 을 읽지 못했습니다.';
    case 'no-remote':
      return `등록된 마켓플레이스 원격에 접근하지 못했습니다.${o.notice ? `\n${o.notice}` : ''}`;
    case 'sync-failed':
      return '마켓플레이스 갱신 명령이 실패했습니다.';
    case 'install-failed':
      return `설치 명령이 실패했습니다 (${o.installedVersion} → ${o.latestVersion}).`;
    case 'unsafe-name':
      return '마켓플레이스/플러그인 이름이 예상 형식과 달라 명령을 실행하지 않았습니다.';
    case 'busy':
      return '다른 프로세스가 이미 업데이트를 확인하고 있습니다.';
    default:
      return '업데이트 확인에 실패했습니다.';
  }
}

/** 훅과 relay 가 공유하는 쿨다운 판단. */
export function dueForCheck(
  env: NodeJS.ProcessEnv,
  cache: SelfUpdateCache | null,
  now: number,
  installedVersion: string | null,
): boolean {
  return shouldCheckRemote({ cache, now, cooldownMs: cooldownMs(env), installedVersion });
}

export { clearNotice };
