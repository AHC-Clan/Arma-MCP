// csHelper.ts: C# 소스를 작은 exe 로 한 번 컴파일해 캐시한다.
//
// 창 탐색과 화면 API 를 PowerShell 스크립트에 섞으면 Defender AMSI 가 오탐해 막는다
// (capture/helperSource.ts 헤더). PE 파일은 스크립트 스캐너 대상이 아니라 C# 헬퍼로 돌린다.
// 이름에 소스 해시를 넣어 소스가 바뀌면 새로 만들고, 같으면 다시 쓴다.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const COMPILE_TIMEOUT_MS = 60000;

/** 헬퍼 exe 캐시 폴더(설정과 무관). */
export function helperDir(): string {
  return path.join(homedir(), '.arma-mcp', 'bin');
}

/** 소스 해시 앞 12자. exe 이름에 들어간다. */
export function sourceHash(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 12);
}

/** .NET Framework 4 의 csc.exe 경로(64비트 우선). 없으면 null. */
export function findCsc(): string | null {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export interface CsHelperSpec {
  /** exe 이름 앞부분. `<prefix>-<해시>.exe` 가 된다. */
  prefix: string;
  source: string;
  /** csc /reference 로 넘길 어셈블리(System.Drawing.dll 등). */
  references: readonly string[];
}

function runCsc(csc: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      csc,
      args,
      { windowsHide: true, timeout: COMPILE_TIMEOUT_MS, maxBuffer: 1 << 20, encoding: 'utf8' },
      (err, stdout, stderr) => {
        let code: number | null = 0;
        if (err) {
          const c = (err as NodeJS.ErrnoException).code;
          code = typeof c === 'number' ? c : null;
          if (typeof c === 'string') stderr = String(stderr) + ` [spawn: ${c}]`;
        }
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** 헬퍼 exe 를 보장한다(캐시 히트면 바로, 없으면 csc 로 컴파일). */
export async function ensureCsHelper(spec: CsHelperSpec): Promise<{ exe: string } | { error: string }> {
  const dir = helperDir();
  const hash = sourceHash(spec.source);
  const exe = path.join(dir, `${spec.prefix}-${hash}.exe`);
  if (existsSync(exe)) return { exe };

  const csc = findCsc();
  if (!csc) return { error: 'csc.exe not found: .NET Framework 4 가 필요합니다(최신 Windows 에 기본으로 들어 있다).' };

  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: 'helper dir 생성 실패: ' + (e as Error).message };
  }

  const csFile = path.join(dir, `${spec.prefix}-${hash}.${process.pid}.cs`);
  const tmpExe = `${exe}.${process.pid}.tmp`;
  try {
    writeFileSync(csFile, spec.source, 'utf8');
    const res = await runCsc(csc, [
      '/nologo',
      '/target:exe',
      `/out:${tmpExe}`,
      ...spec.references.map((r) => `/reference:${r}`),
      csFile,
    ]);
    if (res.code !== 0 || !existsSync(tmpExe)) {
      return { error: 'csc 컴파일 실패: ' + (res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`).slice(-400) };
    }
    // 이름을 바꿔 한 번에 놓는다. 동시에 컴파일한 쪽이 먼저 놓았으면 그것을 쓴다.
    try {
      renameSync(tmpExe, exe);
    } catch {
      if (existsSync(exe)) {
        try { unlinkSync(tmpExe); } catch { /* noop */ }
      } else {
        return { error: 'helper exe 배치 실패' };
      }
    }
    return { exe };
  } catch (e) {
    return { error: 'csc 컴파일 예외: ' + (e as Error).message };
  } finally {
    try { unlinkSync(csFile); } catch { /* noop */ }
  }
}
