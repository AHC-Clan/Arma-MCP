// plan.ts — self-update 의 순수 결정 계층.
//
// daemon/autostart.ts 의 planDaemonAction 과 같은 원칙: 관측값만 받아 무엇을 할지 정하고
// I/O 는 전혀 하지 않는다. 덕분에 네트워크도 파일도 없이 전 분기를 테스트할 수 있다.
//
// 이 파일은 version.ts 하나만 import 한다. self-update 는 세션 시작 임계 경로에서
// 도는 코드라 daemon/config 계층을 끌어오면 안 된다.

import { compareVersions } from '../version.js';

export type SelfUpdateResult =
  | 'disabled'
  | 'dev-checkout'
  | 'no-plugin-root'
  | 'unknown-host'
  | 'no-marketplace'
  | 'unsafe-name'
  | 'busy'
  | 'no-remote'
  | 'remote-unchanged'
  | 'no-marketplace-version'
  | 'up-to-date'
  | 'sync-failed'
  | 'install-failed'
  | 'updated'
  | 'error';

export interface SelfUpdateNotify {
  fromVersion: string;
  toVersion: string;
}

export interface SelfUpdateUrlNotice {
  known: string;
  manifest: string;
}

/** 세션 사이에 유지되는 상태. 쿨다운·1회성 알림·연속 실패 추적을 모두 담는다. */
export interface SelfUpdateCache {
  lastCheck?: number;
  installedVersion?: string;
  snapshotSha?: string;
  lastAttemptVersion?: string;
  lastResult?: SelfUpdateResult;
  /** 연속 no-remote 횟수. 마켓플레이스 URL 안내를 띄울지 판단하는 근거. */
  failStreak?: number;
  host?: string;
  /** 업데이트에 성공했고 아직 사용자에게 알리지 않았다. */
  notify?: SelfUpdateNotify;
  /** 자식이 남긴 1회성 안내. 다음 세션 시작에 전달하고 지운다. */
  message?: string;
  /** 이미 안내한 URL 쌍. 같은 쌍으로 반복해서 알리지 않는다. */
  urlNotice?: SelfUpdateUrlNotice;
}

export type RemoteStage = { kind: 'sync' } | { kind: 'skip'; result: SelfUpdateResult };

export type InstallStage =
  | { kind: 'install'; toVersion: string }
  | { kind: 'skip'; result: SelfUpdateResult };

const DEFAULT_COOLDOWN_H = 6;
const MIN_COOLDOWN_H = 1;
const MAX_COOLDOWN_H = 24;

/** CLI 인자로 나가는 이름. 셸을 쓰지 않더라도 화이트리스트를 한 겹 더 둔다. */
const SAFE_NAME_RE = /^[0-9A-Za-z._-]+$/;
const SAFE_SCOPES = new Set(['user', 'project', 'local', 'managed']);
const SAFE_URL_SCHEME_RE = /^(?:https?|ssh|git):\/\//i;

/** URL 안내를 띄우기 전에 요구하는 연속 실패 횟수. 미러·fork 오탐을 막는다. */
export const URL_NOTICE_FAIL_STREAK = 3;

/**
 * 자동 업데이트를 끄는 신호.
 *
 * ARMA_MCP_TOKEN 은 autostartSuppressed 와 같은 이유로 억제한다 — 문서상 원격 터널
 * 사용 신호이며, 원격 관리자가 서버 컴퓨터의 플러그인을 갈아치우면 안 된다.
 */
export function selfUpdateSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = (env.ARMA_MCP_NO_AUTOUPDATE ?? '').trim().toLowerCase();
  if (explicit && explicit !== '0' && explicit !== 'false') return true;
  return Boolean(env.ARMA_MCP_TOKEN);
}

/** 체크 간격. 기본 6시간, [1,24] 로 클램프. */
export function cooldownMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.ARMA_MCP_AUTOUPDATE_COOLDOWN_H);
  const hours = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.max(parsed, MIN_COOLDOWN_H), MAX_COOLDOWN_H)
    : DEFAULT_COOLDOWN_H;
  return hours * 60 * 60 * 1000;
}

export function isSafeCliName(value: string | null | undefined): boolean {
  return typeof value === 'string' && SAFE_NAME_RE.test(value);
}

export function isSafeScope(value: string | null | undefined): boolean {
  return typeof value === 'string' && SAFE_SCOPES.has(value);
}

/**
 * git ls-remote 에 넘길 URL. '-' 로 시작하면 인자로 해석될 수 있어(`--upload-pack=...`)
 * 거부하고, 스킴도 원격 전송 프로토콜로 제한한다.
 */
export function isSafeRemoteUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (value.startsWith('-')) return false;
  return SAFE_URL_SCHEME_RE.test(value);
}

/** 원격을 볼 때가 됐는지. 설치 버전이 캐시 기록과 달라졌으면 쿨다운을 무시한다. */
export function shouldCheckRemote(input: {
  cache: SelfUpdateCache | null;
  now: number;
  cooldownMs: number;
  installedVersion: string | null;
}): boolean {
  const { cache, now, installedVersion } = input;
  if (!cache || typeof cache.lastCheck !== 'number') return true;
  // 방금 업데이트가 적용됐다 = 직전 판단이 낡았다.
  if (installedVersion && cache.installedVersion && cache.installedVersion !== installedVersion) {
    return true;
  }
  const elapsed = now - cache.lastCheck;
  // 시계가 뒤로 갔으면 영원히 잠기지 않도록 즉시 허용한다.
  if (elapsed < 0) return true;
  return elapsed >= input.cooldownMs;
}

/**
 * 마켓플레이스를 실제로 pull 할지. 원격 HEAD 가 스냅샷과 같으면 받을 것이 없다.
 * ls-remote 는 객체를 전송하지 않으므로 이 게이트가 대부분의 체크를 1 RTT 로 끝낸다.
 */
export function planRemoteStage(input: {
  remoteSha: string | null;
  snapshotSha: string | null;
  force: boolean;
}): RemoteStage {
  if (input.force) return { kind: 'sync' };
  if (!input.remoteSha) return { kind: 'skip', result: 'no-remote' };
  // 스냅샷이 git 이 아니거나 읽지 못했다 — CLI 가 알아서 맞추게 둔다.
  if (!input.snapshotSha) return { kind: 'sync' };
  return input.remoteSha === input.snapshotSha
    ? { kind: 'skip', result: 'remote-unchanged' }
    : { kind: 'sync' };
}

/** 설치할지. 판정 기준은 호스트 CLI 가 실제로 참조하는 마켓플레이스 version 이다. */
export function planInstallStage(input: {
  installedVersion: string;
  snapshotVersion: string | null;
}): InstallStage {
  if (!input.snapshotVersion) return { kind: 'skip', result: 'no-marketplace-version' };
  return compareVersions(input.snapshotVersion, input.installedVersion) > 0
    ? { kind: 'install', toVersion: input.snapshotVersion }
    : { kind: 'skip', result: 'up-to-date' };
}

/**
 * 지난 세션에서 업데이트했다면 이번 세션 시작에 알린다.
 *
 * 새 relay 가 구버전 daemon 을 재시작하는 것은 기존 계약이지만(docs/daemon.md),
 * 자동 업데이트로 빈도가 올라가므로 문구가 그 결과를 정면으로 알려야 한다.
 */
export function pendingNotice(
  cache: SelfUpdateCache | null,
  installedVersion: string | null,
): string {
  const lines: string[] = [];
  const notify = cache?.notify;
  if (notify?.fromVersion && notify.toVersion) {
    const head = `Arma-MCP 플러그인을 ${notify.fromVersion} 에서 ${notify.toVersion} 로 업데이트했습니다.`;
    lines.push(
      installedVersion && installedVersion === notify.toVersion
        ? `${head}\n` +
          `이 세션은 ${notify.toVersion} 을 씁니다. 첫 arma 툴 호출 때 구버전 daemon 이 자동 재시작되며, ` +
          '아직 열려 있는 다른 세션은 그때 arma 연결이 끊기므로 그 세션에서 /reload-plugins 하세요.'
        : `${head}\n` +
          `이 세션은 아직 ${installedVersion ?? '구버전'} 으로 동작합니다 — ` +
          '세션을 새로 열거나 /reload-plugins 하면 적용됩니다.',
    );
  }
  if (cache?.message) lines.push(cache.message);
  return lines.join('\n\n');
}

/** 1회성 알림을 소비한 뒤의 캐시. 나머지 필드는 보존한다. */
export function clearNotice(cache: SelfUpdateCache | null): SelfUpdateCache {
  if (!cache) return {};
  const { notify: _notify, message: _message, ...rest } = cache;
  return rest;
}

/**
 * 등록된 마켓플레이스 URL 이 플러그인이 명시한 저장소와 다를 때의 안내.
 *
 * 자동으로 remove/add 하지 않는다: 백그라운드 프로세스가 호스트 전역 상태를 바꾸는 일이고,
 * 미러·fork·프록시는 정당하게 다를 수 있으며, 무엇보다 받은 매니페스트가 사용자의 등록을
 * 갈아치울 수 있으면 한 번의 잘못된 릴리스가 스스로 전파되는 리다이렉트가 된다.
 *
 * 그래서 "연속 실패 중이고 + 주소가 다르다" 는 두 조건이 모두 맞을 때만, 한 번만 알린다.
 */
export function urlMismatchNotice(input: {
  knownUrl: string | null;
  manifestUrl: string | null;
  marketplace: string | null;
  cache: SelfUpdateCache | null;
  failStreak: number;
  recoveryCommands: string[];
}): string {
  const { knownUrl, manifestUrl, marketplace, cache, failStreak, recoveryCommands } = input;
  if (!knownUrl || !manifestUrl || !marketplace) return '';
  if (knownUrl === manifestUrl) return '';
  if (failStreak < URL_NOTICE_FAIL_STREAK) return '';
  const seen = cache?.urlNotice;
  if (seen && seen.known === knownUrl && seen.manifest === manifestUrl) return '';
  const commands = recoveryCommands.map((line) => `  ${line}`).join('\n');
  return (
    `Arma-MCP 마켓플레이스 '${marketplace}' 의 등록 URL 이 플러그인이 명시한 저장소와 다릅니다.\n` +
    `  등록됨: ${knownUrl}\n` +
    `  플러그인 명시: ${manifestUrl}\n` +
    `등록된 URL 에서 ${failStreak}회 연속 실패했습니다. 의도한 것이 아니면 직접 실행하세요:\n` +
    commands
  );
}
