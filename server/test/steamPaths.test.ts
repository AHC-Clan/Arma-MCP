// steamPaths.test.ts — 설정 없는 컴퓨터의 Arma 3 자동 탐지. 실제 Steam 설치에 의존하지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  detectArmaPaths,
  parseLibraryFolders,
  parseRegistryValue,
} from '../src/game/steamPaths.js';

const STEAM_ROOT = 'C:\\Program Files (x86)\\Steam';
const LIBRARY = 'D:\\SteamLibrary';

function vdf(paths: string[]): string {
  const blocks = paths
    .map(
      (value, index) =>
        `\t"${index}"\n\t{\n\t\t"path"\t\t"${value.replace(/\\/g, '\\\\')}"\n\t}`,
    )
    .join('\n');
  return `"libraryfolders"\n{\n${blocks}\n}\n`;
}

test('parseRegistryValue: reg query 출력에서 REG_SZ 값만 뽑는다', () => {
  const output =
    'HKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n' +
    '    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n';
  assert.equal(parseRegistryValue(output), 'c:/program files (x86)/steam');
  assert.equal(parseRegistryValue('값 없음'), null);
});

test('parseLibraryFolders: 신·구 vdf 포맷과 중복 제거', () => {
  const parsed = parseLibraryFolders(vdf([STEAM_ROOT, LIBRARY, LIBRARY]));
  assert.deepEqual(parsed, [path.normalize(STEAM_ROOT), path.normalize(LIBRARY)]);

  const legacy = `"LibraryFolders"\n{\n\t"1"\t\t"${LIBRARY.replace(/\\/g, '\\\\')}"\n}\n`;
  assert.deepEqual(parseLibraryFolders(legacy), [path.normalize(LIBRARY)]);
});

test('detectArmaPaths: 두 번째 라이브러리에 설치된 Arma 를 찾는다', async () => {
  const gameDir = path.join(LIBRARY, 'steamapps', 'common', 'Arma 3');
  const exePath = path.join(gameDir, 'Arma3_x64.exe');
  const serverExePath = path.join(gameDir, 'arma3server_x64.exe');
  const detected = await detectArmaPaths({
    queryRegistry: async (keyPath) =>
      keyPath.startsWith('HKCU') ? STEAM_ROOT : null,
    readTextFile: (target) =>
      target === path.join(STEAM_ROOT, 'steamapps', 'libraryfolders.vdf')
        ? vdf([STEAM_ROOT, LIBRARY])
        : null,
    exists: (target) => target === exePath || target === serverExePath,
  });

  assert.ok(detected);
  assert.equal(detected.exePath, exePath);
  assert.equal(detected.serverExePath, serverExePath);
  assert.equal(detected.steamRoot, path.normalize(STEAM_ROOT));
});

test('detectArmaPaths: 데디 서버 실행 파일이 없으면 빈 문자열', async () => {
  const exePath = path.join(STEAM_ROOT, 'steamapps', 'common', 'Arma 3', 'Arma3_x64.exe');
  const detected = await detectArmaPaths({
    queryRegistry: async () => STEAM_ROOT,
    readTextFile: () => null,
    exists: (target) => target === exePath,
  });

  assert.ok(detected);
  assert.equal(detected.exePath, exePath);
  assert.equal(detected.serverExePath, '');
});

test('detectArmaPaths: Steam 이 없거나 Arma 미설치면 null', async () => {
  assert.equal(
    await detectArmaPaths({ queryRegistry: async () => null, exists: () => false }),
    null,
  );
  assert.equal(
    await detectArmaPaths({
      queryRegistry: async () => STEAM_ROOT,
      readTextFile: () => null,
      exists: () => false,
    }),
    null,
  );
});
