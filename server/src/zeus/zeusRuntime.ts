// zeusRuntime.ts: Zeus 툴의 실행 머신 선택, exec 왕복, 페이지 이어 받기, 행 변환.
//
// 이름은 Zeus 를 쓰는 클라이언트에서 계산한다. 종류명과 모듈 이름은 그 머신의 게임 언어로
// 나오는데, 데디 서버는 클라이언트와 언어가 다를 수 있다. 모듈도 그 클라이언트에서 만들어야
// 모드의 모듈처럼 `local _Logic` 과 `player` 에 기대는 함수가 Zeus 배치와 같게 돈다.

import type { Deps } from '../mcp/deps.js';
import type { ExecOutcome, ExecRequestContext } from '../exec/execManager.js';
import { sqfString } from '../mcp/sqfLiteral.js';
import { tryParseSqfValue, type SqfValue } from './sqfValue.js';
import { buildDetectSqf, buildPageSqf, MF, PF } from './zeusSqf.js';

export type ZeusOn = 'auto' | 'server' | string;

/** 조립 SQF 를 보낼 머신. mode 와 target 은 ExecManager.run 에 그대로 넘긴다. */
export interface ZeusMachine {
  mode: 'server' | 'client';
  target?: string;
  /** 고른 이유. auto 면 감지 결과, 아니면 호출자가 준 값. */
  via: 'auto' | 'server' | 'player';
  /** 이 머신이 Zeus 를 쓰는 플레이어의 머신인가(SP 포함). selected 와 module 의 전제다. */
  isZeus: boolean;
  /** 그 플레이어 이름(있으면). curator 편집 대상 추가에 쓴다. */
  player?: string;
}

export type PickResult =
  | { ok: true; machine: ZeusMachine; zeusPlayers: string[]; note?: string }
  | { ok: false; error: string; zeusPlayers?: string[]; hint?: string };

export interface ExecValue {
  outcome: ExecOutcome;
  /** 첫 결과가 ARRAY 로 읽혔으면 그 값. */
  value: SqfValue[] | null;
  /** 결과를 읽지 못했을 때의 이유. */
  error?: string;
  /** 결과를 보낸 머신. server 모드는 'server'(SP 포함), client 모드는 그 플레이어 이름이다. */
  machine?: string;
}

const TRUNCATED = '...(truncated)';

/** exec 한 번. 첫 결과를 SQF 배열로 읽는다. */
export async function execValue(
  deps: Deps,
  machine: Pick<ZeusMachine, 'mode' | 'target'>,
  code: string,
  label: string,
  ctx: ExecRequestContext,
  timeoutMs: number,
): Promise<ExecValue> {
  const outcome = await deps.exec.run({
    code,
    mode: machine.mode,
    target: machine.target,
    label,
    timeoutMs,
    checkRpt: false,
    context: ctx,
  });
  const first = outcome.results[0];
  if (!outcome.ok || !first) {
    return { outcome, value: null, error: outcome.error ?? 'no result' };
  }
  if (first.parsed.kind !== 'value' || first.parsed.type !== 'ARRAY') {
    return {
      outcome,
      value: null,
      machine: first.machine,
      error: `unexpected result: ${first.result.slice(0, 200)}`,
    };
  }
  const raw = first.parsed.value ?? '';
  if (raw.endsWith(TRUNCATED)) {
    return {
      outcome,
      value: null,
      machine: first.machine,
      error: '게임 결과가 500자에서 잘렸습니다(페이지 예산 오류). 이 툴의 버그입니다.',
    };
  }
  const value = tryParseSqfValue(raw);
  if (!Array.isArray(value)) {
    return { outcome, value: null, machine: first.machine, error: `unparsable result: ${raw.slice(0, 200)}` };
  }
  return { outcome, value, machine: first.machine };
}

/**
 * 조립 SQF 를 보낼 머신을 고른다.
 * need='selected' 는 Zeus 화면이 있는 머신이어야 한다.
 * need='module' 은 auto 면 Zeus 머신을 요구하고, 호출자가 on='server' 로 서버를 고를 수는 있다.
 * need='labels' 는 mission 과 palette: Zeus 머신이 좋지만 없으면 서버도 된다.
 */
export async function pickZeusMachine(
  deps: Deps,
  on: ZeusOn | undefined,
  need: 'selected' | 'module' | 'labels',
  ctx: ExecRequestContext,
): Promise<PickResult> {
  const want = (on ?? 'auto').trim();
  if (want === 'server') {
    const snap = deps.telemetry.current();
    const dedicated = snap.multiplayer && snap.dedicated;
    if (need === 'selected' && dedicated) {
      return {
        ok: false,
        error: '데디 서버에는 Zeus 화면이 없습니다. on 을 Zeus 를 쓰는 플레이어 이름으로 주세요.',
      };
    }
    return {
      ok: true,
      machine: { mode: 'server', via: 'server', isZeus: !snap.multiplayer },
      zeusPlayers: [],
      note:
        need === 'module' && dedicated
          ? '데디 서버에서 만들었습니다. player 와 화면에 기대는 모듈은 동작하지 않습니다.'
          : undefined,
    };
  }
  if (want !== '' && want !== 'auto') {
    return {
      ok: true,
      machine: { mode: 'client', target: want, via: 'player', isZeus: true, player: want },
      zeusPlayers: [],
    };
  }

  const det = await execValue(deps, { mode: 'server' }, buildDetectSqf(), 'zeus-detect', ctx, 5000);
  if (!det.value) {
    return { ok: false, error: `Zeus 감지에 실패했습니다: ${det.error ?? 'no result'}` };
  }
  const [isMp, , list] = det.value;
  const zeus = (Array.isArray(list) ? list : [])
    .filter((e): e is SqfValue[] => Array.isArray(e))
    .map((e) => ({ name: String(e[0] ?? ''), local: e[1] === true }))
    .filter((e) => e.name !== '');
  const names = zeus.map((z) => z.name);

  if (isMp !== true) {
    // SP 는 머신이 하나다. server 모드로 보내고 결과 machine 은 'server' 로 온다(실게임 확인).
    return {
      ok: true,
      machine: { mode: 'server', via: 'auto', isZeus: true, player: names[0] },
      zeusPlayers: names,
      note: zeus.length === 0 ? '이 미션에서 플레이어에게 배정된 curator 를 찾지 못했습니다.' : undefined,
    };
  }

  if (zeus.length === 0) {
    if (need !== 'labels') {
      return {
        ok: false,
        error: 'curator 에 배정된 플레이어가 없습니다. Zeus 를 쓰는 플레이어가 접속해 Zeus 를 받아야 합니다.',
        zeusPlayers: [],
        hint: '플레이어를 알면 on 에 그 이름을 주세요.',
      };
    }
    return {
      ok: true,
      machine: { mode: 'server', via: 'auto', isZeus: false },
      zeusPlayers: [],
      note: 'Zeus 를 쓰는 플레이어가 없어 서버에서 읽었습니다. 종류명과 모듈 이름이 서버 언어일 수 있습니다.',
    };
  }

  if (zeus.length > 1 && need !== 'labels') {
    return {
      ok: false,
      error: `Zeus 를 쓰는 플레이어가 여럿입니다(${names.join(', ')}). on 에 한 명을 주세요.`,
      zeusPlayers: names,
    };
  }

  const pick = zeus[0] as { name: string; local: boolean };
  const machine: ZeusMachine = pick.local
    ? { mode: 'server', via: 'auto', isZeus: true, player: pick.name }
    : { mode: 'client', target: pick.name, via: 'auto', isZeus: true, player: pick.name };
  return {
    ok: true,
    machine,
    zeusPlayers: names,
    note:
      zeus.length > 1
        ? `Zeus 를 쓰는 플레이어가 여럿이라 ${pick.name} 의 머신에서 읽었습니다. 다른 사람 기준이면 on 을 주세요.`
        : undefined,
  };
}

export interface PagedResult {
  ok: boolean;
  error?: string;
  total: number;
  rows: SqfValue[][];
  meta: SqfValue[];
  machine?: string;
  execs: number;
  durationMs: number;
}

/**
 * 첫 exec 가 [합계, 쪽수, 첫 쪽, meta] 를 돌려주면, 남은 쪽을 같은 머신에서 이어 받는다.
 * 마지막 쪽을 받을 때 게임 쪽 보관 키를 지운다.
 */
export async function runPaged(
  deps: Deps,
  machine: ZeusMachine,
  code: string,
  key: string,
  label: string,
  ctx: ExecRequestContext,
  timeoutMs: number,
): Promise<PagedResult> {
  const t0 = Date.now();
  const first = await execValue(deps, machine, code, label, ctx, timeoutMs);
  const fail = (error: string, execs: number): PagedResult => ({
    ok: false,
    error,
    total: 0,
    rows: [],
    meta: [],
    machine: first.machine,
    execs,
    durationMs: Date.now() - t0,
  });
  if (!first.value) return fail(first.error ?? 'no result', 1);

  const [total, pageCount, page0, meta] = first.value;
  if (typeof total !== 'number' || typeof pageCount !== 'number' || !Array.isArray(page0)) {
    return fail('unexpected result shape', 1);
  }
  const rows: SqfValue[][] = page0.filter((r): r is SqfValue[] => Array.isArray(r));
  let execs = 1;
  for (let i = 1; i < pageCount; i++) {
    const last = i === pageCount - 1;
    const page = await execValue(deps, machine, buildPageSqf(key, i, last), `${label}-page`, ctx, timeoutMs);
    execs += 1;
    if (!page.value) return fail(`${i + 1}쪽을 받지 못했습니다: ${page.error ?? 'no result'}`, execs);
    const [stored, part] = page.value;
    if (stored === 0 || !Array.isArray(part)) {
      return fail(`${i + 1}쪽이 게임에 없습니다(다른 호출이 보관분을 치웠을 수 있습니다). 다시 부르세요.`, execs);
    }
    for (const r of part) if (Array.isArray(r)) rows.push(r);
  }
  return {
    ok: true,
    total,
    rows,
    meta: Array.isArray(meta) ? meta : [],
    machine: first.machine,
    execs,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------- 행 변환

const asStr = (v: SqfValue | undefined): string => (typeof v === 'string' ? v : '');
const asNum = (v: SqfValue | undefined): number => (typeof v === 'number' ? v : 0);

/** 빈 문자열과 undefined 를 뺀다. 응답 토큰을 줄인다. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === '') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

/**
 * netId 를 arma_exec 에 붙여 쓸 식으로. 마커는 이름 문자열, 그룹은 groupFromNetId.
 * 변수명은 쓰지 않는다. 이름을 계산한 머신(보통 Zeus 클라)에서만 확인한 값이라 서버에는 없거나
 * 다른 것을 가리킬 수 있다(실게임에서 모드가 플레이어에 붙인 변수명이 그랬다).
 */
export function refExpr(kind: string, ref: string): string {
  if (kind === 'marker') return sqfString(ref);
  if (kind === 'group') return `(${sqfString(ref)} call BIS_fnc_groupFromNetId)`;
  return `(${sqfString(ref)} call BIS_fnc_objectFromNetId)`;
}

export function mapMissionRow(r: SqfValue[]): Record<string, unknown> {
  const [kind, ref, label, type, cls, name, varName, callsign, role, side, grid, x, y, flags, extra, score, dist] = r;
  const k = asStr(kind);
  const f = asNum(flags);
  const v = asStr(varName);
  const base = {
    kind: k,
    label: asStr(label),
    ref: asStr(ref),
    sqf: refExpr(k, asStr(ref)),
    class: asStr(cls),
    type: k === 'marker' || asStr(type) === asStr(label) ? '' : asStr(type),
    name: k === 'group' ? '' : asStr(name),
    leader: k === 'group' ? asStr(name) : '',
    var: v,
    group: k === 'unit' ? asStr(callsign) : '',
    role: asStr(role),
    side: asStr(side),
    grid: asStr(grid),
  };
  return {
    ...compact(base),
    pos: [asNum(x), asNum(y)],
    ...(k === 'marker' ? {} : { zeus: (f & MF.zeus) !== 0, local: (f & MF.local) !== 0 }),
    ...((f & MF.player) !== 0 ? { player: true } : {}),
    ...(k === 'group' && typeof extra === 'number' ? { units: extra } : {}),
    ...((k === 'vehicle' || k === 'object') && typeof extra === 'number' ? { crew: extra } : {}),
    score: asNum(score),
    ...(typeof dist === 'number' && dist >= 0 ? { dist } : {}),
  };
}

/** groupTemplate 의 class 는 "Side|Faction|Category|Group". */
export function groupTemplateExpr(path: string): string {
  return ['configFile', '"CfgGroups"', ...path.split('|').map((p) => sqfString(p))].join(' >> ');
}

export function mapPaletteRow(r: SqfValue[]): Record<string, unknown> {
  const [kind, cls, label, path, side, flags, score] = r;
  const k = asStr(kind);
  const c = asStr(cls);
  const f = asNum(flags);
  const isGroup = k === 'groupTemplate';
  return {
    ...compact({
      kind: k,
      label: asStr(label),
      class: isGroup ? c.split('|').pop() ?? c : c,
      path: asStr(path),
      side: asStr(side),
      sqf: isGroup ? groupTemplateExpr(c) : sqfString(c),
    }),
    ...(k === 'module'
      ? {
          canAttach: (f & PF.canAttach) !== 0,
          attributeDialog: (f & PF.attributeDialog) !== 0,
          opensDialog: (f & PF.opensDialog) !== 0,
        }
      : {}),
    score: asNum(score),
  };
}

/** meta: [게임 언어, Zeus 창 열림, 이 머신 curator 있음]. */
export function mapMeta(meta: SqfValue[]): { language?: string; zeusOpen?: boolean; hasCurator?: boolean } {
  return {
    language: typeof meta[0] === 'string' ? meta[0] : undefined,
    zeusOpen: typeof meta[1] === 'boolean' ? meta[1] : undefined,
    hasCurator: typeof meta[2] === 'boolean' ? meta[2] : undefined,
  };
}

let callSeq = 0;

/** 게임 쪽 보관 키. 세션과 호출마다 다르다. */
export function nextKey(shortId: string, prefix: string): string {
  callSeq = (callSeq + 1) % 1_000_000;
  const tag = shortId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'x';
  return `${prefix}_${tag}_${Date.now().toString(36)}_${callSeq}`;
}
