// state.ts — self-update 상태 캐시의 위치와 원자적 입출력.
//
// 캐시는 config 를 로드하지 않고도 읽고 써야 한다(훅은 설정 라이프사이클 바깥에서 돈다).
// 그래서 cfg.mcp.tokenFile 을 따르지 않고 기본 상태 폴더에 고정한다. daemon 의 status 툴도
// 같은 함수를 써서 같은 파일을 본다.

import { homedir } from 'node:os';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SelfUpdateCache } from './plan.js';

/** 죽은 프로세스가 남긴 락을 무시하기까지의 시간. */
const LOCK_STALE_MS = 10 * 60 * 1000;

export function selfUpdateStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ARMA_MCP_TOKEN_FILE;
  if (explicit) return path.dirname(explicit);
  const localAppData = env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Arma-MCP');
}

export function selfUpdateCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(selfUpdateStateDir(env), 'selfupdate.json');
}

export function selfUpdateLockFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(selfUpdateStateDir(env), 'selfupdate.lock');
}

export function readSelfUpdateCache(env: NodeJS.ProcessEnv = process.env): SelfUpdateCache | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(selfUpdateCacheFile(env), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as SelfUpdateCache;
  } catch {
    return null;
  }
}

/** 임시 파일 + rename. 동시에 시작한 세션들이 반쯤 쓰인 파일을 보지 않게 한다. */
export function writeSelfUpdateCache(
  env: NodeJS.ProcessEnv,
  value: SelfUpdateCache,
): boolean {
  const file = selfUpdateCacheFile(env);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(value), 'utf8');
    renameSync(temp, file);
    return true;
  } catch {
    try {
      unlinkSync(temp);
    } catch {
      /* best effort */
    }
    return false;
  }
}

/**
 * 배타적 생성 락. 자식이 여럿 떠도 호스트 CLI 는 하나만 돌게 한다.
 * ensureMcpToken 과 같은 'wx' 관용구다. 해제 함수를 반환하고, 못 잡으면 null.
 */
export function acquireSelfUpdateLock(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const file = selfUpdateLockFile(env);
  const release = (): void => {
    try {
      unlinkSync(file);
    } catch {
      /* best effort */
    }
  };
  const tryCreate = (): boolean => {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const fd = openSync(file, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
      } finally {
        closeSync(fd);
      }
      return true;
    } catch {
      return false;
    }
  };

  if (tryCreate()) return release;

  // 남아 있는 락이 충분히 오래됐으면 죽은 프로세스의 것으로 보고 한 번만 회수한다.
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const startedAt =
      raw && typeof raw === 'object' && typeof (raw as { startedAt?: unknown }).startedAt === 'number'
        ? (raw as { startedAt: number }).startedAt
        : 0;
    if (Date.now() - startedAt < LOCK_STALE_MS) return null;
  } catch {
    // 읽지 못하는 락은 판단 근거가 없다 — 다른 자식이 쓰는 중일 수 있으니 양보한다.
    return null;
  }
  release();
  return tryCreate() ? release : null;
}
