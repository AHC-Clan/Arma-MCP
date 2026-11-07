// bridgeGate.ts — 이름 있는 스택을 띄우기 전에 배포된 브리지 DLL 을 확인한다.
//
// 0.5.0 이전 DLL 은 ARMA_MCP_GAME_PIPE 를 모르고 SQF 가 준 기본 파이프로 붙는다.
// 그러면 이름 있는 스택의 게임이 default 스택의 연결을 빼앗는다. 그래서 그런 DLL 이
// selfModPath 에 있으면 실행하기 전에 거절한다. DLL 파일은 읽기만 한다.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { compareVersions } from '../version.js';

export const MIN_STACK_BRIDGE_VERSION = '0.5.0';

const VERSION_RE = /ArmaMCP (\d+\.\d+\.\d+)/g;

/** DLL 바이트에 박힌 "ArmaMCP x.y.z" 중 가장 높은 버전. 못 찾으면 null. */
export function versionInDll(bytes: Buffer): string | null {
  const text = bytes.toString('latin1');
  let best: string | null = null;
  for (const m of text.matchAll(VERSION_RE)) {
    const v = m[1]!;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

/**
 * 이름 있는 스택에 써도 되는 브리지인지. 문제가 있으면 이유, 없으면 null.
 * selfModPath 가 비었거나 DLL 이 없으면 브리지 자체가 없으므로 막지 않는다.
 */
export async function stackBridgeProblem(selfModPath: string): Promise<string | null> {
  if (!selfModPath) return null;
  const dll = path.join(selfModPath, 'arma_mcp_x64.dll');
  let bytes: Buffer;
  try {
    bytes = await readFile(dll);
  } catch {
    return null;
  }
  const version = versionInDll(bytes);
  if (version !== null && compareVersions(version, MIN_STACK_BRIDGE_VERSION) >= 0) return null;
  return (
    `배포된 브리지 DLL(${dll})이 ${version ?? '알 수 없는 버전'} 이다. ` +
    `이름 있는 스택은 ${MIN_STACK_BRIDGE_VERSION} 이상이 필요하다. 이전 DLL 은 스택 파이프를 몰라 ` +
    'default 스택의 게임 연결을 빼앗는다. 브리지를 다시 배포한 뒤 실행한다'
  );
}
