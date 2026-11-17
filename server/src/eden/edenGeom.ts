// edenGeom.ts: arma_eden_* 툴의 배치 판정과 관계 계산(게임 불필요).
//
// 게임은 잰 값만 보내고(edenSqf.ts), 판정은 여기서 한다. LLM 이 좌표를 눈대중으로 찍으면
// 물체가 겹치거나 뜨므로, 툴은 판정(지면, 뜸, 묻힘, 겹침)을 계산해 함께 돌려주고
// "옆에", "위에", "바라보게" 같은 관계를 받아 좌표를 여기서 푼다.
//
// 좌표계는 Arma 월드다. +X 동쪽, +Y 북쪽, +Z 위, 높이는 해수면 기준(ASL).
// 방위각(dir)은 북쪽에서 시계 방향 도. 모델 축은 +X 오른쪽, +Y 앞, +Z 위다.

export type EdenKind = 'unit' | 'vehicle' | 'object' | 'logic' | 'trigger' | 'marker' | 'map';

/** 게임에서 잰 엔티티 하나. 상자는 boundingBoxReal 의 모델 축 상자를 월드에 놓은 것이다. */
export interface EdenBox {
  /** Eden 엔티티 id. 맵 물체(kind 'map')는 0 이다. */
  id: number;
  kind: EdenKind;
  class: string;
  /** 변수 이름. 마커는 마커 이름. */
  name: string;
  layer: string;
  /** 상자 중심(월드 ASL). 상자가 없으면 위치. */
  center: [number, number, number];
  dir: number;
  /** 모델 축 반길이 [오른쪽, 앞, 위]. 상자가 없으면 0. */
  half: [number, number, number];
  /** 상자 아래 네 모서리 중 가장 낮은 높이(ASL). */
  bottom: number;
  /**
   * 아래 네 모서리마다 그 아래 표면까지의 틈(m) 중 가장 작은 값과 큰 값. 표면은 상자 위에서
   * 아래로 쏜 선이 자기를 빼고 처음 닿은 곳이고 지형보다 낮지 않다. 다른 물체가 모서리 위로
   * 겹쳐 있으면 그 물체 윗면에 닿아 음수가 된다. 경사면에서는 두 값이 벌어진다.
   */
  gapMin: number;
  gapMax: number;
  /** 위쪽 벡터가 수직에서 기운 각(도). */
  tilt: number;
  /** Eden 위치 속성의 z. 에디터 화면에 보이는 높이다. */
  attrZ: number;
  water: boolean;
  /** 상자를 잰 엔티티인가(마커, 트리거, 로직은 아니다). */
  hasBox: boolean;
}

export type GroundState = 'ground' | 'floating' | 'sunk';

/** 이 거리(m) 안이면 닿은 것으로 본다. */
export const CONTACT_TOL = 0.05;

const RAD = Math.PI / 180;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function norm360(d: number): number {
  const r = d % 360;
  return r < 0 ? r + 360 : r;
}

/** dir 의 월드 축. right 는 모델 +X, fwd 는 모델 +Y 가 가리키는 수평 방향이다. */
export function axes(dir: number): { right: [number, number]; fwd: [number, number] } {
  const a = dir * RAD;
  return { right: [Math.cos(a), -Math.sin(a)], fwd: [Math.sin(a), Math.cos(a)] };
}

/** from 에서 to 를 보는 방위각(도). */
export function bearing(from: readonly number[], to: readonly number[]): number {
  const dx = (to[0] ?? 0) - (from[0] ?? 0);
  const dy = (to[1] ?? 0) - (from[1] ?? 0);
  return round2(norm360(Math.atan2(dx, dy) / RAD));
}

/**
 * 상자 아래와 그 아래 표면 사이. 가장 가까운 모서리가 tol 보다 떠 있으면 floating,
 * 어느 모서리든 tol 보다 깊이 들어가 있으면 sunk 다. gap 은 가장 작은 모서리 틈이다.
 * 경사면에 똑바로 선 건물은 오르막 쪽이 묻혀 sunk 로 나온다. 게임에서도 흔한 배치다.
 */
export function groundVerdict(
  b: EdenBox,
  tol = CONTACT_TOL,
): { state: GroundState; gap: number; spread: number } {
  const gap = round2(b.gapMin);
  const spread = round2(b.gapMax - b.gapMin);
  if (gap > tol) return { state: 'floating', gap, spread };
  if (gap < -tol) return { state: 'sunk', gap, spread };
  return { state: 'ground', gap, spread };
}

/** 반길이 half, 방향 dir 인 상자를 수평 단위 벡터 axis 에 투영한 반길이. */
export function projectHalf(half: readonly number[], dir: number, axis: readonly number[]): number {
  const { right, fwd } = axes(dir);
  const ax = axis[0] ?? 0;
  const ay = axis[1] ?? 0;
  return (
    Math.abs((half[0] ?? 0) * (right[0] * ax + right[1] * ay)) +
    Math.abs((half[1] ?? 0) * (fwd[0] * ax + fwd[1] * ay))
  );
}

/**
 * 두 상자의 수평 겹침 깊이(m). 분리축 정리로 네 축을 보고 가장 얕은 겹침을 돌려준다.
 * 떨어져 있으면 0 이다.
 */
export function overlap2D(a: EdenBox, b: EdenBox): number {
  const d = [b.center[0] - a.center[0], b.center[1] - a.center[1]];
  const ax = axes(a.dir);
  const bx = axes(b.dir);
  let depth = Infinity;
  for (const axis of [ax.right, ax.fwd, bx.right, bx.fwd]) {
    const dist = Math.abs((d[0] ?? 0) * axis[0] + (d[1] ?? 0) * axis[1]);
    const pen = projectHalf(a.half, a.dir, axis) + projectHalf(b.half, b.dir, axis) - dist;
    if (pen <= 0) return 0;
    depth = Math.min(depth, pen);
  }
  return depth;
}

/** 두 상자의 높이 겹침(m). */
export function overlapZ(a: EdenBox, b: EdenBox): number {
  const lo = Math.max(a.center[2] - a.half[2], b.center[2] - b.half[2]);
  const hi = Math.min(a.center[2] + a.half[2], b.center[2] + b.half[2]);
  return Math.max(0, hi - lo);
}

export interface OverlapPair {
  a: number;
  b: number;
  /** b 가 맵 물체면 그 클래스. */
  bClass?: string;
  /** 수평 겹침 깊이(m). */
  depth: number;
}

/**
 * targets 가 서로, 그리고 others 와 겹치는 쌍. 상자끼리의 판정이라 실제 메시가 닿았는지는 아니다.
 * 위에 올려 둔 물체(높이 겹침이 tol 이하)는 겹침으로 치지 않는다.
 */
export function findOverlaps(
  targets: readonly EdenBox[],
  others: readonly EdenBox[] = [],
  tol = CONTACT_TOL,
): OverlapPair[] {
  const out: OverlapPair[] = [];
  const boxed = targets.filter((t) => t.hasBox);
  const check = (a: EdenBox, b: EdenBox): void => {
    if (!b.hasBox || a === b) return;
    if (overlapZ(a, b) <= tol) return;
    const depth = overlap2D(a, b);
    if (depth <= tol) return;
    out.push({ a: a.id, b: b.id, ...(b.kind === 'map' ? { bClass: b.class } : {}), depth: round2(depth) });
  };
  for (let i = 0; i < boxed.length; i++) {
    for (let j = i + 1; j < boxed.length; j++) check(boxed[i] as EdenBox, boxed[j] as EdenBox);
  }
  const ids = new Set(boxed.map((t) => t.id));
  for (const a of boxed) {
    for (const b of others) {
      if (b.kind !== 'map' && ids.has(b.id)) continue;
      check(a, b);
    }
  }
  return out;
}

export type Side = 'front' | 'back' | 'left' | 'right';

/**
 * ref 의 side 쪽에 반길이 half, 방향 dir 인 상자를 gap 만큼 띄워 붙일 때의 중심(x, y).
 * offset 은 ref 축 기준 옆 방향 이동이다(front, back 이면 오른쪽, left, right 이면 앞).
 */
export function besidePos(
  ref: EdenBox,
  side: Side,
  half: readonly number[],
  dir: number,
  gap = 0,
  offset = 0,
): [number, number] {
  const { right, fwd } = axes(ref.dir);
  const neg = (v: [number, number]): [number, number] => [-v[0], -v[1]];
  const axis = side === 'front' ? fwd : side === 'back' ? neg(fwd) : side === 'right' ? right : neg(right);
  const lateral = side === 'front' || side === 'back' ? right : fwd;
  const dist = projectHalf(ref.half, ref.dir, axis) + projectHalf(half, dir, axis) + gap;
  return [
    round2(ref.center[0] + axis[0] * dist + lateral[0] * offset),
    round2(ref.center[1] + axis[1] * dist + lateral[1] * offset),
  ];
}

/** ref 축 기준 [오른쪽, 앞] 이동을 월드 (x, y) 로. */
export function localToWorld(ref: EdenBox, offset: readonly number[]): [number, number] {
  const { right, fwd } = axes(ref.dir);
  const r = offset[0] ?? 0;
  const f = offset[1] ?? 0;
  return [round2(ref.center[0] + right[0] * r + fwd[0] * f), round2(ref.center[1] + right[1] * r + fwd[1] * f)];
}

// ---------------------------------------------------------------- 화면 구도

export type ViewName = 'top' | 'front' | 'side' | 'iso';

export interface CameraPose {
  view: ViewName;
  /** 카메라 위치(ASL). */
  pos: [number, number, number];
  /** 보는 방향 단위 벡터. */
  vectorDir: [number, number, number];
  vectorUp: [number, number, number];
  /** 구도 중심까지 거리(m). */
  distance: number;
}

/** 대상 상자들을 감싸는 구의 중심과 반지름. 상자가 없는 엔티티는 점으로 친다. */
export function frameOf(boxes: readonly EdenBox[]): { center: [number, number, number]; radius: number } {
  if (boxes.length === 0) return { center: [0, 0, 0], radius: 0 };
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    const r = Math.hypot(b.half[0], b.half[1]);
    lo = [Math.min(lo[0]!, b.center[0] - r), Math.min(lo[1]!, b.center[1] - r), Math.min(lo[2]!, b.center[2] - b.half[2])];
    hi = [Math.max(hi[0]!, b.center[0] + r), Math.max(hi[1]!, b.center[1] + r), Math.max(hi[2]!, b.center[2] + b.half[2])];
  }
  const center: [number, number, number] = [
    round2((lo[0]! + hi[0]!) / 2),
    round2((lo[1]! + hi[1]!) / 2),
    round2((lo[2]! + hi[2]!) / 2),
  ];
  const radius = round2(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2);
  return { center, radius };
}

/**
 * 구 하나가 화면에 들어오는 카메라 자리. fovDeg 는 화면의 좁은 쪽 시야각이다.
 * front 는 facing(대상의 앞) 쪽에서 대상을 보고, side 는 그 오른쪽, iso 는 앞 오른쪽 위 35도다.
 * floorZ 는 카메라가 내려가면 안 되는 높이(지형 + 여유)다.
 */
export function cameraFor(
  view: ViewName,
  center: readonly number[],
  radius: number,
  facing = 180,
  fovDeg = 40,
  floorZ = -Infinity,
): CameraPose {
  const dist = round2(Math.max(3, Math.max(radius, 1) / Math.sin((fovDeg / 2) * RAD)));
  const cx = center[0] ?? 0;
  const cy = center[1] ?? 0;
  const cz = center[2] ?? 0;
  if (view === 'top') {
    return { view, pos: [cx, cy, round2(cz + dist)], vectorDir: [0, 0, -1], vectorUp: [0, 1, 0], distance: dist };
  }
  const from = view === 'front' ? facing : view === 'side' ? facing + 90 : facing + 45;
  const elev = (view === 'iso' ? 35 : 10) * RAD;
  const { fwd } = axes(from);
  const horiz = dist * Math.cos(elev);
  let pos: [number, number, number] = [cx + fwd[0] * horiz, cy + fwd[1] * horiz, cz + dist * Math.sin(elev)];
  if (pos[2] < floorZ) pos = [pos[0], pos[1], floorZ];
  const d = [cx - pos[0], cy - pos[1], cz - pos[2]];
  const len = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  const vectorDir: [number, number, number] = [d[0]! / len, d[1]! / len, d[2]! / len];
  // 위쪽 벡터는 보는 방향에 수직이고 +Z 쪽이다.
  const h = Math.hypot(vectorDir[0], vectorDir[1]) || 1;
  const s = -vectorDir[2];
  const vectorUp: [number, number, number] = [
    (vectorDir[0] / h) * s,
    (vectorDir[1] / h) * s,
    h,
  ];
  const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;
  return {
    view,
    pos: [round2(pos[0]), round2(pos[1]), round2(pos[2])],
    vectorDir: vectorDir.map(r6) as [number, number, number],
    vectorUp: vectorUp.map(r6) as [number, number, number],
    distance: dist,
  };
}
