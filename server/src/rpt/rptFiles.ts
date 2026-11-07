// rptFiles.ts — RPT 로그 파일 탐색.
//
// RPT 이름은 <exe 모듈 이름>_YYYY-MM-DD_HH-MM-SS.rpt 다. 접두어를 뗀 시각 부분의
// 문자열 정렬이 곧 시간순이다(debug-run.ps1 이 clock/UTC 스큐를 피하려 택한 방식).
// 최신 = 시각 부분 최대값. 접두어는 exe 마다 달라서(Arma3_x64_, arma3profiling_x64_)
// 이름 전체로 비교하면 시간순이 깨진다. 접두어 목록은 armaImages.ts 의 이미지 목록에서 온다.
// 데디 서버 RPT(arma3server_x64_*.rpt)도 같은 규칙이라 정규식만 갈아끼운다.

import { readdirSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { CLIENT_IMAGE_CANDIDATES, SERVER_IMAGE_CANDIDATES, rptPrefixOf } from '../armaImages.js';

export interface RptFileInfo {
  name: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

/** 이미지 목록의 RPT 접두어를 정규식 선택지로. 긴 것이 먼저라 arma3server_x64 가 arma3server 에 먹히지 않는다. */
function prefixAlternation(images: readonly string[]): string {
  const prefixes = [...new Set(images.map((i) => rptPrefixOf(i).toLowerCase()))];
  prefixes.sort((a, b) => b.length - a.length);
  return prefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/** 클라 RPT(Arma3_x64_*, arma3profiling_x64_*). */
export const CLIENT_RPT_RE = new RegExp(
  `^(?:${prefixAlternation(CLIENT_IMAGE_CANDIDATES)})_.*\\.rpt$`,
  'i',
);
/** 데디 서버 RPT(arma3server_x64_*, arma3serverprofiling_x64_*, arma3server_*). */
export const SERVER_RPT_RE = new RegExp(
  `^(?:${prefixAlternation(SERVER_IMAGE_CANDIDATES)})_.*\\.rpt$`,
  'i',
);
const ANY_RPT_PREFIX_RE = new RegExp(
  `^(?:${prefixAlternation([...CLIENT_IMAGE_CANDIDATES, ...SERVER_IMAGE_CANDIDATES])})_`,
  'i',
);

/** RPT 이름에서 exe 접두어를 뗀 시각 부분. 모르는 이름은 그대로 돌려준다. */
export function rptTimeKey(name: string): string {
  return name.replace(ANY_RPT_PREFIX_RE, '');
}

/** RPT 이름을 시간순으로 비교한다. 시각이 같으면 이름 전체로 가른다. */
export function compareRptNames(a: string, b: string): number {
  const ka = rptTimeKey(a);
  const kb = rptTimeKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function listRptFiles(rptDir: string, re: RegExp = CLIENT_RPT_RE): RptFileInfo[] {
  let names: string[];
  try {
    names = readdirSync(rptDir);
  } catch {
    return [];
  }
  const out: RptFileInfo[] = [];
  for (const name of names) {
    if (!re.test(name)) continue;
    const full = path.join(rptDir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      out.push({ name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* 경합으로 사라진 파일은 무시 */
    }
  }
  // 시간 오름차순.
  out.sort((a, b) => compareRptNames(a.name, b.name));
  return out;
}

function statRpt(rptDir: string, name: string): RptFileInfo | null {
  const full = path.join(rptDir, name);
  try {
    const st = statSync(full);
    if (!st.isFile()) return null;
    return { name, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

// newestRpt/rptAfter 는 exec 전송 직전·상태 조회·대기 폴링 등 핫패스에서 불리므로
// 전 파일 stat 대신 이름 비교로 대상 1개만 골라 stat 한다(시각 부분 정렬 = 시간순).
export function newestRpt(rptDir: string, re: RegExp = CLIENT_RPT_RE): RptFileInfo | null {
  let names: string[];
  try {
    names = readdirSync(rptDir);
  } catch {
    return null;
  }
  const best = newestName(names, re);
  return best ? statRpt(rptDir, best) : null;
}

function newestName(names: string[], re: RegExp): string | null {
  let best: string | null = null;
  for (const n of names) {
    if (re.test(n) && (best === null || compareRptNames(n, best) > 0)) best = n;
  }
  return best;
}

/** newestRpt 의 비동기판 — 데몬 이벤트 루프를 막지 않아야 하는 경로용. */
export async function newestRptAsync(
  rptDir: string,
  re: RegExp = CLIENT_RPT_RE,
): Promise<RptFileInfo | null> {
  let names: string[];
  try {
    names = await readdir(rptDir);
  } catch {
    return null;
  }
  const best = newestName(names, re);
  if (!best) return null;
  const full = path.join(rptDir, best);
  try {
    const st = await stat(full);
    if (!st.isFile()) return null;
    return { name: best, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/** prevName 보다 시간순으로 뒤에 오는(더 새로운) 첫 RPT. 없으면 null. */
export function rptAfter(
  rptDir: string,
  prevName: string,
  re: RegExp = CLIENT_RPT_RE,
): RptFileInfo | null {
  let names: string[];
  try {
    names = readdirSync(rptDir);
  } catch {
    return null;
  }
  let best: string | null = null;
  for (const n of names) {
    if (
      re.test(n) &&
      compareRptNames(n, prevName) > 0 &&
      (best === null || compareRptNames(n, best) < 0)
    ) {
      best = n;
    }
  }
  return best ? statRpt(rptDir, best) : null;
}

/** 'newest' | 파일명 | 절대경로 를 실제 경로로 해석. */
export function resolveRptTarget(
  rptDir: string,
  target: string | undefined,
  re: RegExp = CLIENT_RPT_RE,
): RptFileInfo | null {
  if (!target || target === 'newest') return newestRpt(rptDir, re);
  // 절대경로면 그대로.
  if (path.isAbsolute(target)) {
    try {
      const st = statSync(target);
      return {
        name: path.basename(target),
        path: target,
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
      };
    } catch {
      return null;
    }
  }
  // 파일명이면 rptDir 기준.
  const full = path.join(rptDir, target);
  try {
    const st = statSync(full);
    return { name: target, path: full, sizeBytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}
