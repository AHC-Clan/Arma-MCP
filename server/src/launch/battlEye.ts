// battlEye.ts — 데몬이 띄우는 게임은 BattlEye 를 늘 끈다.
//
// 한 PC 에서 같은 Steam ID 클라 여럿을 한 서버에 붙이는 테스트는 BattlEye 와 함께 돌지 않는다.
// 서버는 MCP 가 만든 server.cfg 의 BattlEye = 0 하나로 끄고, 클라는 BattlEye 실행기를 거치지 않고
// 게임 exe 를 바로 띄워 끈다.

import path from 'node:path';

/** server.cfg 한 줄에서 BattlEye 값을 정하는 자리. */
const BATTLEYE_SETTING_RE = /(?:^|[;{\s])battleye\s*=/i;

/** 덧붙일 server.cfg 줄을 BattlEye 를 정하는 줄과 나머지로 가른다. */
export function splitBattlEyeLines(lines: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const line of lines) (BATTLEYE_SETTING_RE.test(line) ? dropped : kept).push(line);
  return { kept, dropped };
}

/** 클라 exe 가 BattlEye 실행기면 거절 이유. 게임 exe 를 바로 띄우면 클라 BattlEye 는 켜지지 않는다. */
export function battlEyeExeProblem(exePath: string): string | null {
  const name = path.win32.basename(exePath);
  if (!/battleye/i.test(name)) return null;
  return (
    `arma.exePath 가 BattlEye 실행기다(${name}). ` +
    'MCP 가 띄우는 게임은 BattlEye 를 끄므로 같은 폴더의 arma3_x64.exe 로 바꾼다'
  );
}
