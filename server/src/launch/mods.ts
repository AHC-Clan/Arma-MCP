// mods.ts — 모드셋 구성 공용 로직 (launcher / mpLauncher 공유).
//
// modset='rpt': 최신 클라 RPT 헤더의 -mod= 라인을 재사용해 런처가 마지막에 띄운
// 모드셋을 그대로 복원. 서버·클라가 동일한 -mod= 문자열을 받도록 순수 함수로 분리.
// 모드셋 소스는 항상 클라 RPT 디렉토리다(데디 RPT 헤더는 참조하지 않는다).

import { openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { newestRpt } from '../rpt/rptFiles.js';
import { OVERLAY_MARKER } from '../stack/testMods.js';

/** 최신 클라 RPT 헤더(처음 5줄)에서 -mod= 값 추출. */
export function modsetFromRptHeader(rptDir: string): { mod: string; rpt: string } | null {
  const newest = newestRpt(rptDir);
  if (!newest) return null;
  let header: string;
  try {
    // 헤더는 파일 앞부분 몇 줄. 앞 8KB 만 읽는다(대용량 RPT 안전).
    const buf = Buffer.alloc(8192);
    const fd = openSync(newest.path, 'r');
    try {
      const n = readSync(fd, buf, 0, 8192, 0);
      header = buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = header.split('\n').slice(0, 5);
  const modLine = lines.find((l) => l.includes('-mod='));
  if (!modLine) return null;
  const m = modLine.match(/-mod=("?)([^"]*)\1/);
  if (!m || !m[2]) return null;
  return { mod: m[2].trim(), rpt: newest.name };
}

/** modSwaps 적용 + 중복 제거 + selfModPath 보장. */
export function applyModSwaps(cfg: Config, modString: string): string {
  let segments = modString.split(';').map((s) => s.trim()).filter(Boolean);

  for (const swap of cfg.arma.modSwaps) {
    const matchLower = swap.match.toLowerCase();
    segments = segments.map((seg) => {
      const low = seg.toLowerCase();
      // 세그먼트가 match 로 끝나면(경로 tail) replaceWith 로.
      if (
        low.endsWith(matchLower) ||
        low.endsWith(matchLower + '\\') ||
        low.endsWith(matchLower + '/')
      ) {
        return swap.replaceWith;
      }
      return seg;
    });
  }

  // selfModPath 보장.
  const self = cfg.arma.selfModPath;
  if (self && !segments.some((s) => s.toLowerCase() === self.toLowerCase())) {
    segments.push(self);
  }

  // 대소문자 무시 중복 제거(순서 유지).
  const seen = new Set<string>();
  segments = segments.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return segments.join(';');
}

export interface ResolvedModset {
  modString: string;
  modSource: string;
  warning?: string;
}

function isUnder(child: string, parent: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const c = norm(child);
  const p = norm(parent);
  return c.startsWith(p + '\\') || c.startsWith(p + '/');
}

/** 오버레이 폴더의 원래 모드 경로. 표시 파일이 없거나 깨졌으면 null. */
function overlaySource(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, OVERLAY_MARKER), 'utf8')) as { source?: unknown };
    return typeof parsed.source === 'string' && parsed.source.length > 0 ? parsed.source : null;
  } catch {
    return null;
  }
}

/**
 * 스택 폴더 안의 모드를 정리한다. 오버레이는 원래 기본 모드 경로로 되돌리고, 테스트 애드온
 * 스냅샷처럼 한 번의 실행을 위해 데몬이 만든 나머지는 뺀다. RPT 헤더에서 다시 읽어 다음
 * 실행에 실으면 옛 스냅샷이 로드되기 때문이다.
 */
export function stripStackMods(
  modString: string,
  stacksRoot: string,
): { modString: string; removed: string[]; restored: string[] } {
  const removed: string[] = [];
  const restored: string[] = [];
  const kept: string[] = [];
  for (const seg of modString.split(';').map((x) => x.trim()).filter(Boolean)) {
    if (!isUnder(seg, stacksRoot)) {
      kept.push(seg);
      continue;
    }
    const source = overlaySource(seg);
    if (source) {
      kept.push(source);
      restored.push(source);
    } else {
      removed.push(seg);
    }
  }
  return { modString: kept.join(';'), removed, restored };
}

/** modset 모드('rpt'|'explicit'|'none') 분기 + modSwaps 적용까지 한 번에. */
export function resolveModset(
  cfg: Config,
  rptDir: string,
  opts: { modset?: 'rpt' | 'explicit' | 'none'; mods?: string[] },
  extra: { stacksRoot?: string } = {},
): ResolvedModset {
  const modsetMode = opts.modset ?? 'rpt';
  let modString = '';
  let modSource = '';
  let warning: string | undefined;

  if (modsetMode === 'explicit') {
    modString = (opts.mods ?? []).join(';');
    modSource = 'explicit';
  } else if (modsetMode === 'none') {
    modString = '';
    modSource = 'none';
  } else {
    const fromRpt = modsetFromRptHeader(rptDir);
    if (fromRpt && fromRpt.mod) {
      modString = fromRpt.mod;
      modSource = `rpt (${fromRpt.rpt})`;
    } else {
      modString = cfg.arma.fallbackMods.filter((m) => existsSync(m)).join(';');
      modSource = 'fallback';
      warning = 'RPT 헤더에서 모드셋 추출 실패 — fallbackMods 사용(모드팩이 바뀌었으면 부정확)';
    }
  }
  if (extra.stacksRoot) {
    const stripped = stripStackMods(modString, extra.stacksRoot);
    modString = stripped.modString;
    if (stripped.removed.length > 0) {
      const note = `스택 폴더 안의 모드는 싣지 않았다: ${stripped.removed.join(', ')}`;
      warning = warning ? `${warning} / ${note}` : note;
    }
  }
  modString = applyModSwaps(cfg, modString);
  return { modString, modSource, warning };
}
