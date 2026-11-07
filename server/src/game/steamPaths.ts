// steamPaths.ts — 설정 없이 첫 실행되는 컴퓨터에서 Arma 3 설치 위치를 찾아낸다.
//
// 사용자가 config 에 exePath 를 적었으면 절대 건드리지 않는다. 탐지 결과는 메모리에만 쓰고
// 설정 파일로 굳히지 않는다 — Steam 라이브러리를 옮기면 낡은 경로가 남기 때문이다.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ARMA_CLIENT_EXE = 'Arma3_x64.exe';
const ARMA_SERVER_EXE = 'arma3server_x64.exe';
const ARMA_COMMON_DIR = path.join('steamapps', 'common', 'Arma 3');

export interface ArmaPathDetection {
  exePath: string;
  /** 같은 폴더에 데디 서버 실행 파일이 없으면 빈 문자열. */
  serverExePath: string;
  steamRoot: string;
}

export interface DetectOptions {
  /** 테스트 주입용. 값이 없으면 null. */
  queryRegistry?: (keyPath: string, valueName: string) => Promise<string | null>;
  exists?: (target: string) => boolean;
  readTextFile?: (target: string) => string | null;
}

/** `reg query` 한 줄에서 REG_SZ 값만 뽑는다. */
export function parseRegistryValue(output: string): string | null {
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/m.exec(output);
  return match ? match[1]!.trim() : null;
}

/** libraryfolders.vdf 의 라이브러리 경로들(구/신 포맷 모두). */
export function parseLibraryFolders(text: string): string[] {
  const found: string[] = [];
  const re = /"(?:\d+|path)"\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const value = match[1]!.replace(/\\\\/g, '\\').trim();
    if (value) found.push(path.normalize(value));
  }
  return [...new Set(found)];
}

export async function defaultQueryRegistry(
  keyPath: string,
  valueName: string,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('reg', ['query', keyPath, '/v', valueName], {
      encoding: 'utf8',
      // 콘솔 없는 daemon 에서 reg.exe 가 창을 띄우지 않게 한다.
      windowsHide: true,
    });
    return parseRegistryValue(stdout);
  } catch {
    return null;
  }
}

/**
 * Steam 레지스트리 → libraryfolders.vdf → 각 라이브러리의 Arma 3 순으로 탐지한다.
 * 찾지 못하면 null 이며, 호출자는 조용히 기존 설정값(빈 값)을 유지한다.
 */
export async function detectArmaPaths(
  options: DetectOptions = {},
): Promise<ArmaPathDetection | null> {
  const queryRegistry = options.queryRegistry ?? defaultQueryRegistry;
  const exists = options.exists ?? existsSync;
  const readTextFile =
    options.readTextFile ??
    ((target: string): string | null => {
      try {
        return readFileSync(target, 'utf8');
      } catch {
        return null;
      }
    });

  const steamRoot =
    (await queryRegistry('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ??
    (await queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
  if (!steamRoot) return null;

  const normalizedRoot = path.normalize(steamRoot);
  const roots = [normalizedRoot];
  const vdf = readTextFile(path.join(normalizedRoot, 'steamapps', 'libraryfolders.vdf'));
  if (vdf) roots.push(...parseLibraryFolders(vdf));

  for (const root of [...new Set(roots)]) {
    const gameDir = path.join(root, ARMA_COMMON_DIR);
    const exePath = path.join(gameDir, ARMA_CLIENT_EXE);
    if (!exists(exePath)) continue;
    const serverExePath = path.join(gameDir, ARMA_SERVER_EXE);
    return {
      exePath,
      serverExePath: exists(serverExePath) ? serverExePath : '',
      steamRoot: normalizedRoot,
    };
  }
  return null;
}
