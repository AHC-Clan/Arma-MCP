// edenRuntime.ts: arma_eden_* 툴의 행 해석, 응답 모양, 관계 풀기.
//
// 게임이 보낸 행(edenSqf.ts 의 ROW)을 EdenBox 로 되읽고, LLM 에게 줄 한 엔티티 요약과
// 판정(지면, 겹침)을 만든다. 배치 관계(위에, 옆에, 바라보게)는 여기서 좌표로 푼다.

import type { SqfValue } from '../zeus/sqfValue.js';
import {
  besidePos,
  bearing,
  findOverlaps,
  groundVerdict,
  localToWorld,
  type EdenBox,
  type EdenKind,
  type OverlapPair,
  type Side,
} from './edenGeom.js';
import { GEOM, RF, type EdenMode, type ZRule } from './edenSqf.js';

const KINDS: readonly string[] = ['unit', 'vehicle', 'object', 'logic', 'trigger', 'marker', 'map'];

export interface RowFlags {
  selected: boolean;
  target: boolean;
}

/** 행 하나를 EdenBox 로. 모양이 다르면 null. */
export function mapRow(r: SqfValue[]): { box: EdenBox; flags: RowFlags } | null {
  const [id, kind, cls, name, layer, geom, flags] = r;
  if (typeof id !== 'number' || typeof kind !== 'string' || !KINDS.includes(kind) || typeof geom !== 'string') {
    return null;
  }
  const g = geom.split(',').map((s) => Number(s));
  if (g.length !== GEOM.length || g.some((n) => !Number.isFinite(n))) return null;
  const f = typeof flags === 'number' ? flags : 0;
  const [cx, cy, cz, dir, hx, hy, hz, bottom, gapMin, gapMax, tilt, attrZ] = g as number[];
  return {
    box: {
      id,
      kind: kind as EdenKind,
      class: typeof cls === 'string' ? cls : '',
      name: typeof name === 'string' ? name : '',
      layer: typeof layer === 'string' ? layer : '',
      center: [cx!, cy!, cz!],
      dir: dir!,
      half: [hx!, hy!, hz!],
      bottom: bottom!,
      gapMin: gapMin!,
      gapMax: gapMax!,
      tilt: tilt!,
      attrZ: attrZ!,
      water: (f & RF.water) !== 0,
      hasBox: (f & RF.box) !== 0,
    },
    flags: { selected: (f & RF.selected) !== 0, target: (f & RF.target) !== 0 },
  };
}

/** 경사로 모서리 틈이 이만큼 벌어지면 slope 를 붙인다. */
const SLOPE_SPREAD = 0.3;
/** 이만큼 기울면 tilt 를 붙인다(도). */
const TILT_SHOW = 1;

/**
 * LLM 에게 주는 엔티티 한 줄. at 은 상자 중심 [x, y], z.bottom 은 바닥 높이(ASL), z.attr 는 에디터에 보이는 높이,
 * size 는 [폭(오른쪽), 길이(앞), 높이] m, ground 는 판정이다.
 */
export function entityOut(b: EdenBox, flags?: Partial<RowFlags>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: b.id, kind: b.kind, class: b.class };
  if (b.name) out.name = b.name;
  if (b.layer) out.layer = b.layer;
  out.at = [b.center[0], b.center[1]];
  out.dir = b.dir;
  if (b.hasBox) {
    out.size = b.half.map((h) => Math.round(h * 200) / 100);
    out.z = { bottom: b.bottom, attr: b.attrZ };
    const v = groundVerdict(b);
    out.ground = v.state === 'ground' ? 'ground' : `${v.state} ${v.gap}`;
    if (v.spread >= SLOPE_SPREAD) out.slope = v.spread;
    if (b.tilt >= TILT_SHOW) out.tilt = b.tilt;
  } else {
    out.z = { attr: b.attrZ };
  }
  if (b.water) out.water = true;
  if (flags?.selected) out.selected = true;
  return out;
}

export interface OverlapOut {
  a: number;
  b: number | string;
  depth: number;
}

/** 겹침 쌍을 응답 모양으로. 맵 물체는 id 대신 "map:<클래스>" 다. */
export function overlapsOut(pairs: readonly OverlapPair[]): OverlapOut[] {
  return pairs.map((p) => ({ a: p.a, b: p.bClass !== undefined ? `map:${p.bClass}` : p.b, depth: p.depth }));
}

/** 판정 요약 문장. 문제가 없으면 undefined. */
export function verdictNote(targets: readonly EdenBox[], overlaps: readonly OverlapOut[]): string | undefined {
  const floating = targets.filter((t) => t.hasBox && groundVerdict(t).state === 'floating').map((t) => t.id);
  const sunk = targets.filter((t) => t.hasBox && groundVerdict(t).state === 'sunk').map((t) => t.id);
  const parts: string[] = [];
  if (floating.length > 0) parts.push(`떠 있음: ${floating.join(', ')}`);
  if (sunk.length > 0) parts.push(`묻힘(경사면의 건물이면 흔하다): ${sunk.join(', ')}`);
  if (overlaps.length > 0) parts.push(`상자 겹침 ${overlaps.length}쌍(overlaps). 나무와 덤불은 지나갈 수 있지만 건물과 차량은 옮기세요`);
  return parts.length > 0 ? parts.join('. ') + '.' : undefined;
}

/** 한 결과의 대상 행과 이웃 행을 나누고 판정을 붙인다. */
export function judge(rows: readonly SqfValue[][]): {
  targets: EdenBox[];
  neighbors: EdenBox[];
  entities: Record<string, unknown>[];
  overlaps: OverlapOut[];
  bad: number;
} {
  const targets: EdenBox[] = [];
  const neighbors: EdenBox[] = [];
  const entities: Record<string, unknown>[] = [];
  let bad = 0;
  for (const r of rows) {
    const m = mapRow(r);
    if (!m) {
      bad += 1;
      continue;
    }
    if (m.flags.target) {
      targets.push(m.box);
      entities.push(entityOut(m.box, m.flags));
    } else {
      neighbors.push(m.box);
    }
  }
  return { targets, neighbors, entities, overlaps: overlapsOut(findOverlaps(targets, neighbors)), bad };
}

// ---------------------------------------------------------------- 관계 풀기

export type EdenType = 'object' | 'logic' | 'trigger' | 'marker';

export const MODE_OF: Record<EdenType, EdenMode> = {
  object: 'Object',
  logic: 'Logic',
  trigger: 'Trigger',
  marker: 'Marker',
};

export interface BesideSpec {
  id: number;
  side: Side;
  /** 두 상자 사이 틈(m). 기본 0. */
  gap?: number;
  /** ref 축 기준 옆 이동(m). */
  offset?: number;
}

/** place 의 항목 하나와 edit 의 옮기기 부분이 같이 쓰는 위치, 방향 지정. */
export interface Placement {
  at?: number[];
  by?: number[];
  on?: number;
  /** on 일 때 ref 축 기준 [오른쪽, 앞] 이동(m). */
  offset?: number[];
  beside?: BesideSpec;
  dir?: number;
  /** 지금 방향에 더할 각(도). edit 전용. */
  turn?: number;
  face?: number | number[];
  alignWith?: number;
  /** false 면 높이를 건드리지 않는다. */
  ground?: boolean;
}

/** placement 가 기대는 ref id 들. */
export function refIds(p: Placement): number[] {
  const ids: number[] = [];
  if (typeof p.on === 'number') ids.push(p.on);
  if (p.beside) ids.push(p.beside.id);
  if (typeof p.face === 'number') ids.push(p.face);
  if (typeof p.alignWith === 'number') ids.push(p.alignWith);
  return ids;
}

export type Solved =
  | { ok: true; pos: [number, number] | null; dir: number | null; z: ZRule; how: string }
  | { ok: false; error: string };

function norm360(d: number): number {
  const r = d % 360;
  return Math.round((r < 0 ? r + 360 : r) * 100) / 100;
}

/**
 * 위치와 방향을 푼다. self 는 edit 에서 지금 엔티티, half 는 만들 물체의 반길이(place) 또는 지금 상자(edit)다.
 * 위치 지정이 없으면 pos 는 null(그대로)이다. 높이: at 의 z 는 바닥 ASL, on 은 ref 윗면,
 * 위치가 바뀌면 지면, ground:true 는 위치가 그대로여도 지면에 내린다, ground:false 는 그대로 둔다.
 */
export function solvePlacement(
  p: Placement,
  refs: ReadonlyMap<number, EdenBox>,
  half: readonly number[],
  self?: EdenBox,
): Solved {
  const ref = (id: number, what: string): EdenBox | string => {
    const b = refs.get(id);
    if (!b) return `${what} 의 id ${id} 를 에디터에서 찾지 못했습니다.`;
    return b;
  };
  const where = [p.at !== undefined, p.by !== undefined, p.on !== undefined, p.beside !== undefined].filter(Boolean).length;
  if (where > 1) return { ok: false, error: 'at, by, on, beside 중 하나만 주세요.' };
  const turning = [p.dir !== undefined, p.turn !== undefined, p.face !== undefined, p.alignWith !== undefined].filter(Boolean).length;
  if (turning > 1) return { ok: false, error: 'dir, turn, face, alignWith 중 하나만 주세요.' };

  let dir: number | null = null;
  if (p.dir !== undefined) dir = norm360(p.dir);
  if (p.turn !== undefined) {
    if (!self) return { ok: false, error: 'turn 은 edit 에서만 씁니다.' };
    dir = norm360(self.dir + p.turn);
  }
  if (p.alignWith !== undefined) {
    const r = ref(p.alignWith, 'alignWith');
    if (typeof r === 'string') return { ok: false, error: r };
    dir = norm360(r.dir);
  }
  if (p.beside && dir === null && p.face === undefined && !self) {
    const r = refs.get(p.beside.id);
    if (r) dir = norm360(r.dir);
  }

  // face 는 위치가 정해진 뒤에 푼다. 옆에 둘 때는 상자 투영에 방향이 필요하므로 ref 방향으로 한 번 놓고 다시 푼다.
  const faceTarget = (): number[] | string | null => {
    if (p.face === undefined) return null;
    if (typeof p.face === 'number') {
      const r = ref(p.face, 'face');
      return typeof r === 'string' ? r : [r.center[0], r.center[1]];
    }
    if (p.face.length < 2 || !p.face.every((n) => Number.isFinite(n))) return 'face 는 id 나 [x, y] 입니다.';
    return p.face;
  };
  const ft = faceTarget();
  if (typeof ft === 'string') return { ok: false, error: ft };

  let pos: [number, number] | null = null;
  let z: ZRule = { kind: 'keep' };
  let how = 'keep';
  const useDir = (): number => dir ?? self?.dir ?? 0;

  if (p.at !== undefined) {
    if (p.at.length < 2 || !p.at.every((n) => Number.isFinite(n))) return { ok: false, error: 'at 은 [x, y] 나 [x, y, z] 입니다.' };
    pos = [p.at[0]!, p.at[1]!];
    z = p.at.length >= 3 ? { kind: 'asl', z: p.at[2]! } : { kind: 'ground' };
    how = 'at';
  } else if (p.by !== undefined) {
    if (!self) return { ok: false, error: 'by 는 edit 에서만 씁니다.' };
    if (p.by.length < 2 || !p.by.every((n) => Number.isFinite(n))) return { ok: false, error: 'by 는 [dx, dy] 나 [dx, dy, dz] 입니다.' };
    pos = [Math.round((self.center[0] + p.by[0]!) * 100) / 100, Math.round((self.center[1] + p.by[1]!) * 100) / 100];
    z = p.by.length >= 3 && self.hasBox ? { kind: 'asl', z: self.bottom + p.by[2]! } : { kind: 'ground' };
    how = 'by';
  } else if (p.on !== undefined) {
    const r = ref(p.on, 'on');
    if (typeof r === 'string') return { ok: false, error: r };
    if (!r.hasBox) return { ok: false, error: `on 의 id ${p.on} 는 상자가 없는 ${r.kind} 입니다.` };
    pos = p.offset ? localToWorld(r, p.offset) : [r.center[0], r.center[1]];
    z = { kind: 'on', ref: r.id };
    how = 'on';
  } else if (p.beside !== undefined) {
    const r = ref(p.beside.id, 'beside');
    if (typeof r === 'string') return { ok: false, error: r };
    let d = useDir();
    pos = besidePos(r, p.beside.side, half, d, p.beside.gap ?? 0, p.beside.offset ?? 0);
    if (ft) {
      d = bearing(pos, ft);
      dir = d;
      pos = besidePos(r, p.beside.side, half, d, p.beside.gap ?? 0, p.beside.offset ?? 0);
    }
    z = { kind: 'ground' };
    how = `beside ${p.beside.side}`;
  }

  if (ft) {
    const from = pos ?? (self ? [self.center[0], self.center[1]] : null);
    if (!from) return { ok: false, error: 'face 를 풀 위치가 없습니다.' };
    dir = bearing(from, ft);
  }

  if (p.ground === false) z = { kind: 'keep' };
  else if (p.ground === true && z.kind === 'keep') z = { kind: 'ground' };

  return { ok: true, pos, dir, z, how };
}
