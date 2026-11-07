// bridgeMod.ts — 사람이 띄운 게임이 알려 준 모드 위치로 arma.selfModPath 를 채운다.
//
// 메인 화면의 연결 창을 쓰는 사람은 설정 파일을 적지 않는다. 그 게임의 DLL 이 자기 모드 폴더를
// <상태 폴더>/bridge-mod.json 에 적어 두면 데몬이 시작할 때 읽는다. 사용자가 적어 둔 값이 항상
// 우선이고, 결과는 이 프로세스 메모리에만 반영한다.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveStateDir, type Config } from '../config.js';
import { log } from '../log.js';

export type SelfModSource = 'config' | 'game-report' | 'none';

/** 파일이 없거나 깨졌거나 그 폴더가 사라졌으면 null. */
export function readReportedModPath(file: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { modPath?: unknown };
    if (typeof parsed.modPath !== 'string' || !parsed.modPath) return null;
    return existsSync(parsed.modPath) ? parsed.modPath : null;
  } catch {
    return null;
  }
}

export function resolveSelfModSource(cfg: Config): SelfModSource {
  if (cfg.arma.selfModPath) return 'config';
  const reported = readReportedModPath(path.join(resolveStateDir(cfg), 'bridge-mod.json'));
  if (!reported) return 'none';
  cfg.arma.selfModPath = reported;
  log.info('[config] 게임이 알려 준 모드 경로: ' + reported);
  return 'game-report';
}
