// processIndex.ts — Arma 프로세스를 스택별로 나눠 보는 조회와 pid 단위 종료.
//
// 이미지 이름만으로는 어느 스택의 게임인지 모른다. 스택이 띄운 게임은 명령줄에
// -profiles=<stacks.root>\<id>\... 를 달고 있으므로 그것으로 가른다. 그 밖의 게임
// (사람이 띄운 게임, default 스택이 띄운 게임)은 default 스택으로 친다.
//
// 조회는 PowerShell 로 Get-CimInstance 한 번이다(회당 수백 ms). 3초 동안 캐시하고,
// 실행 가드와 종료처럼 정확해야 하는 곳은 새로 읽는다.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { splitCommandLine } from '../cmdline.js';
import { DEFAULT_STACK_ID, STACK_ID_RE } from './stackContext.js';

const execFileAsync = promisify(execFile);

const LIST_TTL_MS = 3000;
const LIST_TIMEOUT_MS = 8000;
const IMAGE_NAME_RE = /^[A-Za-z0-9_.-]+\.exe$/i;

export interface ArmaProcessInfo {
  pid: number;
  image: string;
  /** 권한 때문에 못 읽으면 빈 문자열이다. 그 프로세스는 default 로 분류된다. */
  commandLine: string;
}

/** 조회 실패면 null 이다. 빈 배열은 "하나도 없음" 이다. */
export type ProcessLister = (images: readonly string[]) => Promise<ArmaProcessInfo[] | null>;

let cache: { key: string; at: number; list: ArmaProcessInfo[] | null } | null = null;

/** 조회 캐시를 비운다. 프로세스를 띄우거나 끈 직후에 부른다. */
export function invalidateProcessIndex(): void {
  cache = null;
}

/** 주어진 이미지 이름의 프로세스를 pid 와 명령줄까지 읽는다. */
export async function listArmaProcesses(
  images: readonly string[],
  force = false,
): Promise<ArmaProcessInfo[] | null> {
  const names = [...new Set(images.filter((i) => IMAGE_NAME_RE.test(i)).map((i) => i.toLowerCase()))].sort();
  if (names.length === 0) return [];
  const key = names.join('|');
  const now = Date.now();
  if (!force && cache && cache.key === key && now - cache.at < LIST_TTL_MS) return cache.list;
  const list = await queryCim(names);
  cache = { key, at: Date.now(), list };
  return list;
}

async function queryCim(names: string[]): Promise<ArmaProcessInfo[] | null> {
  const filter = names.map((n) => `Name='${n}'`).join(' OR ');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$procs = @(Get-CimInstance Win32_Process -Filter "${filter}" | ` +
      'ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine } })',
    'ConvertTo-Json -Compress -Depth 3 -InputObject @{ procs = $procs }',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      // windowsHide: 자동 기동된 daemon 은 콘솔이 없다. 콘솔 헬퍼가 창을 새로 만들지 않게 한다.
      { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, windowsHide: true },
    );
    const parsed = JSON.parse(stdout.trim() || '{}') as { procs?: unknown };
    const procs = Array.isArray(parsed.procs) ? parsed.procs : [];
    const out: ArmaProcessInfo[] = [];
    for (const entry of procs) {
      const r = (entry ?? {}) as { pid?: unknown; name?: unknown; cmd?: unknown };
      const pid = Number(r.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      out.push({
        pid,
        image: typeof r.name === 'string' ? r.name : '',
        commandLine: typeof r.cmd === 'string' ? r.cmd : '',
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** 명령줄의 -profiles= 값. 없으면 null. 따옴표 모양과 대소문자를 가리지 않는다. */
export function profilesArg(commandLine: string): string | null {
  for (const arg of splitCommandLine(commandLine)) {
    const m = /^-profiles=(.*)$/i.exec(arg);
    if (m) {
      const value = m[1]!.trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

function normalizeDir(p: string): string {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * -profiles 경로로 스택을 가른다. <stacksRoot>\<id>\... 면 id, 그 밖은 default 다.
 * 이름 규칙에 맞지 않는 폴더 이름도 default 로 친다(스택이 만들 수 없는 경로다).
 */
export function stackOfProfiles(profiles: string | null, stacksRoot: string): string {
  if (!profiles) return DEFAULT_STACK_ID;
  const root = normalizeDir(stacksRoot);
  const dir = normalizeDir(profiles);
  if (!dir.startsWith(root + path.sep.toLowerCase()) && !dir.startsWith(root + '/')) {
    return DEFAULT_STACK_ID;
  }
  const rest = dir.slice(root.length + 1);
  const id = rest.split(/[\\/]/)[0] ?? '';
  return STACK_ID_RE.test(id) ? id : DEFAULT_STACK_ID;
}

/** 클라 -profiles 가 ...\client<N> 이면 N, 아니면 1. */
export function clientIndexOf(profiles: string | null): number {
  if (!profiles) return 1;
  const m = /[\\/]client(\d{1,2})[\\/]?$/i.exec(profiles.trim());
  const n = m ? Number(m[1]) : 1;
  return n >= 1 ? n : 1;
}

/** pid 들을 강제 종료한다. 하나도 없으면 아무것도 하지 않는다. */
export async function killPids(pids: readonly number[]): Promise<{ ok: boolean; detail: string }> {
  const valid = pids.filter((p) => Number.isInteger(p) && p > 0);
  if (valid.length === 0) return { ok: false, detail: '대상 pid 없음' };
  const args = ['/F', ...valid.flatMap((p) => ['/PID', String(p)])];
  try {
    await execFileAsync('taskkill', args, { encoding: 'utf8', windowsHide: true });
    invalidateProcessIndex();
    return { ok: true, detail: `pid ${valid.join(', ')} 강제 종료` };
  } catch (e) {
    invalidateProcessIndex();
    return { ok: false, detail: 'taskkill 실패: ' + (e as Error).message.split(/\r?\n/)[0] };
  }
}

/** pid 가 아직 살아 있는지. Node 의 signal 0 은 Windows 에서도 존재만 확인한다. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 은 살아 있지만 신호를 보낼 권한이 없다는 뜻이다.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
