// capture.ts — 서버 측 화면 캡처 오케스트레이션.
//
// 게임 브리지(exec)와 무관한 독립 경로 — 메인메뉴/로딩 등 DLL 미접속 상태에서도 동작한다.
// 캡처 로직은 C# 헬퍼 exe(helperSource.ts)로 실행한다(PowerShell 은 AMSI 오탐으로 차단됨,
// helperSource.ts 헤더 참고). 헬퍼는 소스 해시 이름으로 1회 컴파일해 캐시하고, 이후엔 재사용한다.
// procs.ts 와 같은 이유로 컴파일·실행 모두 비동기 스폰한다(이벤트 루프·파이프 처리 보호).

import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ensureCsHelper } from '../csHelper.js';
import { CAPTURE_CS_SOURCE } from './helperSource.js';

export interface CaptureOptions {
  /** 대상 프로세스 이미지명(arma3_x64.exe 등). scope='screen' 이면 미사용. */
  processImage: string;
  scope: 'window' | 'screen';
  delayMs: number;
  format: 'jpeg' | 'png';
  quality: number;
  maxWidth: number;
  /** 저장 경로(호출자가 resolveCaptureDir 로 조립). */
  outFile: string;
  /** 이 pid 의 창을 찍는다. 없거나 0 이면 이미지명으로 찾은 첫 창이다. */
  pid?: number;
}

export interface CaptureSuccess {
  ok: true;
  file: string;
  method: 'printwindow' | 'screen';
  windowRect: { x: number; y: number; w: number; h: number } | null;
  imageW: number;
  imageH: number;
  bytes: number;
  elapsedMs: number;
  note?: string;
}

export interface CaptureFailure {
  ok: false;
  error: string;
  stage?: string;
  stderrTail?: string;
}

/** 테스트 주입용 헬퍼 러너. 주입 시 컴파일 단계를 건너뛴다. code null = 타임아웃/킬. */
export type HelperRunner = (
  exe: string,
  env: Record<string, string>,
  timeoutMs: number,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

// 캡처 자체(대기 제외) 여유. delayMs 는 호출자가 더한다.
const RUN_TIMEOUT_MS = 15000;

function execFileAsync(
  file: string,
  args: string[],
  opts: { timeout: number; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: opts.timeout, maxBuffer: 1 << 20, encoding: 'utf8', env: opts.env },
      (err, stdout, stderr) => {
        let code: number | null = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException).code;
          code = typeof c === 'number' ? c : null; // null = 타임아웃 킬 or 스폰 실패
          if (typeof c === 'string') stderr = String(stderr) + ` [spawn: ${c}]`;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 캡처 헬퍼 exe 를 보장한다(csHelper.ts). */
function ensureHelper(): Promise<{ exe: string } | { error: string }> {
  return ensureCsHelper({
    prefix: 'arma-capture',
    source: CAPTURE_CS_SOURCE,
    references: ['System.Drawing.dll', 'System.Windows.Forms.dll'],
  });
}

function optsToEnv(opts: CaptureOptions): Record<string, string> {
  return {
    ...process.env,
    ARMA_CAP_SCOPE: opts.scope,
    ARMA_CAP_PROC: opts.processImage,
    ARMA_CAP_OUT: opts.outFile,
    ARMA_CAP_FORMAT: opts.format,
    ARMA_CAP_QUALITY: String(opts.quality),
    ARMA_CAP_MAXW: String(opts.maxWidth),
    ARMA_CAP_DELAY: String(opts.delayMs),
    ARMA_CAP_PID: String(opts.pid ?? 0),
  } as Record<string, string>;
}

function tail(s: string): string | undefined {
  const t = s.trim();
  return t ? t.slice(-300) : undefined;
}

/** stdout 마지막 비공백 줄만 JSON 파싱(선행 잡음 무시). 실패 시 null. */
export function parseCaptureStdout(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

const defaultRunner: HelperRunner = (exe, env, timeoutMs) =>
  execFileAsync(exe, [], { timeout: timeoutMs, env });

/** 화면을 캡처해 outFile 에 저장. 실패는 예외 대신 CaptureFailure 로. */
export async function captureWindow(
  opts: CaptureOptions,
  runner?: HelperRunner,
): Promise<CaptureSuccess | CaptureFailure> {
  const started = Date.now();
  const timeoutMs = RUN_TIMEOUT_MS + opts.delayMs;

  let exe = '<injected>';
  let run = runner;
  if (!run) {
    const h = await ensureHelper();
    if ('error' in h) return { ok: false, error: h.error, stage: 'compile' };
    exe = h.exe;
    run = defaultRunner;
  }

  let res: Awaited<ReturnType<HelperRunner>>;
  try {
    res = await run(exe, optsToEnv(opts), timeoutMs);
  } catch (e) {
    return { ok: false, error: 'capture helper spawn failed: ' + (e as Error).message };
  }

  if (res.code !== 0) {
    const why = res.code === null ? `did not complete (timeout ${timeoutMs}ms or spawn failure)` : `exited ${res.code}`;
    return { ok: false, error: `capture helper ${why}`, stderrTail: tail(res.stderr) };
  }

  const parsed = parseCaptureStdout(res.stdout);
  if (!parsed) {
    return { ok: false, error: 'capture helper output not parseable', stderrTail: tail(res.stderr) };
  }
  if (parsed.ok !== true) {
    return {
      ok: false,
      error: String(parsed.error ?? 'capture failed'),
      stage: typeof parsed.stage === 'string' ? parsed.stage : undefined,
      stderrTail: tail(res.stderr),
    };
  }

  let bytes = 0;
  try {
    bytes = statSync(opts.outFile).size;
  } catch {
    return { ok: false, error: 'capture reported ok but output file missing: ' + opts.outFile };
  }

  const rect = parsed.windowRect;
  const windowRect =
    rect && typeof rect === 'object'
      ? {
          x: Number((rect as Record<string, unknown>).x) || 0,
          y: Number((rect as Record<string, unknown>).y) || 0,
          w: Number((rect as Record<string, unknown>).w) || 0,
          h: Number((rect as Record<string, unknown>).h) || 0,
        }
      : null;

  return {
    ok: true,
    file: opts.outFile,
    method: parsed.method === 'screen' ? 'screen' : 'printwindow',
    windowRect,
    imageW: Number(parsed.imageW) || 0,
    imageH: Number(parsed.imageH) || 0,
    bytes,
    elapsedMs: Date.now() - started,
    note: typeof parsed.note === 'string' ? parsed.note : undefined,
  };
}

/** capture_* 파일을 mtime 내림차순 keepMax 개만 유지, 나머지 삭제. 삭제 개수 반환.
 * 데몬 이벤트 루프는 전 세션 공유라 stat/unlink 를 비동기로 돌린다. */
export async function pruneCaptures(dir: string, keepMax: number): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const files = (
    await Promise.all(
      names
        .filter((n) => n.startsWith('capture_'))
        .map(async (n) => {
          const p = path.join(dir, n);
          try {
            return { p, mtime: (await stat(p)).mtimeMs };
          } catch {
            return null;
          }
        }),
    )
  )
    .filter((x): x is { p: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  let deleted = 0;
  for (const f of files.slice(Math.max(keepMax, 0))) {
    try {
      await unlink(f.p);
      deleted++;
    } catch {
      /* 잠긴 파일 등은 다음 기회에 */
    }
  }
  return deleted;
}
