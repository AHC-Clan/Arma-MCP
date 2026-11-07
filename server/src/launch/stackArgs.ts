// stackArgs.ts — 스택이 게임 실행 인자와 환경에 더하는 것.
//
// 이름 있는 스택의 게임은 -profiles 로 그 스택 폴더에 RPT 와 프로필을 쓰고, 그 -profiles
// 경로가 곧 스택 소속의 표시다(processIndex.ts). 그래서 스택이 정하는 인자는 설정과
// 호출 인자가 덮어쓰지 못하게 한다.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import type { Config } from '../config.js';
import { defaultQueryRegistry } from '../game/steamPaths.js';
import type { StackContext } from '../stack/stackContext.js';
import { planTestMods, type TestModPlan } from '../stack/testMods.js';
import { DEFAULT_ASPECT, WINDOW_FRAME, tileClient } from '../tiler/tileGeometry.js';
import { log } from '../log.js';

/** DLL 이 SQF 파이프 이름 대신 쓰는 환경 변수(extension/src/Bridge.hpp 와 같은 이름). */
export const GAME_PIPE_ENV = 'ARMA_MCP_GAME_PIPE';

/** 스택이 값을 정하는 인자. 설정의 baseArgs 에 있으면 빼고, 호출 인자에 있으면 거절한다. */
export const STACK_OWNED_FLAGS: readonly string[] = ['-profiles', '-name', '-port', '-config'];

/** Launcher 와 MpLauncher 가 스택에서 받는 것. 없으면 0.4 와 똑같이 돈다. */
export interface LaunchStackOptions {
  ctx: StackContext;
  /** modset='rpt' 가 -mod 를 읽는 클라 RPT 폴더. 이름 있는 스택도 default 클라 폴더를 본다. */
  modsetRptDir: string;
  /** 스택 폴더들의 상위. RPT 헤더에서 읽은 모드 중 이 아래 경로는 다음 실행에 싣지 않는다. */
  stacksRoot: string;
  /** 이름 있는 스택을 띄우기 전 확인. 문제가 있으면 이유를 돌려준다. */
  bridgeGate?: () => Promise<string | null>;
  /** 여러 클라 창을 놓을 화면 영역. 없으면 주 모니터 작업 영역을 읽는다(screenArea.ts). */
  workArea?: () => Promise<ScreenArea>;
  /** 창 타일러가 이번 클라들에 줄 칸 크기. 없으면 데몬의 타일러에 묻는다(tiler/tilerService.ts 의 plannedTileSizes). */
  tilePlan?: (stack: string, count: number) => (ClientWindowSize | null)[] | null;
}

function flagName(arg: string): string {
  const eq = arg.indexOf('=');
  return (eq >= 0 ? arg.slice(0, eq) : arg).replace(/^"|"$/g, '').toLowerCase();
}

/** 클라마다 달라야 하는 프로필 인자. 클라가 여럿이면 스택이 클라마다 정한다. */
export const CLIENT_PROFILE_FLAGS: readonly string[] = ['-profiles', '-name'];

/** args 에서 flags 에 든 인자를 뺀다. */
export function withoutFlags(args: readonly string[], flags: readonly string[]): string[] {
  return args.filter((a) => !flags.includes(flagName(a)));
}

/** args 중 flags 에 든 인자. 비어 있으면 없다. */
export function flagsIn(args: readonly string[] | undefined, flags: readonly string[]): string[] {
  return (args ?? []).filter((a) => flags.includes(flagName(a)));
}

/** 스택이 정하는 인자를 뺀다. */
export function stripStackOwned(args: readonly string[]): string[] {
  return withoutFlags(args, STACK_OWNED_FLAGS);
}

/** 호출 인자 중 스택이 정하는 인자. 비어 있으면 문제없다. */
export function stackOwnedIn(args: readonly string[] | undefined): string[] {
  return flagsIn(args, STACK_OWNED_FLAGS);
}

/**
 * 클라 i 에 붙일 인자. default 스택 클라 1 은 0.4 그대로라 아무것도 없다.
 * 그 밖의 클라는 제 profiles 폴더와 이름을 받고, 여러 창이 겹쳐 뜨므로 창 모드로 띄운다.
 */
export function clientStackArgs(ctx: StackContext, index: number): string[] {
  const profiles = ctx.clientProfilesDir(index);
  const name = ctx.clientName(index);
  const out: string[] = [];
  if (profiles) out.push(`-profiles="${profiles}"`);
  if (name) out.push(`-name=${name}`);
  if (profiles || name) out.push('-window');
  return out;
}

/**
 * 데몬이 띄우는 모든 클라에 넣는 인자. 엔진은 창이 포커스를 잃으면 SP 게임 시간을 멈추고
 * 프레임을 약 20 FPS 로 늦춘다. -noPause 는 창 모드 인게임(클라 상태 10)에서 이것을 풀고 60 FPS 로 묶는다.
 * 소리는 -noPauseAudio 가 따로 정한다. 그것은 넣지 않는다.
 */
export const NO_PAUSE_FLAG = '-noPause';

/** args 에 -noPause 가 없으면 끝에 더한다. -noPauseAudio 는 다른 인자로 본다. */
export function withNoPause(args: readonly string[]): string[] {
  return flagsIn(args, [NO_PAUSE_FLAG.toLowerCase()]).length > 0 ? [...args] : [...args, NO_PAUSE_FLAG];
}

/** 창 자리를 정하는 인자. 호출 인자나 설정에 있으면 그 값을 따른다. */
const WINDOW_POSITION_FLAGS: readonly string[] = ['-posx', '-posy'];

/** 화면의 사각형. 클라 창은 주 모니터 작업 영역(작업 표시줄을 뺀 자리) 안에 놓는다. */
export interface ScreenArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 창 클라이언트 영역의 왼쪽 위 자리. -posX, -posY 값이다. */
export interface WindowPosition {
  x: number;
  y: number;
}

/** 창 테두리와 제목 표시줄 몫. 창 타일러와 같은 값이다(tiler/tileGeometry.ts). */
export { WINDOW_FRAME };

/**
 * 클라 count 개의 창 자리. 다 들어가면 바깥 창이 겹치지 않는 격자로 놓는다. 안 들어가면 칸 간격을 좁혀
 * 모든 바깥 창을 area 안에 둔다. 창마다 보이는 넓이(가로 간격 x 세로 간격)가 가장 큰 열 수를 고르고,
 * 같으면 열이 많은 쪽이다.
 */
export function clientWindowPositions(count: number, size: ClientWindowSize, area: ScreenArea): WindowPosition[] {
  const w = size.width + WINDOW_FRAME.left + WINDOW_FRAME.right;
  const h = size.height + WINDOW_FRAME.top + WINDOW_FRAME.bottom;
  const step = (span: number, item: number, n: number): number =>
    n > 1 ? Math.min(item, Math.floor(Math.max(0, span - item) / (n - 1))) : item;
  let best = { cols: Math.max(1, count), dx: 0, dy: 0, seen: -1 };
  for (let cols = count; cols >= 1; cols--) {
    const dx = step(area.width, w, cols);
    const dy = step(area.height, h, Math.ceil(count / cols));
    if (dx * dy > best.seen) best = { cols, dx, dy, seen: dx * dy };
  }
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + (i % best.cols) * best.dx + WINDOW_FRAME.left,
    y: area.y + Math.floor(i / best.cols) * best.dy + WINDOW_FRAME.top,
  }));
}

/** 자동으로 줄인 창 폭의 하한. 이보다 작아져야 들어가면 줄이지 않고 설정 크기로 겹쳐 놓는다. */
export const MIN_FITTED_WINDOW_WIDTH = 640;

/** 창 크기나 자리를 정하는 인자(-x, -y 는 Arma3.cfg 의 winWidth, winHeight 를 이긴다). 있으면 창 크기를 줄이지 않는다. */
export const WINDOW_LAYOUT_FLAGS: readonly string[] = ['-x', '-y', '-posx', '-posy'];

/**
 * 이번 실행의 클라 창 크기. configured 는 설정 크기로 다 들어간 것, shrunk 는 줄인 것,
 * floor 는 하한에 걸려 설정 크기로 겹쳐 놓은 것, userArgs 는 사용자가 창 인자를 줘서 손대지 않은 것,
 * tiled 는 창 타일러(tiler/windowTiler.ts)의 네 칸 크기다.
 */
export interface FittedWindowSize {
  size: ClientWindowSize;
  mode: 'configured' | 'shrunk' | 'floor' | 'userArgs' | 'tiled';
}

/**
 * 창 타일러의 칸에 맞는 클라이언트 영역 크기. 타일러가 놓는 크기와 같다(tiler/tileGeometry.ts).
 * 칸(작업 영역의 4분의 1)에서 바깥 창 몫 WINDOW_FRAME 을 뺀 자리에 들어가는 가장 큰 aspect 비율 크기다.
 * 2560x1392 이면 칸 1280x696, 16:9 클라이언트 1168x657 이다.
 */
export function tileClientSize(area: ScreenArea, aspect: ClientWindowSize = DEFAULT_ASPECT): ClientWindowSize {
  return tileClient({ l: area.x, t: area.y, r: area.x + area.width, b: area.y + area.height }, WINDOW_FRAME, aspect);
}

/**
 * 클라 count 개가 겹치지 않는 격자로 area 에 들어가는 창 크기. 설정 크기로 들어가면 그대로 쓰고,
 * 안 들어가면 설정 비율(기본 16:9)을 지키며 들어갈 만큼 줄인다. 바깥 창은 WINDOW_FRAME 만큼 크게 친다.
 * 줄인 폭이 MIN_FITTED_WINDOW_WIDTH 보다 작으면 줄이지 않는다.
 */
export function fitClientWindowSize(count: number, size: ClientWindowSize, area: ScreenArea): FittedWindowSize {
  const fw = WINDOW_FRAME.left + WINDOW_FRAME.right;
  const fh = WINDOW_FRAME.top + WINDOW_FRAME.bottom;
  const colsFit = Math.floor(area.width / (size.width + fw));
  const rowsFit = Math.floor(area.height / (size.height + fh));
  if (count <= 1 || colsFit * rowsFit >= count) return { size, mode: 'configured' };
  // 열 수마다 한 칸에 들어가는 가장 큰 폭(가로 제한과 세로 제한 중 작은 쪽)을 보고 가장 큰 것을 고른다.
  let width = 0;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const byWidth = Math.floor(area.width / cols) - fw;
    const byHeight = Math.floor(((Math.floor(area.height / rows) - fh) * size.width) / size.height);
    width = Math.max(width, Math.min(byWidth, byHeight));
  }
  if (width < MIN_FITTED_WINDOW_WIDTH) return { size, mode: 'floor' };
  return { size: { width, height: Math.floor((width * size.height) / size.width) }, mode: 'shrunk' };
}

/** 창 자리 인자. args 에 -posX 나 -posY 가 이미 있으면 더하지 않는다. */
export function windowPositionArgs(pos: WindowPosition | undefined, args: readonly string[]): string[] {
  if (!pos || flagsIn(args, WINDOW_POSITION_FLAGS).length > 0) return [];
  return [`-posX=${pos.x}`, `-posY=${pos.y}`];
}

/** 게임 프로세스 환경. DLL 이 이 스택의 파이프로 붙게 한다. */
export function stackSpawnEnv(ctx: StackContext): NodeJS.ProcessEnv {
  return { ...process.env, [GAME_PIPE_ENV]: ctx.pipeName };
}

/** 창 모드 클라의 창과 렌더 크기. */
export interface ClientWindowSize {
  width: number;
  height: number;
}

export function clientWindowSize(cfg: Config): ClientWindowSize {
  return { width: cfg.stacks.windowWidth, height: cfg.stacks.windowHeight };
}

export interface ClientProfileOptions {
  window: ClientWindowSize;
  /** 화면 설정을 가져올 사용자 Arma3.cfg. 주지 않으면 문서 폴더에서 찾고, null 이면 가져오지 않는다. */
  userCfg?: string | null;
  /** Windows 사용자 이름. Arma 는 -profiles 아래 Users\<이 이름>\Arma3.cfg 를 읽는다. */
  user?: string;
}

/** -profiles 를 받은 Arma 가 화면 설정을 읽고 쓰는 Arma3.cfg. */
export function clientArmaCfgPath(dir: string, user = userInfo().username): string {
  return path.join(dir, 'Users', user, 'Arma3.cfg');
}

/** Arma 가 창 모드에서 창과 렌더 크기로 읽는 Arma3.cfg 항목. 렌더도 같게 둬 샘플링을 100% 로 맞춘다. */
const WINDOW_KEYS = {
  winWidth: 'width',
  winHeight: 'height',
  winDefWidth: 'width',
  winDefHeight: 'height',
  renderWidth: 'width',
  renderHeight: 'height',
} as const;

/** Arma3.cfg 본문의 창 크기 줄을 size 로 바꾸고 없는 줄은 끝에 더한다. 다른 줄은 그대로 둔다. */
export function withWindowSize(text: string, size: ClientWindowSize): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/).map((line) => {
    const key = /^\s*(\w+)\s*=/.exec(line)?.[1];
    if (!key || !(key in WINDOW_KEYS)) return line;
    seen.add(key);
    return `${key}=${size[WINDOW_KEYS[key as keyof typeof WINDOW_KEYS]]};`;
  });
  if (lines.at(-1) === '') lines.pop();
  for (const [key, dim] of Object.entries(WINDOW_KEYS)) {
    if (!seen.has(key)) lines.push(`${key}=${size[dim]};`);
  }
  return lines.join(eol) + eol;
}

/**
 * 클라 profiles 폴더의 Arma3.cfg 를 준비한다. 실행마다 사용자 Arma3.cfg 의 화면 설정을 가져오고
 * 창과 렌더 크기만 window 로 바꾼다. 사용자 파일이 없으면 클라가 쓰던 파일에 크기만 적는다.
 * 실패해도 실행은 막지 않는다. Arma 는 파일이 없으면 기본값 1024x768 로 만든다.
 */
export async function prepareClientProfile(dir: string | null, opts: ClientProfileOptions): Promise<void> {
  if (!dir) return;
  try {
    const target = clientArmaCfgPath(dir, opts.user);
    mkdirSync(path.dirname(target), { recursive: true });
    const userCfg = opts.userCfg === undefined ? await defaultUserArmaCfg() : opts.userCfg;
    const source = userCfg && existsSync(userCfg) ? userCfg : existsSync(target) ? target : null;
    // Arma3.cfg 는 ANSI 다. latin1 로 읽고 써서 바이트를 그대로 둔다.
    const text = source ? readFileSync(source, 'latin1') : '';
    writeFileSync(target, withWindowSize(text, opts.window), 'latin1');
  } catch (e) {
    log.warn(`[launch] 클라 profiles 준비 실패(${dir}): ${(e as Error).message}`);
  }
}

const SHELL_FOLDERS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';

/** 사용자의 Arma3.cfg. 문서 폴더는 OneDrive 로 옮겨져 있을 수 있어 레지스트리를 먼저 본다. */
async function defaultUserArmaCfg(): Promise<string> {
  const raw = await defaultQueryRegistry(SHELL_FOLDERS_KEY, 'Personal');
  const documents = raw
    ? raw.replace(/%([^%]+)%/g, (m, name: string) => process.env[name] ?? m)
    : path.join(homedir(), 'Documents');
  return path.join(documents, 'Arma 3', 'Arma3.cfg');
}

const MB = 1024 * 1024;

/**
 * 실행 하나의 테스트 애드온 계획. testMods 가 없으면 plan 은 null 이다.
 * 스택 런타임 밖(스택 정보가 없는 호출)에서는 테스트 애드온을 받지 않는다.
 */
export async function planLaunchTestMods(
  stack: LaunchStackOptions | undefined,
  cfg: Config,
  mods: readonly string[],
  testMods: readonly string[] | undefined,
): Promise<{ ok: true; plan: TestModPlan | null } | { ok: false; error: string }> {
  if (!testMods || testMods.length === 0) return { ok: true, plan: null };
  if (!stack) return { ok: false, error: '테스트 애드온은 스택 런타임에서만 쓸 수 있다' };
  return planTestMods({
    testMods,
    mods,
    testModDir: stack.ctx.testModDir,
    overlayDir: stack.ctx.overlayDir,
    maxBytes: (cfg.stacks?.testModMaxMB ?? 512) * MB,
    overlayCopyMaxBytes: (cfg.stacks?.overlayCopyMaxMB ?? 1024) * MB,
  });
}
