// procs.ts — Arma 프로세스 조회/종료 공용 모듈.
//
// tasklist/taskkill 은 외부 프로세스라 50~200ms+ 걸린다. 동기(execFileSync)로 부르면
// Node 이벤트 루프 전체(파이프 처리 포함)가 멈추므로 반드시 비동기로 부르고,
// 조회 결과는 짧은 TTL 로 캐시해 연속 status 호출을 즉답시킨다.
//
// 클라(arma3_x64.exe)와 데디 서버(arma3server_x64.exe)는 이미지명이 달라
// 이미지명 파라미터로 일반화. 기존 export 는 클라 이미지 래퍼로 유지.

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLIENT_IMAGE, SERVER_IMAGE, SERVER_IMAGE_CANDIDATES } from './armaImages.js';

const execFileAsync = promisify(execFile);

/**
 * 강제 종료 뒤 프로세스가 사라지기를 기다리는 기본 상한(ms).
 * 대형 모드팩 Arma 는 taskkill /F 뒤에도 수 초 동안 남아 PBO 를 잡고 있다.
 * 사라지는 즉시 반환하므로 보통은 이만큼 기다리지 않는다.
 */
export const KILL_WAIT_MS = 15000;

// 이미지 이름 목록은 RPT 이름 규칙과 같이 armaImages.ts 한 곳에 둔다.
export { CLIENT_IMAGE, SERVER_IMAGE, SERVER_IMAGE_CANDIDATES };

const RUNNING_TTL_MS = 3000;
const cache = new Map<string, { running: boolean; at: number }>();

/** 캐시 무효화 — 프로세스 상태를 우리가 바꿨을 때(kill/launch) 호출. */
export function invalidateProcCache(): void {
  cache.clear();
}

/** 이미지명으로 실행 여부 조회. force=true 면 캐시 무시(launch 전 검사 등 정확성이 필요한 곳). */
export async function isProcRunningAsync(image: string, force = false): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(image);
  if (!force && hit && now - hit.at < RUNNING_TTL_MS) return hit.running;
  let running = false;
  try {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/NH'],
      // windowsHide: 자동 기동된 daemon 은 콘솔이 없다. 콘솔 헬퍼가 창을 새로 만들지 않게 한다.
      { encoding: 'utf8', windowsHide: true },
    );
    // 이미지명에 정규식 메타문자가 없다는 전제(고정 상수 사용).
    running = stdout.toLowerCase().includes(image.toLowerCase());
  } catch {
    running = false;
  }
  cache.set(image, { running, at: Date.now() });
  return running;
}

/**
 * 실행 중인 데디 서버 이미지명을 찾는다. preferred(설정에서 유도한 이름)를 먼저 보고,
 * 없으면 알려진 후보들을 병렬 조회한다. 실행 중인 게 없으면 null.
 * 반환값이 곧 종료·대기 대상이므로 호출부는 이 이름만 써야 한다.
 */
export async function findRunningServerImage(
  preferred = '',
  force = false,
): Promise<string | null> {
  const seen = new Set<string>();
  const images = [preferred, ...SERVER_IMAGE_CANDIDATES].filter((img) => {
    if (!img) return false;
    const key = img.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const hits = await Promise.all(
    images.map(async (img) => ((await isProcRunningAsync(img, force)) ? img : null)),
  );
  // images 순서 = preferred 우선이므로 첫 히트가 가장 신뢰할 이름.
  return hits.find((img): img is string => img !== null) ?? null;
}

/** 이미지명으로 강제 종료(taskkill /F). */
export async function killProcAsync(image: string): Promise<{ killed: boolean; detail: string }> {
  if (!(await isProcRunningAsync(image, true))) return { killed: false, detail: `${image} 미실행` };
  try {
    await execFileAsync('taskkill', ['/F', '/IM', image], {
      encoding: 'utf8',
      windowsHide: true,
    });
    invalidateProcCache();
    return { killed: true, detail: `${image} 강제 종료` };
  } catch (e) {
    return { killed: false, detail: 'taskkill 실패: ' + (e as Error).message };
  }
}

/** ms 만큼 쉰다. signal 이 걸리면 바로 돌아온다. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * 프로세스가 사라질 때까지 폴링 대기. 사라지면 true, 타임아웃이면 false.
 * signal 이 걸리면 더 기다리지 않고 false 다. 사라졌는지 확인하지 못했기 때문이다.
 */
export async function waitProcGone(
  image: string,
  timeoutMs: number,
  pollMs = 150,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !signal?.aborted) {
    if (!(await isProcRunningAsync(image, true))) return true;
    await pause(pollMs, signal);
  }
  return false;
}

// ── 파일 잠금 해제 대기 ──

export interface PathUnlockResult {
  /** 호출자가 준 경로 그대로. */
  path: string;
  ok: boolean;
  waitedMs: number;
  code?: string;
  reason?: string;
}

/** waitPathsWritable 이 쓰는 open. 테스트에서 가짜로 바꿔 끼운다. */
export type OpenForProbe = (file: string, flags: string) => Promise<{ close(): Promise<void> }>;

const UNLOCK_EXT_RE = /\.(pbo|dll)$/i;

function errCode(e: unknown): string {
  return String((e as NodeJS.ErrnoException)?.code ?? 'UNKNOWN');
}

/** 디렉터리 하나 안의 *.pbo, *.dll. 없거나 읽을 수 없는 디렉터리는 빈 목록이다. */
async function listLockables(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && UNLOCK_EXT_RE.test(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/**
 * 파일마다 'r+' 로 열었다가 바로 닫아 쓰기 가능해질 때까지 기다린다. 내용은 쓰지 않는다.
 *
 * 디렉터리는 그 안과 addons/ 안의 *.pbo, *.dll 로 펼친다.
 * EBUSY(다른 프로세스가 잡고 있음)만 다시 시도한다.
 * EPERM, EACCES 는 기다려도 풀리지 않으므로 바로 실패로 돌려준다.
 * 호출자가 준 경로가 없으면 ENOENT 실패다. 펼친 뒤 사라진 파일은 풀린 것으로 친다.
 * signal 이 걸리면 더 기다리지 않는다. 아직 잠긴 경로는 ABORTED 실패로 돌려준다.
 */
export async function waitPathsWritable(
  paths: readonly string[],
  opts: { timeoutMs: number; pollMs?: number; open?: OpenForProbe; signal?: AbortSignal },
): Promise<PathUnlockResult[]> {
  const pollMs = Math.max(10, opts.pollMs ?? 200);
  const open: OpenForProbe = opts.open ?? ((file, flags) => fsp.open(file, flags));
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, opts.timeoutMs);

  const waitOne = async (target: string): Promise<PathUnlockResult> => {
    const fail = (code: string, reason: string): PathUnlockResult => ({
      path: target,
      ok: false,
      waitedMs: Date.now() - startedAt,
      code,
      reason,
    });

    let pending: string[];
    try {
      const st = await fsp.stat(target);
      pending = st.isDirectory()
        ? [
            ...(await listLockables(target)),
            ...(await listLockables(path.join(target, 'addons'))),
          ]
        : [target];
    } catch (e) {
      const code = errCode(e);
      return fail(code, code === 'ENOENT' ? '경로 없음' : (e as Error).message);
    }

    for (;;) {
      const still: string[] = [];
      for (const file of pending) {
        try {
          const fh = await open(file, 'r+');
          await fh.close();
        } catch (e) {
          const code = errCode(e);
          if (code === 'ENOENT') continue; // 기다리는 사이 지워진 파일은 잠금도 없다.
          if (code === 'EBUSY') {
            still.push(file);
            continue;
          }
          if (code === 'EPERM' || code === 'EACCES') return fail(code, '쓰기 불가');
          return fail(code, (e as Error).message);
        }
      }
      pending = still;
      if (pending.length === 0) {
        return { path: target, ok: true, waitedMs: Date.now() - startedAt };
      }
      if (opts.signal?.aborted) {
        return fail('ABORTED', `대기를 중단했다. 아직 잠김: ${path.basename(pending[0]!)}`);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return fail('EBUSY', `시간 안에 잠금이 풀리지 않음: ${path.basename(pending[0]!)}`);
      }
      await pause(Math.min(pollMs, remaining), opts.signal);
    }
  };

  return Promise.all(paths.map((p) => waitOne(p)));
}

// ── 기존 호출부 호환 래퍼 (클라 이미지 고정) ──

/** arma3_x64.exe 실행 여부. */
export function isArmaRunningAsync(force = false): Promise<boolean> {
  return isProcRunningAsync(CLIENT_IMAGE, force);
}

/** arma3_x64.exe 강제 종료(taskkill /F). */
export function killArmaAsync(): Promise<{ killed: boolean; detail: string }> {
  return killProcAsync(CLIENT_IMAGE);
}

/** arma3_x64.exe 가 사라질 때까지 폴링 대기. */
export function waitArmaGone(timeoutMs: number, pollMs = 150): Promise<boolean> {
  return waitProcGone(CLIENT_IMAGE, timeoutMs, pollMs);
}
