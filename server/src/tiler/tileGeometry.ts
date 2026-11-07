// tileGeometry.ts: 게임 창 크기와 자리 계산. 창 타일러(windowTiler.ts)와 런처(stackArgs.ts)가 같이 쓴다.
//
// 게임은 3D 화면 비율을 프로필의 fovLeft/fovTop(새 프로필 기본 16:9)으로 정하고, 창 크기가 바뀌어도 따라 바꾸지 않는다.
// 창 클라이언트 영역이 그 비율과 다르면 화면이 늘어나 보인다. 그래서 창은 늘 설정 비율(stacks.windowWidth:windowHeight,
// 기본 16:9)의 클라이언트 영역으로 놓는다.

export interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** 창 클라이언트 영역 크기, 또는 그 가로세로 비율. */
export interface Size {
  width: number;
  height: number;
}

/** 바깥 창이 클라이언트 영역보다 큰 몫. */
export interface WindowFrame {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * 창 테두리와 제목 표시줄 몫(96 DPI, Windows 11 실측). Arma3.cfg 의 창 크기와 -posX, -posY 는
 * 클라이언트 영역 기준이라 바깥 창은 왼쪽으로 left, 위로 top 만큼 더 나간다.
 * -posX=0 -posY=0 인 1260x709 창의 바깥 사각형이 (-8, -31) 에서 1276x748 이었다.
 * 창 타일러는 헬퍼가 잰 창마다의 몫을 먼저 쓰고, 못 재면 이 값을 쓴다.
 */
export const WINDOW_FRAME: WindowFrame = { left: 8, top: 31, right: 8, bottom: 8 };

export const TILE_COLUMNS = 2;
export const TILE_ROWS = 2;
/** 모니터 하나의 칸 수. */
export const TILE_SLOTS = TILE_COLUMNS * TILE_ROWS;

/** 기본 화면 비율. 설정 창 크기 기본값 1600x900 과 같다. */
export const DEFAULT_ASPECT: Size = { width: 16, height: 9 };

/** 이 값 이하로 줄어드는 비율(16:9, 16:10, 21:9, 4:3)은 그 배수로 맞춰 픽셀까지 정확한 비율로 놓는다. */
const EXACT_UNIT_MAX = 64;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * maxW x maxH 안에 들어가는 가장 큰 aspect 비율 크기. 1264x657 안의 16:9 는 1168x657 이다.
 * 비율이 작은 정수로 줄면 그 배수(16:9 면 16k x 9k)로 골라 반올림 없이 정확한 비율이 된다.
 */
export function fitAspect(maxW: number, maxH: number, aspect: Size = DEFAULT_ASPECT): Size {
  const w = Math.max(0, Math.floor(maxW));
  const h = Math.max(0, Math.floor(maxH));
  const aw = Math.round(aspect.width);
  const ah = Math.round(aspect.height);
  if (w === 0 || h === 0 || aw <= 0 || ah <= 0) return { width: w, height: h };
  const g = gcd(aw, ah);
  const uw = aw / g;
  const uh = ah / g;
  if (uw <= EXACT_UNIT_MAX && uh <= EXACT_UNIT_MAX) {
    const k = Math.min(Math.floor(w / uw), Math.floor(h / uh));
    if (k >= 1) return { width: uw * k, height: uh * k };
  }
  const width = Math.min(w, Math.floor((h * aw) / ah));
  return { width, height: Math.min(h, Math.round((width * ah) / aw)) };
}

/** 작업 영역 칸 하나의 클라이언트 영역. 칸은 작업 영역을 가로세로 반으로 나눈 가장 작은 칸(왼쪽 위)을 기준으로 한다. */
export function tileClient(area: Rect, frame: WindowFrame = WINDOW_FRAME, aspect: Size = DEFAULT_ASPECT): Size {
  const cellW = Math.floor((area.r - area.l) / TILE_COLUMNS);
  const cellH = Math.floor((area.b - area.t) / TILE_ROWS);
  return fitAspect(cellW - frame.left - frame.right, cellH - frame.top - frame.bottom, aspect);
}

/**
 * 칸 slot(0..3, 왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래)에 놓을 바깥 창 사각형.
 * 네 창은 같은 크기이고 작업 영역 가운데 점에 붙어 모인다. 남는 자리는 모니터 가장자리 쪽에 생긴다.
 * 2560x1392 작업 영역이면 클라이언트 1168x657, 바깥 창 1184x696 이고 왼쪽 위 창이 (96,0) 에 놓인다.
 */
export function tileWindowRect(
  area: Rect,
  slot: number,
  frame: WindowFrame = WINDOW_FRAME,
  aspect: Size = DEFAULT_ASPECT,
): Rect {
  const client = tileClient(area, frame, aspect);
  const w = client.width + frame.left + frame.right;
  const h = client.height + frame.top + frame.bottom;
  const midX = area.l + Math.floor((area.r - area.l) / TILE_COLUMNS);
  const midY = area.t + Math.floor((area.b - area.t) / TILE_ROWS);
  const col = slot % TILE_COLUMNS;
  const row = Math.floor(slot / TILE_COLUMNS) % TILE_ROWS;
  const l = col === 0 ? midX - w : midX;
  const t = row === 0 ? midY - h : midY;
  return { l, t, r: l + w, b: t + h };
}
