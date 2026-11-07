// screenArea.ts — 주 모니터 작업 영역. 클라가 여럿이면 창을 이 안에 나란히 놓는다(stackArgs.ts).
//
// Arma 는 DPI 를 인식하지 않는 프로세스라 배율이 100% 를 넘으면 창 좌표가 논리 픽셀이다.
// 그래서 DPI 를 인식하지 않는 PowerShell 에서 읽어 같은 좌표계로 받는다.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScreenArea } from './stackArgs.js';
import { log } from '../log.js';

const execFileAsync = promisify(execFile);

const QUERY_TIMEOUT_MS = 8000;

/** 영역을 못 읽었을 때 쓰는 값. 1920x1080 화면에서 작업 표시줄 40 을 뺀 자리다. */
export const FALLBACK_WORK_AREA: ScreenArea = { x: 0, y: 0, width: 1920, height: 1040 };

const SCRIPT =
  'Add-Type -AssemblyName System.Windows.Forms; ' +
  '$a = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; ' +
  "'{0} {1} {2} {3}' -f $a.X, $a.Y, $a.Width, $a.Height";

/** "x y 폭 높이" 한 줄을 읽는다. 폭이나 높이가 0 이하이면 null 이다. */
export function parseWorkArea(stdout: string): ScreenArea | null {
  const m = /^\s*(-?\d+) (-?\d+) (\d+) (\d+)\s*$/.exec(stdout);
  if (!m) return null;
  const [x, y, width, height] = m.slice(1).map(Number) as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** 주 모니터 작업 영역. 읽지 못하면 FALLBACK_WORK_AREA 를 돌려주고 경고를 남긴다. */
export async function primaryWorkArea(): Promise<ScreenArea> {
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      encoding: 'utf8',
      timeout: QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    const area = parseWorkArea(stdout);
    if (area) return area;
    log.warn(`[launch] 주 모니터 작업 영역을 읽지 못함(${stdout.trim() || '빈 출력'}), 1920x1040 으로 놓는다`);
  } catch (e) {
    log.warn(`[launch] 주 모니터 작업 영역 조회 실패(${(e as Error).message}), 1920x1040 으로 놓는다`);
  }
  return FALLBACK_WORK_AREA;
}
