// eden.ts: arma_eden_scene, arma_eden_look, arma_eden_place, arma_eden_edit 툴 등록.
//
// Eden 에디터에 붙은 브리지(애드온 fn_initEditor)로 엔티티를 읽고, 보고, 놓고, 고친다.
// Zeus 툴처럼 새 와이어 타입 없이 조립 SQF 를 exec 로 보낸다(src/eden/edenSqf.ts).
//
// 블렌더 MCP 들과 배치 연구(Holodeck, LayoutVLM, VULCAN)에서 가져온 원칙을 따른다.
//   - 화면보다 잰 값이 판정자다. 모든 결과에 지면 판정과 상자 겹침을 붙인다.
//   - LLM 이 좌표를 찍게 하기보다 관계(on, beside, face, alignWith)를 받아 여기서 좌표를 푼다.
//   - 고친 뒤 바로 다시 잰 값을 돌려준다. 따로 확인 호출을 하지 않아도 된다.
//   - 호출 한 번이 에디터 실행 취소 한 단계다(collect3DENHistory).
//   - 이름이 틀리면 후보를 돌려준다.
// 바뀐 내용은 사용자가 에디터에서 저장하기 전까지 미션 파일에 쓰이지 않는다.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { makeSessionExecContext } from '../execContext.js';
import { withAbortSignals } from '../abort.js';
import type { ExecRequestContext } from '../../exec/execManager.js';
import { execValue, nextKey, runPaged } from '../../zeus/zeusRuntime.js';
import type { SqfValue } from '../../zeus/sqfValue.js';
import {
  buildCameraRestoreSqf,
  buildCameraSqf,
  buildClassSqf,
  buildEditSqf,
  buildPlaceSqf,
  buildProjectSqf,
  buildSceneSqf,
  buildTerrainSqf,
  buildUndoSqf,
  SCENE_KINDS,
  type EditOp,
  type EdenMode,
  type PlaceItem,
} from '../../eden/edenSqf.js';
import {
  cameraFor,
  findOverlaps,
  frameOf,
  type EdenBox,
  type EdenKind,
  type ViewName,
} from '../../eden/edenGeom.js';
import {
  entityOut,
  judge,
  mapRow,
  MODE_OF,
  overlapsOut,
  refIds,
  solvePlacement,
  verdictNote,
  type EdenType,
  type Placement,
} from '../../eden/edenRuntime.js';
import { captureForTool, type CaptureBlock, type CaptureIo } from './capture.js';

const SERVER = { mode: 'server' as const };
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const DEFAULT_RADIUS = 50;
const MAX_ITEMS = 20;
const MAX_OPS = 30;
/** 판정 이웃을 찾는 반경 여유(m). 대상 상자 반지름에 더한다. */
const NEIGHBOR_EXTRA = 8;
const EXEC_TIMEOUT_MS = 15000;
const DEFAULT_LOOK_DELAY_MS = 400;
const LOOK_MAX_WIDTH = 1024;
/** 카메라가 지형 아래로 내려가지 않게 두는 여유(m). */
const CAMERA_FLOOR = 1.5;
const VIEWS: readonly ViewName[] = ['top', 'front', 'side', 'iso'];
const UNDO_HINT = '이 호출은 에디터 실행 취소 한 단계입니다. 되돌리려면 arma_eden_edit { undo: 1 } 이나 에디터의 Ctrl+Z.';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function joinNotes(notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '');
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/** 신호가 끊기면 즉시 깨어나는 대기. 끝까지 기다렸으면 true. */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 에디터 브리지가 아니면 이유. */
export function editorProblem(deps: Deps): string | null {
  if (!deps.gateway.isConnected()) return 'game not connected';
  const ed = deps.telemetry.current().editor;
  if (ed === true) return null;
  if (ed === false) return '지금 연결은 미션입니다. arma_eden_* 는 Eden 에디터에서만 씁니다.';
  return (
    '연결된 브리지가 에디터 표시(editor)를 보내지 않습니다. 에디터 브리지가 든 @arma_mcp 애드온을 실은 ' +
    'Eden 에디터여야 합니다. arma_status 의 mission.editor 를 보세요.'
  );
}

/** id 로 엔티티를 잰다. 없는 id 는 missing 에 남는다. */
async function boxesById(
  deps: Deps,
  ids: number[],
  ctx: ExecRequestContext,
): Promise<{ ok: true; boxes: Map<number, EdenBox>; missing: number[] } | { ok: false; error: string }> {
  const uniq = [...new Set(ids.map((n) => Math.trunc(n)))];
  const boxes = new Map<number, EdenBox>();
  if (uniq.length === 0) return { ok: true, boxes, missing: [] };
  const key = nextKey(deps.session.shortId, 'es');
  const res = await runPaged(
    deps,
    SERVER,
    buildSceneSqf({ ids: uniq, kinds: [], query: '', layer: '', near: null, radius: 1e9, selected: false, limit: uniq.length, key }),
    key,
    'eden-scene-ids',
    ctx,
    EXEC_TIMEOUT_MS,
  );
  if (!res.ok) return { ok: false, error: res.error ?? 'no result' };
  for (const r of res.rows) {
    const m = mapRow(r);
    if (m) boxes.set(m.box.id, m.box);
  }
  return { ok: true, boxes, missing: uniq.filter((id) => !boxes.has(id)) };
}

// ---------------------------------------------------------------- arma_eden_scene

export interface EdenSceneArgs {
  ids?: number[];
  kind?: EdenKind | EdenKind[];
  query?: string;
  layer?: string;
  near?: number[];
  radius?: number;
  selected?: boolean;
  limit?: number;
}

export async function runEdenScene(deps: Deps, args: EdenSceneArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const problem = editorProblem(deps);
  if (problem) return { ok: false, error: problem };
  const kinds = args.kind === undefined ? [] : Array.isArray(args.kind) ? args.kind : [args.kind];
  const bad = kinds.find((k) => !SCENE_KINDS.includes(k));
  if (bad) return { ok: false, error: `kind '${bad}' 는 쓸 수 없습니다(${SCENE_KINDS.join(', ')}).` };
  let near: [number, number] | null = null;
  if (args.near !== undefined) {
    const [x, y] = args.near;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'near 는 [x, y] 입니다.' };
    near = [x as number, y as number];
  }
  const radius = near ? clamp(args.radius ?? DEFAULT_RADIUS, 1, 20000) : 1e9;
  const limit = clamp(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  const ctx = makeSessionExecContext(deps, undefined, signal);
  const key = nextKey(deps.session.shortId, 'es');
  const res = await runPaged(
    deps,
    SERVER,
    buildSceneSqf({
      ids: (args.ids ?? []).filter((n) => Number.isFinite(n)),
      kinds,
      query: (args.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      layer: (args.layer ?? '').trim().slice(0, 80),
      near,
      radius,
      selected: args.selected === true,
      limit,
      key,
    }),
    key,
    'eden-scene',
    ctx,
    EXEC_TIMEOUT_MS,
  );
  if (!res.ok) return { ok: false, error: res.error };
  const boxes: EdenBox[] = [];
  const entities: Record<string, unknown>[] = [];
  for (const r of res.rows) {
    const m = mapRow(r);
    if (!m) continue;
    boxes.push(m.box);
    entities.push(entityOut(m.box, m.flags));
  }
  const matched = typeof res.meta[0] === 'number' ? res.meta[0] : entities.length;
  const selectedCount = typeof res.meta[1] === 'number' ? res.meta[1] : undefined;
  const overlaps = overlapsOut(findOverlaps(boxes));
  const snap = deps.telemetry.current();
  return {
    ok: true,
    world: snap.world,
    mission: snap.mission,
    matched,
    returned: entities.length,
    selectedCount,
    entities,
    overlaps: overlaps.length > 0 ? overlaps : undefined,
    note: joinNotes([
      matched > entities.length
        ? `${matched}개 중 ${entities.length}개만 돌려줬습니다. query, kind, near 로 좁히거나 limit 을 늘리세요.`
        : undefined,
      args.selected === true && matched === 0 ? '에디터에서 선택한 것이 없습니다.' : undefined,
      overlaps.length > 0 ? '돌려준 엔티티끼리의 상자 겹침만 봤습니다. 맵 건물과의 겹침은 arma_eden_place, edit 결과에 나옵니다.' : undefined,
    ]),
    exec: { count: res.execs, durationMs: res.durationMs },
  };
}

// ---------------------------------------------------------------- arma_eden_look

export interface EdenLookArgs {
  ids?: number[];
  at?: number[];
  radius?: number;
  views?: ViewName[];
  restore?: boolean;
  delayMs?: number;
  maxWidth?: number;
}

export async function runEdenLook(
  deps: Deps,
  args: EdenLookArgs,
  signal: AbortSignal,
  io: CaptureIo = {},
): Promise<{ images: CaptureBlock[]; meta: Record<string, unknown> }> {
  const fail = (error: string, extra: Record<string, unknown> = {}) => ({ images: [], meta: { ok: false, error, ...extra } });
  const problem = editorProblem(deps);
  if (problem) return fail(problem);
  if (deps.cfg.mcp.disableTools.includes('arma_capture')) return fail('arma_capture 가 disableTools 로 꺼져 있다');
  const views = (args.views && args.views.length > 0 ? args.views : (['iso', 'top'] as ViewName[])).filter((v) =>
    VIEWS.includes(v),
  );
  if (views.length === 0) return fail(`views 는 ${VIEWS.join(', ')} 중에서 고릅니다.`);
  const ctx = makeSessionExecContext(deps, undefined, signal);

  let targets: EdenBox[] = [];
  let center: [number, number, number];
  let radius: number;
  let facing = 180;
  if (args.ids && args.ids.length > 0) {
    const got = await boxesById(deps, args.ids, ctx);
    if (!got.ok) return fail(got.error);
    if (got.missing.length > 0) return fail(`id ${got.missing.join(', ')} 를 에디터에서 찾지 못했습니다.`);
    targets = [...got.boxes.values()];
    ({ center, radius } = frameOf(targets));
    if (targets.length === 1) facing = targets[0]!.dir;
  } else if (args.at && args.at.length >= 2 && args.at.every((n) => Number.isFinite(n))) {
    const tz = await execValue(deps, SERVER, buildTerrainSqf(args.at[0]!, args.at[1]!), 'eden-terrain', ctx, 5000);
    const ground = tz.value?.[0] === 'OK' ? Number(tz.value[1]) : 0;
    center = [args.at[0]!, args.at[1]!, args.at.length >= 3 ? args.at[2]! : ground + 1];
    radius = clamp(args.radius ?? 15, 1, 2000);
  } else {
    return fail('ids 나 at 을 주세요.');
  }

  const shots: Record<string, unknown>[] = [];
  const images: CaptureBlock[] = [];
  const restore = args.restore !== false;
  try {
    for (const view of views) {
      if (signal.aborted) break;
      let floorZ = -Infinity;
      if (view !== 'top') {
        const probe = cameraFor(view, center, radius, facing);
        const tz = await execValue(deps, SERVER, buildTerrainSqf(probe.pos[0], probe.pos[1]), 'eden-terrain', ctx, 5000);
        if (tz.value?.[0] === 'OK') floorZ = Number(tz.value[1]) + CAMERA_FLOOR;
      }
      const cam = cameraFor(view, center, radius, facing, 40, floorZ);
      const moved = await execValue(deps, SERVER, buildCameraSqf(cam.pos, cam.vectorDir, cam.vectorUp), 'eden-camera', ctx, 5000);
      if (moved.value?.[0] !== 'OK') {
        return fail(
          moved.value?.[0] === 'NOCAM' ? '에디터 카메라가 없습니다.' : `카메라를 옮기지 못했습니다: ${moved.error ?? String(moved.value?.[0])}`,
          { shots },
        );
      }
      const delayMs = clamp(args.delayMs ?? DEFAULT_LOOK_DELAY_MS, 0, 5000);
      if (!(await waitOrAbort(delayMs, signal))) break;
      let labels: Record<string, unknown>[] | undefined;
      if (targets.length > 0) {
        const pr = await execValue(
          deps,
          SERVER,
          buildProjectSqf(targets.map((t) => ({ id: t.id, pos: t.center }))),
          'eden-project',
          ctx,
          5000,
        );
        const list = pr.value?.[0] === 'OK' && Array.isArray(pr.value[1]) ? (pr.value[1] as SqfValue[]) : [];
        labels = list
          .filter((e): e is SqfValue[] => Array.isArray(e))
          .map((e) => (e[1] === '' ? { id: e[0], onScreen: false } : { id: e[0], x: Number(e[1]), y: Number(e[2]) }));
      }
      const shot = await captureForTool(
        deps,
        { delayMs: 0, maxWidth: args.maxWidth ?? LOOK_MAX_WIDTH },
        io,
      );
      const img = shot.content.filter((b) => b.type === 'image');
      images.push(...img);
      shots.push({
        view,
        image: img.length > 0 ? images.length : null,
        camera: { pos: cam.pos, distance: cam.distance },
        labels,
        ...(shot.meta.ok === false ? { captureError: shot.meta.error ?? shot.meta.stage } : {}),
      });
    }
  } finally {
    // 호출이 취소돼도 카메라는 되돌린다. 요청 신호가 끊긴 ctx 로는 exec 가 나가지 않으므로 세션 신호만 쓴다.
    if (restore) {
      await execValue(deps, SERVER, buildCameraRestoreSqf(), 'eden-camera-restore', makeSessionExecContext(deps), 5000);
    }
  }
  return {
    images,
    meta: {
      ok: images.length > 0,
      ...(images.length === 0 ? { error: '화면을 찍지 못했습니다(shots 의 captureError).' } : {}),
      frame: { center, radius },
      shots,
      note: joinNotes([
        'image 는 이 응답의 몇 번째 이미지인지다. labels 의 x, y 는 화면 폭과 높이에 대한 비율(왼쪽 위 0, 0)이고 엔티티 상자 중심이다.',
        '에디터 패널이 화면 가장자리를 가릴 수 있습니다. 판정은 이미지보다 arma_eden_scene 의 ground, overlaps 를 믿으세요.',
        restore ? '카메라는 원래 자리로 되돌렸습니다.' : '카메라를 마지막 시점에 두었습니다.',
      ]),
    },
  };
}

// ---------------------------------------------------------------- arma_eden_place

export interface EdenPlaceItemArgs extends Placement {
  class: string;
  type?: EdenType;
  name?: string;
}

export interface EdenPlaceArgs {
  items: EdenPlaceItemArgs[];
  select?: boolean;
  check?: boolean;
}

export async function runEdenPlace(deps: Deps, args: EdenPlaceArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const problem = editorProblem(deps);
  if (problem) return { ok: false, error: problem };
  const items = Array.isArray(args.items) ? args.items : [];
  if (items.length === 0) return { ok: false, error: 'items 가 필요합니다.' };
  if (items.length > MAX_ITEMS) return { ok: false, error: `한 번에 ${MAX_ITEMS}개까지 놓습니다. 나눠서 부르세요.` };
  for (const [i, it] of items.entries()) {
    if (typeof it.class !== 'string' || it.class.trim() === '') return { ok: false, error: `items[${i}].class 가 필요합니다.` };
    if (it.at === undefined && it.on === undefined && it.beside === undefined) {
      return { ok: false, error: `items[${i}] 에 at, on, beside 중 하나가 필요합니다.` };
    }
    if (it.by !== undefined || it.turn !== undefined) return { ok: false, error: `items[${i}]: by 와 turn 은 edit 에서만 씁니다.` };
  }
  const ctx = makeSessionExecContext(deps, undefined, signal);

  const refs = await boxesById(deps, items.flatMap((it) => refIds(it)), ctx);
  if (!refs.ok) return { ok: false, error: `참조 엔티티를 읽지 못했습니다: ${refs.error}` };
  if (refs.missing.length > 0) {
    return { ok: false, error: `id ${refs.missing.join(', ')} 를 에디터에서 찾지 못했습니다. arma_eden_scene 으로 다시 찾으세요.` };
  }

  const pairs = [...new Map(items.map((it) => {
    const mode = MODE_OF[it.type ?? 'object'];
    return [`${mode}|${it.class.trim()}`, [it.class.trim(), mode] as [string, EdenMode]];
  })).values()];
  const ckey = nextKey(deps.session.shortId, 'ec');
  const cls = await runPaged(deps, SERVER, buildClassSqf({ classes: pairs, key: ckey }), ckey, 'eden-class', ctx, EXEC_TIMEOUT_MS);
  if (!cls.ok) return { ok: false, error: `클래스를 확인하지 못했습니다: ${cls.error}` };
  const sizes = new Map<string, number[] | null>();
  const unknown: { class: string; candidates: string[] }[] = [];
  for (const r of cls.rows) {
    const [c, state, half, sug] = r;
    if (typeof c !== 'string') continue;
    if (state === 0) {
      unknown.push({ class: c, candidates: typeof sug === 'string' && sug !== '' ? sug.split('|') : [] });
    } else {
      const h = typeof half === 'string' && half !== '' ? half.split(',').map(Number) : null;
      sizes.set(c, h && h.length === 3 && h.every((n) => Number.isFinite(n)) ? h : null);
    }
  }
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `없는 클래스입니다: ${unknown.map((u) => u.class).join(', ')}. 아무것도 만들지 않았습니다.`,
      unknown,
      hint: 'candidates 에서 고르거나, 사용자가 말한 이름이면 arma_zeus_find { source:"palette" } 처럼 표시 이름으로 찾아 보세요.',
    };
  }

  const notes: (string | undefined)[] = [];
  const solved: PlaceItem[] = [];
  for (const [i, it] of items.entries()) {
    const c = it.class.trim();
    const half = sizes.get(c) ?? null;
    if (it.beside && !half) notes.push(`items[${i}] ${c} 의 크기를 재지 못해 1 m 상자로 보고 옆에 놓았습니다.`);
    const s = solvePlacement(it, refs.boxes, half ?? [0.5, 0.5, 0.5]);
    if (!s.ok) return { ok: false, error: `items[${i}]: ${s.error}` };
    if (!s.pos) return { ok: false, error: `items[${i}]: 위치를 풀지 못했습니다.` };
    solved.push({
      mode: MODE_OF[it.type ?? 'object'],
      class: c,
      pos: s.pos,
      dir: s.dir ?? 0,
      z: s.z,
      name: (it.name ?? '').trim().slice(0, 60),
    });
  }

  const key = nextKey(deps.session.shortId, 'ep');
  const res = await runPaged(
    deps,
    SERVER,
    buildPlaceSqf({
      items: solved,
      select: args.select !== false,
      neighborRadius: args.check === false ? 0 : NEIGHBOR_EXTRA,
      key,
    }),
    key,
    'eden-place',
    ctx,
    EXEC_TIMEOUT_MS,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      note: '결과를 받지 못했지만 에디터에는 만들어졌을 수 있습니다. arma_eden_scene { selected:true } 로 보세요.',
    };
  }
  const j = judge(res.rows);
  const badIdx = Array.isArray(res.meta[1]) ? (res.meta[1] as SqfValue[]).filter((n): n is number => typeof n === 'number') : [];
  return {
    ok: j.targets.length > 0,
    created: j.entities,
    failed: badIdx.length > 0 ? badIdx.map((i) => ({ index: i, class: solved[i]?.class })) : undefined,
    overlaps: j.overlaps.length > 0 ? j.overlaps : undefined,
    note: joinNotes([
      verdictNote(j.targets, j.overlaps),
      badIdx.length > 0 ? `create3DENEntity 가 ${badIdx.length}개를 만들지 못했습니다(failed).` : undefined,
      ...notes,
      j.targets.length > 0 ? UNDO_HINT : undefined,
    ]),
    exec: { count: res.execs + cls.execs, durationMs: res.durationMs + cls.durationMs },
  };
}

// ---------------------------------------------------------------- arma_eden_edit

export interface EdenEditOpArgs extends Placement {
  id: number;
  /** 바닥 높이(ASL). at 의 z 와 같다. */
  z?: number;
  name?: string;
  delete?: boolean;
}

export interface EdenEditArgs {
  ops?: EdenEditOpArgs[];
  undo?: number;
  check?: boolean;
}

export async function runEdenEdit(deps: Deps, args: EdenEditArgs, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const problem = editorProblem(deps);
  if (problem) return { ok: false, error: problem };
  const ops = Array.isArray(args.ops) ? args.ops : [];
  const ctx = makeSessionExecContext(deps, undefined, signal);

  if (args.undo !== undefined) {
    if (ops.length > 0) return { ok: false, error: 'undo 와 ops 는 함께 줄 수 없습니다.' };
    const r = await execValue(deps, SERVER, buildUndoSqf(args.undo), 'eden-undo', ctx, 5000);
    if (r.value?.[0] !== 'OK') return { ok: false, error: `실행 취소하지 못했습니다: ${r.error ?? String(r.value?.[0])}` };
    return { ok: true, undone: r.value[1], note: '에디터의 실행 취소를 눌렀습니다. 결과는 arma_eden_scene 으로 보세요.' };
  }
  if (ops.length === 0) return { ok: false, error: 'ops 나 undo 가 필요합니다.' };
  if (ops.length > MAX_OPS) return { ok: false, error: `한 번에 ${MAX_OPS}개까지 고칩니다. 나눠서 부르세요.` };
  for (const [i, o] of ops.entries()) {
    if (!Number.isFinite(o.id)) return { ok: false, error: `ops[${i}].id 가 필요합니다.` };
    if (o.z !== undefined && (o.at !== undefined || o.on !== undefined || o.beside !== undefined || o.by !== undefined)) {
      return { ok: false, error: `ops[${i}]: z 는 위치를 그대로 두고 높이만 바꿀 때 씁니다. at 이면 [x, y, z] 로 주세요.` };
    }
  }

  const got = await boxesById(deps, ops.flatMap((o) => [o.id, ...refIds(o)]), ctx);
  if (!got.ok) return { ok: false, error: `엔티티를 읽지 못했습니다: ${got.error}` };
  if (got.missing.length > 0) {
    return { ok: false, error: `id ${got.missing.join(', ')} 를 에디터에서 찾지 못했습니다. arma_eden_scene 으로 다시 찾으세요.` };
  }

  const solved: EditOp[] = [];
  for (const [i, o] of ops.entries()) {
    const self = got.boxes.get(Math.trunc(o.id))!;
    if (o.delete === true) {
      solved.push({ id: self.id, pos: null, dir: null, z: { kind: 'keep' }, name: null, delete: true });
      continue;
    }
    const s = solvePlacement(o, got.boxes, self.half, self);
    if (!s.ok) return { ok: false, error: `ops[${i}]: ${s.error}` };
    solved.push({
      id: self.id,
      pos: s.pos,
      dir: s.dir,
      z: o.z !== undefined ? { kind: 'asl', z: o.z } : s.z,
      name: o.name === undefined ? null : o.name.trim().slice(0, 60),
      delete: false,
    });
  }

  const key = nextKey(deps.session.shortId, 'ee');
  const res = await runPaged(
    deps,
    SERVER,
    buildEditSqf({ ops: solved, neighborRadius: args.check === false ? 0 : NEIGHBOR_EXTRA, key }),
    key,
    'eden-edit',
    ctx,
    EXEC_TIMEOUT_MS,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.error,
      note: '결과를 받지 못했지만 에디터에는 바뀌었을 수 있습니다. arma_eden_scene { ids } 로 보세요.',
    };
  }
  const j = judge(res.rows);
  const [, deleted, missing] = res.meta;
  const missingIds = Array.isArray(missing) ? missing.filter((n): n is number => typeof n === 'number') : [];
  return {
    ok: missingIds.length === 0,
    changed: j.entities,
    deleted: typeof deleted === 'number' && deleted > 0 ? deleted : undefined,
    missing: missingIds.length > 0 ? missingIds : undefined,
    overlaps: j.overlaps.length > 0 ? j.overlaps : undefined,
    note: joinNotes([verdictNote(j.targets, j.overlaps), UNDO_HINT]),
    exec: { count: res.execs, durationMs: res.durationMs },
  };
}

// ---------------------------------------------------------------- 등록

const ID = z.number().int().describe('arma_eden_scene 의 id(Eden 엔티티 id).');
const XY = z.array(z.number()).min(2).max(2);
const SIDE = z.enum(['front', 'back', 'left', 'right']);
const BESIDE = z
  .object({
    id: ID,
    side: SIDE.describe('ref 기준 쪽. front 는 ref 가 바라보는 쪽이다.'),
    gap: z.number().min(0).max(100).optional().describe('두 상자 사이 틈(m). 기본 0(맞닿음).'),
    offset: z.number().min(-100).max(100).optional().describe('ref 축을 따라 옆으로 미는 거리(m).'),
  })
  .describe('ref 의 그 쪽에 상자끼리 맞닿게(또는 gap 만큼 띄워) 놓는다. 크기는 게임에서 잰다.');

const PLACEMENT_FIELDS = {
  on: ID.optional().describe('이 엔티티 위에 올린다. 높이는 그 물체 윗면(아래로 쏜 선이 닿은 곳)이다.'),
  offset: z
    .array(z.number())
    .min(2)
    .max(2)
    .optional()
    .describe('on 일 때 ref 축 기준 [오른쪽, 앞] 이동(m).'),
  beside: BESIDE.optional(),
  dir: z.number().optional().describe('방위각(도). 북쪽 0, 시계 방향. 동쪽 90.'),
  face: z
    .union([ID, XY])
    .optional()
    .describe('이 엔티티 id 나 [x, y] 를 바라보게 돌린다.'),
  alignWith: ID.optional().describe('이 엔티티와 같은 방향으로 돌린다.'),
  ground: z
    .boolean()
    .optional()
    .describe('기본: 위치가 바뀌면 지면에 내린다. false 면 높이를 건드리지 않는다. true 면 위치가 그대로여도 내린다.'),
};

const AXES_NOTE =
  '좌표는 Arma 월드다: +X 동쪽, +Y 북쪽, 높이는 해수면 기준(ASL) m, 방위각은 북쪽에서 시계 방향. ' +
  '물체의 앞은 모델 +Y 다(차량의 앞, 건물의 정면).';

export function registerEdenTools(server: ToolHost, shared: Deps, io: CaptureIo = {}): void {
  server.registerTool(
    'arma_eden_scene',
    {
      title: 'Eden 에디터 장면 읽기',
      description:
        'Eden 에디터의 엔티티(유닛, 차량, 물체, 모듈, 트리거, 마커)를 한 줄씩 읽는다. 배치나 편집 전에 먼저 부른다. ' +
        '각 줄: id, kind, class, name, layer, at(상자 중심 [x, y]), dir, size([폭, 길이, 높이] m), ' +
        'z.bottom(바닥 ASL), z.attr(에디터에 보이는 높이), ground(ground, floating <틈>, sunk <깊이>), slope, tilt. ' +
        'overlaps 는 돌려준 엔티티끼리의 상자 겹침이다. ' +
        AXES_NOTE +
        ' 값을 추측하지 말고 여기서 잰 값을 쓴다. 게임을 바꾸지 않는다.',
      inputSchema: {
        stack: STACK_INPUT,
        ids: z.array(z.number().int()).optional().describe('이 id 들만.'),
        kind: z
          .union([z.enum(['unit', 'vehicle', 'object', 'logic', 'trigger', 'marker']), z.array(z.enum(['unit', 'vehicle', 'object', 'logic', 'trigger', 'marker']))])
          .optional()
          .describe('종류 하나나 배열.'),
        query: z.string().optional().describe('클래스, 변수 이름, 레이어, 표시 이름 조각(대소문자 무시).'),
        layer: z.string().optional().describe('이 레이어 이름만(대소문자 무시, 정확히 같은 이름).'),
        near: XY.optional().describe('[x, y]. radius 안의 것만 가까운 순으로.'),
        radius: z.number().min(1).max(20000).optional().describe(`near 반경(m). 기본 ${DEFAULT_RADIUS}.`),
        selected: z.boolean().optional().describe('에디터에서 지금 선택한 것만.'),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`최대 수. 기본 ${DEFAULT_LIMIT}.`),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) =>
        jsonContent(await runEdenScene(deps, args as EdenSceneArgs, signal)),
      ),
    ),
  );

  server.registerTool(
    'arma_eden_look',
    {
      title: 'Eden 에디터 화면 보기',
      description:
        '대상이 화면에 들어오게 에디터 카메라를 옮겨 찍는다. views 마다 이미지 한 장(top 위, front 대상의 앞, ' +
        'side 대상의 오른쪽, iso 앞 오른쪽 위 35도). labels 는 엔티티 id 가 이미지의 어디에 있는지(0~1 비율)다. ' +
        '배치 묶음이 끝날 때마다 한 번 보고, 겹침과 높이 판정은 이미지가 아니라 arma_eden_scene 의 값으로 한다. ' +
        '카메라는 기본으로 원래 자리로 되돌린다. 에디터 엔티티는 바꾸지 않는다.',
      inputSchema: {
        stack: STACK_INPUT,
        ids: z.array(z.number().int()).optional().describe('화면에 담을 엔티티 id 들.'),
        at: z.array(z.number()).min(2).max(3).optional().describe('ids 대신 볼 점 [x, y(, z ASL)].'),
        radius: z.number().min(1).max(2000).optional().describe('at 일 때 담을 반경(m). 기본 15.'),
        views: z.array(z.enum(['top', 'front', 'side', 'iso'])).min(1).max(4).optional().describe("기본 ['iso','top']."),
        restore: z.boolean().optional().describe('끝나고 카메라를 원래 자리로 되돌린다. 기본 true.'),
        delayMs: z.number().int().min(0).max(5000).optional().describe(`카메라를 옮기고 찍기 전 대기(ms). 기본 ${DEFAULT_LOOK_DELAY_MS}.`),
        maxWidth: z.number().int().min(320).max(3840).optional().describe(`이미지 폭 상한. 기본 ${LOOK_MAX_WIDTH}.`),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) => {
        const r = await runEdenLook(deps, args as EdenLookArgs, signal, io);
        return { content: [...r.images, ...jsonContent(r.meta).content] };
      }),
    ),
  );

  server.registerTool(
    'arma_eden_place',
    {
      title: 'Eden 에디터에 놓기',
      description:
        '에디터에 엔티티를 만든다. 사용자가 배치를 요청했을 때만 쓴다. 항목마다 at([x, y] 지면, [x, y, z] 바닥 ASL), ' +
        'on(그 엔티티 위), beside(그 엔티티 옆에 맞닿게) 중 하나와, dir, face, alignWith 중 하나를 준다. ' +
        '좌표를 눈대중으로 찍기보다 on, beside, face 로 관계를 주면 크기를 재서 겹치지 않게 푼다. ' +
        '결과 created 는 만든 뒤 다시 잰 줄(arma_eden_scene 과 같은 모양)이고 overlaps 는 맵 건물, 나무, 다른 엔티티와의 상자 겹침이다. ' +
        '판정이 나쁘면 arma_eden_edit 로 고친다. 클래스가 틀리면 아무것도 만들지 않고 후보를 돌려준다. ' +
        '호출 한 번이 실행 취소 한 단계이고, 저장은 사용자가 한다. ' +
        AXES_NOTE,
      inputSchema: {
        stack: STACK_INPUT,
        items: z
          .array(
            z.object({
              class: z.string().min(1).describe('CfgVehicles 클래스(마커는 CfgMarkers). 예: Land_CncBarrier_F, B_MRAP_01_F.'),
              type: z
                .enum(['object', 'logic', 'trigger', 'marker'])
                .optional()
                .describe("기본 'object'(물체, 차량, 유닛). logic 은 모듈, trigger 는 EmptyDetector, marker 는 마커."),
              at: z.array(z.number()).min(2).max(3).optional().describe('[x, y] 지면 또는 [x, y, z] 바닥 ASL.'),
              ...PLACEMENT_FIELDS,
              name: z.string().optional().describe('변수 이름.'),
            }),
          )
          .min(1)
          .max(MAX_ITEMS),
        select: z.boolean().optional().describe('만든 것을 에디터에서 선택해 사용자에게 보여 준다. 기본 true.'),
        check: z.boolean().optional().describe('둘레의 맵 물체와 엔티티로 겹침을 본다. 기본 true.'),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) =>
        jsonContent(await runEdenPlace(deps, args as EdenPlaceArgs, signal)),
      ),
    ),
  );

  server.registerTool(
    'arma_eden_edit',
    {
      title: 'Eden 에디터 엔티티 고치기',
      description:
        '에디터 엔티티를 옮기고(at, by, on, beside), 돌리고(dir, turn, face, alignWith), 높이를 맞추고(ground, z), ' +
        '이름을 바꾸고(name), 지운다(delete). 사용자가 요청했을 때만 쓴다. undo 는 에디터 실행 취소를 그만큼 누른다. ' +
        '결과 changed 는 고친 뒤 다시 잰 줄이고 overlaps 는 둘레와의 상자 겹침이다. 호출 한 번이 실행 취소 한 단계다. ' +
        AXES_NOTE,
      inputSchema: {
        stack: STACK_INPUT,
        ops: z
          .array(
            z.object({
              id: ID,
              at: z.array(z.number()).min(2).max(3).optional().describe('새 위치 [x, y] 지면 또는 [x, y, z] 바닥 ASL.'),
              by: z.array(z.number()).min(2).max(3).optional().describe('지금 자리에서 [dx, dy(, dz)] m 만큼(월드 축).'),
              ...PLACEMENT_FIELDS,
              turn: z.number().optional().describe('지금 방향에 더할 각(도). 양수는 시계 방향.'),
              z: z.number().optional().describe('위치는 그대로 두고 바닥을 이 높이(ASL)에.'),
              name: z.string().optional().describe('새 변수 이름. 빈 문자열이면 지운다.'),
              delete: z.boolean().optional().describe('true 면 지운다.'),
            }),
          )
          .max(MAX_OPS)
          .optional(),
        undo: z.number().int().min(1).max(50).optional().describe('에디터 실행 취소 횟수. ops 와 함께 주지 않는다.'),
        check: z.boolean().optional().describe('둘레의 맵 물체와 엔티티로 겹침을 본다. 기본 true.'),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) =>
        jsonContent(await runEdenEdit(deps, args as EdenEditArgs, signal)),
      ),
    ),
  );
}
