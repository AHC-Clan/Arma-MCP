// zeus.ts: arma_zeus_find, arma_zeus_module 툴 등록.
//
// 사용자는 대상을 Zeus 화면에 보이는 이름으로 말한다("알파 1-2", "소총수", "주변 10m 완전 치료").
// arma_zeus_find 가 그 이름을 netId 와 arma_exec 에 붙여 쓸 식으로 바꾸고,
// arma_zeus_module 이 모듈을 Zeus 배치와 같은 경로로 실행한다.
// 둘 다 새 와이어 타입 없이 조립 SQF 를 exec 로 보낸다(src/zeus/zeusSqf.ts).

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { makeSessionExecContext } from '../execContext.js';
import { withAbortSignals } from '../abort.js';
import {
  buildCuratorAddSqf,
  buildFindSqf,
  buildModuleObserveSqf,
  buildModuleRunSqf,
  buildPaletteSqf,
  PF,
  type MissionKind,
  type PaletteKind,
} from '../../zeus/zeusSqf.js';
import {
  execValue,
  mapMeta,
  mapMissionRow,
  mapPaletteRow,
  nextKey,
  pickZeusMachine,
  runPaged,
  type ZeusMachine,
} from '../../zeus/zeusRuntime.js';
import type { SqfValue } from '../../zeus/sqfValue.js';

const MISSION_KINDS: readonly MissionKind[] = ['unit', 'group', 'vehicle', 'module', 'object', 'marker'];
const PALETTE_KINDS: readonly PaletteKind[] = ['unit', 'vehicle', 'object', 'module', 'groupTemplate'];
const ALL_KINDS = ['unit', 'group', 'vehicle', 'module', 'object', 'marker', 'groupTemplate'] as const;
const SIDES = ['WEST', 'EAST', 'GUER', 'CIV'] as const;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** 첫 palette 호출은 색인을 만드느라 오래 걸릴 수 있다. client 모드는 왕복이 둘 더 있다. */
const FIND_TIMEOUT_MS = 15000;
const DEFAULT_OBSERVE_MS = 1500;
const MAX_OBSERVE_MS = 10000;
const QUERY_MAX = 80;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function joinNotes(notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '');
  return kept.length > 0 ? kept.join(' ') : undefined;
}

function machineLabel(m: ZeusMachine, reported: string | undefined): string {
  return reported ?? (m.mode === 'server' ? 'server' : (m.target ?? '?'));
}

/** 신호가 끊기면 즉시 깨어나는 대기. */
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

// ---------------------------------------------------------------- arma_zeus_find

export interface ZeusFindArgs {
  source?: 'mission' | 'selected' | 'palette';
  query?: string;
  kind?: (typeof ALL_KINDS)[number] | (typeof ALL_KINDS)[number][];
  side?: (typeof SIDES)[number];
  zeusOnly?: boolean;
  near?: number[] | 'camera';
  limit?: number;
  on?: string;
}

export async function runZeusFind(
  deps: Deps,
  args: ZeusFindArgs,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const source = args.source ?? 'mission';
  const query = (args.query ?? '').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX);
  const kinds = args.kind === undefined ? [] : Array.isArray(args.kind) ? args.kind : [args.kind];
  const allowed: readonly string[] = source === 'palette' ? PALETTE_KINDS : MISSION_KINDS;
  const badKind = kinds.find((k) => !allowed.includes(k));
  if (badKind) {
    return { ok: false, error: `kind '${badKind}' 는 source '${source}' 에서 쓸 수 없습니다(${allowed.join(', ')}).` };
  }
  let near: [number, number] | 'camera' | null = null;
  if (args.near === 'camera') near = 'camera';
  else if (Array.isArray(args.near)) {
    const [x, y] = args.near;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'near must be [x,y] or "camera"' };
    near = [x as number, y as number];
  }
  const limit = clamp(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1, MAX_LIMIT);
  if (!deps.gateway.isConnected()) return { ok: false, error: 'game not connected' };

  const ctx = makeSessionExecContext(deps, undefined, signal);
  const picked = await pickZeusMachine(
    deps,
    args.on,
    source === 'selected' ? 'selected' : 'labels',
    ctx,
  );
  if (!picked.ok) return { ...picked, source };
  const machine = picked.machine;

  const key = nextKey(deps.session.shortId, 'zf');
  const code =
    source === 'palette'
      ? buildPaletteSqf({ query, kinds: kinds as PaletteKind[], side: args.side ?? '', limit, key })
      : buildFindSqf({
          source,
          query,
          kinds: kinds as MissionKind[],
          side: args.side ?? '',
          zeusOnly: args.zeusOnly === true,
          near,
          limit,
          key,
        });

  const res = await runPaged(deps, machine, code, key, `zeus-${source}`, ctx, FIND_TIMEOUT_MS);
  const where = machineLabel(machine, res.machine);
  if (!res.ok) {
    return {
      ok: false,
      source,
      machine: where,
      error: res.error,
      hint:
        machine.mode === 'client'
          ? `${machine.target} 의 클라이언트가 답하지 않으면 그 클라이언트에 @arma_mcp 가 있는지 보거나 on:'server' 로 다시 부르세요.`
          : undefined,
    };
  }

  const meta = mapMeta(res.meta);
  const results = res.rows.map((r: SqfValue[]) =>
    source === 'palette' ? mapPaletteRow(r) : mapMissionRow(r),
  );
  const notes = [
    picked.note,
    source === 'selected' && meta.zeusOpen === false
      ? 'Zeus 화면이 닫혀 있습니다. 선택은 Zeus 화면이 열려 있을 때만 의미가 있습니다.'
      : undefined,
    source === 'selected' && results.length === 0 ? 'Zeus 에서 선택한 것이 없습니다.' : undefined,
    near === 'camera' && !machine.isZeus ? 'Zeus 카메라가 없는 머신이라 거리 정렬을 하지 않았습니다.' : undefined,
    res.total > results.length
      ? `${res.total}개 중 ${results.length}개만 돌려줬습니다. query 를 좁히거나 limit 을 늘리세요.`
      : undefined,
  ];
  return {
    ok: true,
    source,
    machine: where,
    ...meta,
    total: res.total,
    returned: results.length,
    results,
    note: joinNotes(notes),
    exec: { count: res.execs, durationMs: res.durationMs },
  };
}

// ---------------------------------------------------------------- arma_zeus_module

export interface ZeusModuleArgs {
  module: string;
  pos?: number[];
  target?: string;
  on?: string;
  dryRun?: boolean;
  observeMs?: number;
}

const OUTCOME_NOTES: Record<string, string> = {
  consumed: '모듈 함수가 돌고 로직이 스스로 지워졌습니다.',
  persistent: '로직이 맵에 남아 있습니다. 지속형 모듈이거나 아직 함수가 끝나지 않았습니다.',
  dialog: '그 플레이어 화면에 창이 떴습니다. 입력은 그 사람이 합니다.',
};

export async function runZeusModule(
  deps: Deps,
  args: ZeusModuleArgs,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const module = (args.module ?? '').replace(/\s+/g, ' ').trim().slice(0, QUERY_MAX);
  if (module === '') return { ok: false, error: 'module 이 필요합니다(클래스명 또는 Zeus 에 보이는 모듈 이름).' };
  let pos: [number, number] | null = null;
  if (Array.isArray(args.pos)) {
    const [x, y] = args.pos;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: 'pos must be [x,y]' };
    pos = [x as number, y as number];
  }
  const target = (args.target ?? '').trim();
  const observeMs = clamp(Math.trunc(args.observeMs ?? DEFAULT_OBSERVE_MS), 0, MAX_OBSERVE_MS);
  if (!deps.gateway.isConnected()) return { ok: false, error: 'game not connected' };

  const ctx = makeSessionExecContext(deps, undefined, signal);
  const picked = await pickZeusMachine(deps, args.on, 'module', ctx);
  if (!picked.ok) return { ...picked };
  const machine = picked.machine;

  const key = nextKey(deps.session.shortId, 'zm');
  const run = await execValue(
    deps,
    machine,
    buildModuleRunSqf({ module, target, pos, dryRun: args.dryRun === true, key }),
    args.dryRun ? 'zeus-module-dry' : 'zeus-module',
    ctx,
    FIND_TIMEOUT_MS,
  );
  const where = machineLabel(machine, run.machine);
  if (!run.value) {
    return {
      ok: false,
      machine: where,
      error: run.error,
      rptErrors: run.outcome.rptErrors.length > 0 ? run.outcome.rptErrors : undefined,
    };
  }

  const v = run.value;
  const tag = v[0];
  if (tag === 'NONE') {
    return {
      ok: false,
      machine: where,
      error: `'${module}' 에 맞는 Zeus 모듈이 없습니다.`,
      hint: "arma_zeus_find { source:'palette', kind:'module', query } 로 이름을 찾아 보세요.",
    };
  }
  if (tag === 'AMBIG') {
    const cands = Array.isArray(v[2]) ? v[2] : [];
    return {
      ok: false,
      machine: where,
      error: `'${module}' 이 모듈 ${String(v[1])}개에 걸립니다. 만들지 않았습니다.`,
      candidates: cands
        .filter((c): c is SqfValue[] => Array.isArray(c))
        .map((c) => ({ class: c[0], label: c[1] })),
      hint: 'module 에 클래스명을 주거나 사용자에게 어느 것인지 물으세요.',
    };
  }
  if (tag === 'NOTARGET') {
    return { ok: false, machine: where, error: `target '${target}' 를 찾지 못했습니다. arma_zeus_find 로 다시 찾으세요.` };
  }
  if (tag === 'NOPOS') {
    return { ok: false, machine: where, error: '위치를 정하지 못했습니다. pos 나 target 을 주세요.' };
  }
  if (tag === 'FAIL') {
    return { ok: false, machine: where, error: `모듈을 만들지 못했습니다(${String(v[1])}).` };
  }
  if (tag !== 'OK' && tag !== 'DRY') {
    return { ok: false, machine: where, error: `unexpected result: ${JSON.stringify(v).slice(0, 200)}` };
  }

  const flags = typeof v[6] === 'number' ? v[6] : 0;
  const posOut = Array.isArray(v[5]) ? v[5] : null;
  const moduleInfo = {
    class: v[1],
    label: v[2],
    category: v[3],
    canAttach: (flags & PF.canAttach) !== 0,
    attributeDialog: (flags & PF.attributeDialog) !== 0,
    opensDialog: (flags & PF.opensDialog) !== 0,
  };
  const targetKind = typeof v[7] === 'string' && v[7] !== '' ? v[7] : undefined;
  const attrNote = moduleInfo.attributeDialog
    ? 'Zeus 에서 놓을 때 뜨는 속성 창은 띄우지 않았습니다. 모듈은 기본값으로 동작합니다.'
    : undefined;
  const attachNote =
    target !== '' && !moduleInfo.canAttach
      ? '부착형 모듈이 아니라 target 은 위치와 커서 대상으로만 썼습니다.'
      : undefined;

  if (tag === 'DRY') {
    return {
      ok: true,
      dryRun: true,
      machine: where,
      module: moduleInfo,
      pos: posOut,
      target: target || undefined,
      targetKind,
      note: joinNotes([picked.note, attrNote, attachNote]),
    };
  }

  const logicRef = typeof v[4] === 'string' ? v[4] : '';
  const waited = observeMs > 0 ? await waitOrAbort(observeMs, signal) : true;
  if (!waited) {
    return { ok: false, machine: where, module: moduleInfo, logicRef, error: 'client session closed' };
  }
  const obs = await execValue(deps, machine, buildModuleObserveSqf(key), 'zeus-module-observe', ctx, 8000);
  const o = obs.value;
  if (!o || o[0] !== 'OK') {
    return {
      ok: true,
      outcome: 'unknown',
      machine: where,
      module: moduleInfo,
      pos: posOut,
      logicRef,
      note: joinNotes([`모듈은 만들었지만 결과를 보지 못했습니다(${obs.error ?? String(o?.[0])}).`, picked.note]),
    };
  }
  const [, logicAlive, dialogNow, newDisplays, dialogBefore, zeusOpen, liveRef] = o;
  const opened = (typeof newDisplays === 'number' && newDisplays > 0) || (dialogNow === true && dialogBefore !== true);
  const outcome = opened ? 'dialog' : logicAlive === true ? 'persistent' : 'consumed';

  let curatorAdded: number | undefined;
  if (logicAlive === true && typeof liveRef === 'string' && liveRef !== '') {
    const add = await execValue(
      deps,
      { mode: 'server' },
      buildCuratorAddSqf(liveRef, machine.player ?? ''),
      'zeus-module-curator',
      ctx,
      5000,
    );
    if (add.value?.[0] === 'OK' && typeof add.value[1] === 'number') curatorAdded = add.value[1];
  }

  return {
    ok: true,
    outcome,
    machine: where,
    module: moduleInfo,
    pos: posOut,
    target: target || undefined,
    targetKind,
    logicRef: logicAlive === true ? liveRef : undefined,
    dialogOpened: opened,
    zeusOpen,
    curatorAdded,
    note: joinNotes([
      OUTCOME_NOTES[outcome],
      picked.note,
      attrNote,
      attachNote,
      zeusOpen === false ? 'Zeus 화면이 닫혀 있어 Zeus 피드백 메시지는 보이지 않았을 수 있습니다.' : undefined,
    ]),
    rptErrors: run.outcome.rptErrors.length > 0 ? run.outcome.rptErrors : undefined,
  };
}

// ---------------------------------------------------------------- 등록

const ON_INPUT = z
  .string()
  .optional()
  .describe(
    "이름을 계산하고 실행할 머신. 'auto'(기본)는 Zeus 를 쓰는 플레이어의 머신(SP 는 그 한 대), " +
      "'server' 는 서버, 그 밖의 값은 그 플레이어 이름이다. 종류명과 모듈 이름은 그 머신의 게임 언어로 나온다.",
  );

export function registerZeusTools(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_zeus_find',
    {
      title: 'Zeus 이름으로 대상 찾기',
      description:
        '사용자가 대상을 Zeus 화면에 보이는 이름(유닛 종류명, 플레이어 이름, 그룹 콜사인, 차량, 모듈, 마커, ' +
        '에디터 변수명)이나 "Zeus 에서 선택한 것"으로 말하면 arma_exec 전에 이 툴로 찾는다. ' +
        "결과의 sqf 식(예: (\"2:345\" call BIS_fnc_objectFromNetId))을 arma_exec 코드에 그대로 넣어 쓴다. " +
        "source='mission' 은 맵에 있는 것, 'selected' 는 지금 Zeus 에서 선택한 것, " +
        "'palette' 는 Zeus 생성 패널(유닛 종류, 차량, 모듈, 그룹 편성)이다. " +
        '이름은 Zeus 를 쓰는 플레이어 머신의 언어로 계산한다. 같은 이름이 여럿이면 score, dist, grid 로 고르거나 ' +
        '사용자에게 묻는다. 게임을 바꾸지 않는다.',
      inputSchema: {
        stack: STACK_INPUT,
        source: z
          .enum(['mission', 'selected', 'palette'])
          .optional()
          .describe("기본 'mission'. 'selected' 는 Zeus 머신의 curatorSelected, 'palette' 는 Zeus 생성 목록."),
        query: z
          .string()
          .optional()
          .describe('이름 조각(대소문자 무시). 공백으로 나눈 낱말이 모두 들어 있어도 맞는다. 비우면 목록.'),
        kind: z
          .union([z.enum(ALL_KINDS), z.array(z.enum(ALL_KINDS))])
          .optional()
          .describe(
            "종류 하나나 배열. mission, selected: unit, group, vehicle, module, object, marker. " +
              'palette: unit, vehicle, object, module, groupTemplate.',
          ),
        side: z.enum(SIDES).optional().describe('진영 필터.'),
        zeusOnly: z.boolean().optional().describe('mission 에서 curator 편집 대상만.'),
        near: z
          .union([z.array(z.number()).min(2).max(3), z.literal('camera')])
          .optional()
          .describe("[x,y] 또는 'camera'(Zeus 카메라). 같은 점수는 가까운 순으로, 행에 dist(m)를 단다."),
        limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('최대 결과 수. 기본 20.'),
        on: ON_INPUT,
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) =>
        jsonContent(await runZeusFind(deps, args as ZeusFindArgs, signal)),
      ),
    ),
  );

  server.registerTool(
    'arma_zeus_module',
    {
      title: 'Zeus 모듈 실행',
      description:
        'Zeus 모듈을 Zeus 에서 놓은 것과 같은 경로로 실행한다. 사용자가 모듈 실행을 명시적으로 요청했을 때만 쓴다. ' +
        'module 은 클래스명이나 Zeus 에 보이는 모듈 이름이고, 이름이 여러 모듈에 걸리면 만들지 않고 candidates 를 돌려준다. ' +
        '모듈은 Zeus 를 쓰는 플레이어의 머신에서 만들어지므로 창을 띄우는 모듈은 그 사람 화면에 창이 뜬다(outcome=dialog). ' +
        "부착형 모듈은 target 에 arma_zeus_find 의 ref 를 준다. outcome 은 consumed, persistent, dialog 중 하나다. " +
        'Zeus 의 속성 창과 엔진 CuratorObjectPlaced 이벤트는 흉내 내지 못한다. dryRun 으로 해석만 볼 수 있다.',
      inputSchema: {
        stack: STACK_INPUT,
        module: z.string().min(1).describe('클래스명 또는 Zeus 에 보이는 모듈 이름.'),
        pos: z
          .array(z.number())
          .min(2)
          .max(3)
          .optional()
          .describe('월드 좌표 [x,y]. 생략하면 target 위치, 그것도 없으면 Zeus 화면 중앙.'),
        target: z
          .string()
          .optional()
          .describe('arma_zeus_find 의 ref(netId). 부착형 모듈의 대상이자 커서 아래 대상.'),
        on: ON_INPUT,
        dryRun: z.boolean().optional().describe('true 면 모듈 이름 해석과 위치만 보고 만들지 않는다.'),
        observeMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_OBSERVE_MS)
          .optional()
          .describe('만든 뒤 결과를 보기까지 기다리는 시간(ms). 기본 1500.'),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], async (signal) =>
        jsonContent(await runZeusModule(deps, args as ZeusModuleArgs, signal)),
      ),
    ),
  );
}
