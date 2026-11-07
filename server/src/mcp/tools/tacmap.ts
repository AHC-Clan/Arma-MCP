// tacmap.ts — AHC_TacticalMap 연동 툴 등록(arma_tacmap_subtitle / _mark / _open).
//
// AHC_TacticalMap 은 별도 모드다. 여기서는 새 와이어 타입도, 새 remoteExec 대상도
// 만들지 않고 기존 exec 인프라만 탄다(arma_web_open → fn_openUrl 과 같은 구조):
// 서버가 검증·조립한 SQF 를 mode='server' 로 보내면 TacMap 의 서버측 함수가 실행된다.
//
// TacMap 치트 함수는 전부 반환값이 없다. 그래서 조립 SQF 는 항상 문자열 ack 로 끝나야
// 하며(그렇지 않으면 성공이 <nil> 과 구분되지 않는다), 조립 코드에 주석을 넣지 않는다
// (exec 경로는 compile 만 하고 preprocess 하지 않는다).
//
// 최종 판정은 언제나 조립 SQF 안의 isNil 가드가 내린다. sessionInfo 의 tacmap 필드는
// 힌트/note 용이며 하드 게이트로 쓰지 않는다(구버전 PBO 는 필드를 보내지 않으므로 null).

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { BROADCAST_POLICY_KO } from '../broadcastPolicy.js';
import { makeSessionExecContext } from '../execContext.js';
import { sqfNumber, sqfString, sqfStringArray, ackOf } from '../sqfLiteral.js';
import { openOnMachines } from './web.js';
import { pickLanIp } from '../../web/webServer.js';
import type { ExecOutcome } from '../../exec/execManager.js';

/** ZeusTool 색 프리셋 → hex. 출처: TacMap fn_cheatZeusTitle.sqf 의 switch 테이블. */
export const ZEUS_COLORS: Record<string, string> = {
  red: '#FF0000',
  green: '#1DDB16',
  blue: '#0054FF',
  yellow: '#FFE400',
  hq: '#0054FF',
  enemy: '#FF0000',
};

/** side 토큰 → SQF side 식별자. */
const SIDE_SQF: Record<string, string> = {
  WEST: 'west',
  EAST: 'east',
  GUER: 'independent',
  CIV: 'civilian',
};

const MARKER_PREFIX = 'mcp_mark_';
/**
 * TacMap 이 예약한 마커 프리픽스. 앞의 셋은 fn_gatherMarkers 가 웹 수집에서 스킵하고,
 * ahc_ping_ 은 fn_cheatPingClear 가 일괄 삭제한다 — 우리 마커명으로 절대 쓰면 안 된다.
 */
export const RESERVED_MARKER_PREFIXES = ['ahc_web_', 'ahc_text_', 'ahc_heli', 'ahc_ping_'];

const TEXT_MAX = 300;
const SPEAKER_MAX = 32;
const MARKER_TEXT_MAX = 64;

let markSeq = 0;

/** 제어문자·개행을 공백으로 접고 길이를 자른다(parseSimpleArray 봉투 + 구조화 텍스트 보호). */
export function scrubText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** 색 토큰 또는 #rrggbb 를 hex 로. 알 수 없으면 null(호출부가 거부). */
export function resolveColor(input?: string): string | null {
  const v = (input ?? 'yellow').trim();
  if (v === '') return null;
  const preset = ZEUS_COLORS[v.toLowerCase()];
  if (preset) return preset;
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v.startsWith('#') ? v : '#' + v;
  return null;
}

/** 마커 이름 결정. 항상 mcp_mark_ 로 시작하고 예약 프리픽스와 겹치지 않는다. */
export function resolveMarkerName(id: string | undefined, shortId: string, seq: number): string {
  const clean = (id ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, 32);
  return MARKER_PREFIX + (clean !== '' ? clean : `${shortId}_${seq}`);
}

// ---------------------------------------------------------------- SQF 조립

export interface SubtitleSqfArgs {
  text: string;
  speaker: string;
  hex: string;
  audience: 'all' | 'side' | 'players';
  side?: string;
  players?: string[];
}

export function buildSubtitleSqf(a: SubtitleSqfArgs): string {
  const payload = `[${sqfString(a.speaker)},${sqfString(a.text)},${sqfString(a.hex)}]`;
  const guard = 'if (isNil "AHC_TacticalMap_fnc_cheatZeusTitle") exitWith {"ERR:tacmap-absent"};';

  if (a.audience === 'all') {
    // cheatZeusTitle 경유: 전 클라 fan-out + 웹 채팅 로그 미러 + TacMap 감사 로그.
    return `${guard} ${payload} call AHC_TacticalMap_fnc_cheatZeusTitle; "OK:all"`;
  }

  // side/players 는 클라 로컬 효과이므로 수신자는 PLAYER 유닛 배열이어야 한다
  // (fn_cheatPing 의 관용구). side 비교는 group side 기준 — captive/rating 영향을 받지 않는다.
  const filter =
    a.audience === 'side'
      ? `alive _x && {side group _x isEqualTo ${SIDE_SQF[a.side ?? 'WEST']}}`
      : 'alive _x && {name _x in _w}';
  const want =
    a.audience === 'players' ? `private _w = ${sqfStringArray(a.players ?? [])}; ` : '';
  const ret =
    a.audience === 'players'
      ? 'format ["OK:%1|%2", count _t, str (_w - (_t apply {name _x}))]'
      : 'format ["OK:%1", count _t]';

  return (
    `${guard} ${want}private _t = allPlayers select {${filter}}; ` +
    'if (count _t == 0) exitWith {"ERR:no-recipients"}; ' +
    `["AHC_TacticalMap_zeusTitle", ${payload}, _t] call CBA_fnc_targetEvent; ${ret}`
  );
}

export interface MarkSqfArgs {
  action: 'add' | 'remove' | 'clearAll';
  name: string;
  pos: [number, number];
  text: string;
  kind: 'icon' | 'ellipse' | 'rectangle';
  iconType: string;
  color: string;
  size: [number, number];
  dir: number;
  brush: string;
  ttlSec: number;
  ping: boolean;
  pingType: string;
  pingSide: string;
  commanderOverride: boolean;
  resync: boolean;
}

/** resync 는 cheatResync(지휘관 게이트 없음)로 웹 수집 주기(기본 5s)를 건너뛴다. */
function resyncStmt(on: boolean): string {
  return on
    ? 'if (!isNil "AHC_TacticalMap_fnc_cheatResync") then {[] call AHC_TacticalMap_fnc_cheatResync}; '
    : '';
}

/**
 * 지휘관 좌석 게이트 + 관측 기반 효과 검증.
 * cheatPing 은 좌석이 비면 조용히 exitWith 하고 1.5s 쿨다운도 조용히 삼킨다. 그래서
 * ahc_ping_* 마커 수의 증가를 실측해 성공/무효를 구분한다(쿨다운은 override 로 못 넘는다).
 */
function pingStmt(a: MarkSqfArgs): string {
  if (!a.ping) return '';
  const seat = 'missionNamespace getVariable ["AHC_TacticalMap_commander",""]';
  const count = 'count (allMapMarkers select {(_x find "ahc_ping_") == 0})';
  const call =
    `[${sqfNumber(a.pos[0])},${sqfNumber(a.pos[1])},${sqfString(a.pingType)},` +
    `${sqfString(a.pingSide)}] call AHC_TacticalMap_fnc_cheatPing;`;
  const take = a.commanderOverride
    ? `if (_prev isEqualTo "") then {missionNamespace setVariable ["AHC_TacticalMap_commander","mcp-agent"]; _took = true}; `
    : '';
  return (
    'if (isNil "AHC_TacticalMap_fnc_cheatPing") then {_p = "no-tacmap"} else ' +
    `{private _prev = ${seat}; private _took = false; ${take}` +
    `if ((${seat}) isEqualTo "") then {_p = "no-commander"} else ` +
    `{private _b = ${count}; ${call} ` +
    'if (_took) then {missionNamespace setVariable ["AHC_TacticalMap_commander",_prev]}; ' +
    `if ((${count}) > _b) then {_p = "ok"} else {_p = "no-effect"}}}; `
  );
}

export function buildMarkSqf(a: MarkSqfArgs): string {
  if (a.action === 'clearAll') {
    return (
      `private _all = allMapMarkers select {(_x find ${sqfString(MARKER_PREFIX)}) == 0}; ` +
      '{deleteMarker _x} forEach _all; ' +
      resyncStmt(a.resync) +
      'format ["OK:%1", count _all]'
    );
  }

  if (a.action === 'remove') {
    return (
      `private _n = ${sqfString(a.name)}; private _e = !((markerShape _n) isEqualTo ""); ` +
      'deleteMarker _n; ' +
      resyncStmt(a.resync) +
      'if (_e) then {format ["OK:%1", _n]} else {"ERR:not-found"}'
    );
  }

  const posLit = `[${sqfNumber(a.pos[0])},${sqfNumber(a.pos[1])},0]`;
  const shape = a.kind === 'icon' ? 'ICON' : a.kind === 'ellipse' ? 'ELLIPSE' : 'RECTANGLE';

  // *Local 세터를 쌓고 마지막에 GLOBAL 세터 하나(setMarkerAlpha)로 한 번에 브로드캐스트한다
  // — fn_cheatPing / fn_onWebText 와 같은 관용구(네트워크 갱신 N회 → 1회).
  let body =
    `private _p = "skip"; private _n = ${sqfString(a.name)}; deleteMarker _n; ` +
    `createMarker [_n, ${posLit}]; _n setMarkerShapeLocal ${sqfString(shape)}; `;
  if (a.kind === 'icon') {
    body += `_n setMarkerTypeLocal ${sqfString(a.iconType)}; `;
  } else {
    body +=
      `_n setMarkerSizeLocal [${sqfNumber(a.size[0])},${sqfNumber(a.size[1])}]; ` +
      `_n setMarkerBrushLocal ${sqfString(a.brush)}; `;
  }
  body +=
    `_n setMarkerColorLocal ${sqfString(a.color)}; ` +
    `_n setMarkerTextLocal ${sqfString(a.text)}; ` +
    `_n setMarkerDirLocal ${sqfNumber(a.dir)}; ` +
    '_n setMarkerAlpha 1; ';
  if (a.ttlSec > 0) {
    body += `[_n, ${sqfNumber(a.ttlSec)}] spawn {params ["_m","_t"]; uiSleep _t; deleteMarker _m;}; `;
  }
  body += pingStmt(a);
  body += resyncStmt(a.resync);
  body +=
    'if ((markerShape _n) isEqualTo "") then {"ERR:create-failed"} else ' +
    `{format ["OK:%1|%2|%3", _n, mapGridPosition ${posLit}, _p]}`;
  return body;
}

/** 웹 host/port + TacMap 로드 여부를 한 번에 읽는다. CBA 설정은 동명의 missionNamespace 변수. */
export const TACMAP_PROBE_SQF =
  'format ["%1|%2|%3", missionNamespace getVariable ["AHC_TacticalMap_host",""], ' +
  'missionNamespace getVariable ["AHC_TacticalMap_port","8088"], ' +
  'if (isNil "AHC_TacticalMap_fnc_cheatResync") then {0} else {1}]';

// ---------------------------------------------------------------- 공용 헬퍼

function firstAck(outcome: ExecOutcome): string | null {
  const first = outcome.results[0];
  if (!first || first.parsed.kind !== 'value' || first.parsed.type !== 'STRING') return null;
  return ackOf(first.parsed.value);
}

function execSummary(outcome: ExecOutcome): Record<string, unknown> {
  return {
    ok: outcome.ok,
    completedBy: outcome.completedBy,
    durationMs: outcome.durationMs,
    reqId: outcome.reqId,
    machine: outcome.results[0]?.machine,
    result: outcome.results[0]?.result,
  };
}

function joinNotes(notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((n): n is string => typeof n === 'string' && n !== '');
  return kept.length > 0 ? kept.join(' / ') : undefined;
}

/** TacMap 감지 상태에서 나오는 공통 주의 문구(하드 게이트가 아니라 안내). */
function capabilityNotes(deps: Deps): (string | undefined)[] {
  const tacmap = deps.telemetry.tacmap();
  return [
    tacmap === null
      ? '애드온이 tacmap 감지 필드를 보내지 않았습니다(구버전 @arma_mcp PBO) — 판정은 게임에서 직접 수행했습니다.'
      : undefined,
    tacmap === false
      ? 'arma_status 는 AHC_TacticalMap 미로드로 보고합니다 — 서버 애드온 구성을 확인하세요.'
      : undefined,
  ];
}

// ---------------------------------------------------------------- 무전 자막

export interface SubtitleArgs {
  text: string;
  speaker?: string;
  color?: string;
  audience?: 'all' | 'side' | 'players';
  side?: 'WEST' | 'EAST' | 'GUER' | 'CIV';
  players?: string[];
  timeoutMs?: number;
}

export async function runSubtitle(deps: Deps, args: SubtitleArgs): Promise<Record<string, unknown>> {
  const audience = args.audience ?? 'all';
  const text = scrubText(args.text ?? '', TEXT_MAX);
  if (text === '') return { ok: false, error: 'text is empty (TacMap 은 빈 자막을 무시한다)' };

  const hex = resolveColor(args.color);
  if (hex === null) {
    return {
      ok: false,
      error: `color must be one of ${Object.keys(ZEUS_COLORS).join('|')} or #rrggbb`,
    };
  }
  if (audience === 'side' && !args.side) {
    return { ok: false, error: "audience 'side' requires side (WEST|EAST|GUER|CIV)" };
  }
  const players = (args.players ?? []).map((p) => scrubText(p, 64)).filter((p) => p !== '');
  if (audience === 'players' && players.length === 0) {
    return { ok: false, error: "audience 'players' requires a non-empty players array" };
  }
  if (!deps.gateway.isConnected()) return { ok: false, error: 'game not connected' };

  const speaker = scrubText(args.speaker ?? '', SPEAKER_MAX);
  const code = buildSubtitleSqf({ text, speaker, hex, audience, side: args.side, players });

  const outcome = await deps.exec.run({
    code,
    mode: 'server',
    label: 'tacmap-subtitle',
    timeoutMs: args.timeoutMs ?? 5000,
    checkRpt: true,
    context: makeSessionExecContext(deps),
  });

  const ack = firstAck(outcome);
  const zeusToolSfx = deps.telemetry.tacmapZeusTool();
  const notes = [
    ...capabilityNotes(deps),
    zeusToolSfx === false
      ? 'AHC_ZeusTool 미설치 — 자막은 표시되지만 무전 사운드(PH_radio_on/off)는 재생되지 않습니다.'
      : undefined,
    deps.telemetry.current().multiplayer
      ? '@AHC_TacticalMap 이 없는 클라이언트에서는 자막이 렌더되지 않습니다.'
      : undefined,
  ];

  if (!outcome.ok || ack === null) {
    return {
      ok: false,
      error: outcome.error ?? 'unexpected <nil>/ERROR — 조립 SQF 가 실패했습니다(rptErrors 확인)',
      audience,
      ack,
      exec: execSummary(outcome),
      rptErrors: outcome.rptErrors,
      note: joinNotes(notes),
    };
  }
  if (ack === 'ERR:tacmap-absent') {
    return {
      ok: false,
      error: 'AHC_TacticalMap 이 이 런타임에 로드되지 않았습니다',
      hint: 'arma_status 의 tacmap 필드를 확인하고 서버 모드 구성을 점검하세요.',
      exec: execSummary(outcome),
    };
  }
  if (ack === 'ERR:no-recipients') {
    return {
      ok: false,
      error: '대상 플레이어가 없습니다(살아있는 접속 플레이어 기준)',
      audience,
      side: args.side,
      players,
      exec: execSummary(outcome),
    };
  }

  // OK:all | OK:<n> | OK:<n>|<str missing 배열>
  const rest = ack.startsWith('OK:') ? ack.slice(3) : ack;
  const bar = rest.indexOf('|');
  const head = bar >= 0 ? rest.slice(0, bar) : rest;
  const missingRaw = bar >= 0 ? rest.slice(bar + 1) : '';
  const recipients = head === 'all' ? null : Number(head);

  return {
    ok: true,
    audience,
    recipients: Number.isFinite(recipients as number) ? recipients : null,
    missing: missingRaw === '' || missingRaw === '[]' ? [] : missingRaw,
    speaker,
    text,
    color: hex,
    ack,
    zeusToolSfx,
    webChatMirrored: audience === 'all',
    exec: execSummary(outcome),
    rptErrors: outcome.rptErrors,
    note: joinNotes(notes),
  };
}

// ---------------------------------------------------------------- 지도 표시

const PING_COOLDOWN_SEC = 1.5;

const PING_REASONS: Record<string, string> = {
  ok: '핑 전송 완료(20초 후 자동 소멸).',
  'no-tacmap': 'AHC_TacticalMap 이 로드되지 않아 핑을 보낼 수 없습니다(마커는 표시됨).',
  'no-commander':
    '지휘관 좌석(AHC_TacticalMap_commander)이 비어 있어 핑이 전송되지 않았습니다(마커는 표시됨). ' +
    '웹 전술지도에서 좌석을 점유하거나 commanderOverride:true 를 쓰세요.',
  'no-effect':
    `핑이 무효 처리됐습니다 — TacMap 서버측 쿨다운(${PING_COOLDOWN_SEC}초)일 가능성이 큽니다. ` +
    'commanderOverride 로도 쿨다운은 우회할 수 없습니다.',
  skip: '핑을 요청하지 않았습니다.',
};

export interface MarkArgs {
  action?: 'add' | 'remove' | 'clearAll';
  pos?: number[];
  text?: string;
  kind?: 'icon' | 'ellipse' | 'rectangle';
  iconType?: string;
  color?: string;
  size?: number[];
  dir?: number;
  ttlSec?: number;
  id?: string;
  ping?: boolean;
  pingType?: 'rally' | 'move' | 'attack' | 'warn' | 'recon';
  pingSide?: '' | 'WEST' | 'EAST' | 'GUER' | 'CIV';
  commanderOverride?: boolean;
  resync?: boolean;
  brush?: string;
  timeoutMs?: number;
}

export async function runMark(deps: Deps, args: MarkArgs): Promise<Record<string, unknown>> {
  const action = args.action ?? 'add';
  if (action === 'add' && (!Array.isArray(args.pos) || args.pos.length < 2)) {
    return { ok: false, error: "action 'add' requires pos [x,y]" };
  }
  if (action === 'remove' && !args.id) {
    return { ok: false, error: "action 'remove' requires id" };
  }
  const pos: [number, number] = [Number(args.pos?.[0] ?? 0), Number(args.pos?.[1] ?? 0)];
  if (action === 'add' && (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1]))) {
    return { ok: false, error: 'pos must be finite numbers' };
  }
  if (!deps.gateway.isConnected()) return { ok: false, error: 'game not connected' };

  const name = action === 'clearAll' ? '' : resolveMarkerName(args.id, deps.session.shortId, ++markSeq);
  const sqfArgs: MarkSqfArgs = {
    action,
    name,
    pos,
    text: scrubText(args.text ?? '', MARKER_TEXT_MAX),
    kind: args.kind ?? 'icon',
    iconType: args.iconType ?? 'mil_objective',
    color: args.color ?? 'ColorRed',
    size: [Number(args.size?.[0] ?? 200), Number(args.size?.[1] ?? 200)],
    dir: Number(args.dir ?? 0),
    brush: args.brush ?? 'Border',
    ttlSec: Math.max(0, Math.trunc(Number(args.ttlSec ?? 0))),
    ping: Boolean(args.ping),
    pingType: args.pingType ?? 'move',
    pingSide: args.pingSide ?? '',
    commanderOverride: Boolean(args.commanderOverride),
    resync: args.resync ?? true,
  };

  // sqfNumber 는 비유한/비현실적 크기를 던진다 — 게임에 보내기 전에 잡는다.
  let code: string;
  try {
    code = buildMarkSqf(sqfArgs);
  } catch (e) {
    return { ok: false, action, error: (e as Error).message };
  }

  const outcome = await deps.exec.run({
    code,
    mode: 'server',
    label: `tacmap-mark-${action}`,
    timeoutMs: args.timeoutMs ?? 5000,
    checkRpt: true,
    context: makeSessionExecContext(deps),
  });

  const ack = firstAck(outcome);
  const focusNote =
    '전술지도 화면을 특정 좌표로 이동시키는 SQF API 는 없습니다 — 이 툴은 표시만 합니다.';
  const webNote = sqfArgs.resync
    ? 'resync 로 웹 지도에 즉시 반영했습니다.'
    : '웹 지도에는 다음 수집 주기(AHC_TacticalMap_markerInterval, 기본 5초)에 반영됩니다.';
  const notes = capabilityNotes(deps);

  if (!outcome.ok || ack === null) {
    return {
      ok: false,
      action,
      error: outcome.error ?? 'unexpected <nil>/ERROR — 조립 SQF 가 실패했습니다(rptErrors 확인)',
      ack,
      exec: execSummary(outcome),
      rptErrors: outcome.rptErrors,
      note: joinNotes(notes),
    };
  }
  if (ack.startsWith('ERR:')) {
    const errors: Record<string, string> = {
      'ERR:create-failed': 'createMarker 가 실패했습니다(이름 충돌 또는 잘못된 좌표)',
      'ERR:not-found': `마커 ${name} 가 존재하지 않습니다`,
    };
    return {
      ok: false,
      action,
      marker: name || undefined,
      error: errors[ack] ?? ack,
      exec: execSummary(outcome),
      rptErrors: outcome.rptErrors,
    };
  }

  const fields = ack.slice(3).split('|');
  if (action === 'clearAll') {
    return {
      ok: true,
      action,
      removed: Number(fields[0] ?? 0),
      resynced: sqfArgs.resync,
      ack,
      exec: execSummary(outcome),
      note: joinNotes([...notes, webNote]),
    };
  }
  if (action === 'remove') {
    return {
      ok: true,
      action,
      marker: fields[0] ?? name,
      resynced: sqfArgs.resync,
      ack,
      exec: execSummary(outcome),
      note: joinNotes([...notes, webNote]),
    };
  }

  const pingStatus = fields[2] ?? 'skip';
  return {
    ok: true,
    action,
    marker: fields[0] ?? name,
    grid: fields[1] ?? null,
    pos,
    kind: sqfArgs.kind,
    text: sqfArgs.text,
    ttlSec: sqfArgs.ttlSec,
    resynced: sqfArgs.resync,
    ping: {
      requested: sqfArgs.ping,
      delivered: pingStatus === 'ok',
      status: pingStatus,
      reason: PING_REASONS[pingStatus] ?? pingStatus,
      cooldownSec: PING_COOLDOWN_SEC,
      commanderOverride: sqfArgs.commanderOverride,
    },
    ack,
    exec: execSummary(outcome),
    rptErrors: outcome.rptErrors,
    focusNote,
    removeHint: `arma_tacmap_mark { "action": "remove", "id": ${JSON.stringify(
      (fields[0] ?? name).slice(MARKER_PREFIX.length),
    )} }`,
    note: joinNotes([...notes, webNote]),
  };
}

// ---------------------------------------------------------------- 웹 지도 열기

export interface TacMapUrl {
  url: string;
  source: 'override' | 'setting' | 'lan-fallback';
  host: string;
  port: string;
  note?: string;
}

/** 프로브 ack(`host|port|loaded`) + 인자로 전술지도 웹 URL 을 정한다. */
export function resolveTacMapUrl(
  ack: string | null,
  baseUrl: string | undefined,
  path: string,
  lanIp: string | null,
): TacMapUrl | { error: string } {
  const suffix = path.startsWith('/') ? path : '/' + path;

  let host = '';
  let port = '8088';
  if (ack !== null) {
    const parts = ack.split('|');
    const loaded = parts.pop() ?? '0';
    port = parts.pop() || '8088';
    host = parts.join('|');
    if (loaded !== '1' && !baseUrl) {
      return { error: 'AHC_TacticalMap 이 이 런타임에 로드되지 않았습니다' };
    }
  } else if (!baseUrl) {
    return { error: '전술지도 설정 프로브에 실패했습니다(baseUrl 로 직접 지정하세요)' };
  }

  if (baseUrl) {
    if (!/^https?:\/\//i.test(baseUrl)) return { error: 'baseUrl must be http:// or https://' };
    return { url: baseUrl.replace(/\/+$/, '') + suffix, source: 'override', host, port };
  }
  if (host !== '') {
    return { url: `http://${host}:${port}${suffix}`, source: 'setting', host, port };
  }
  // Host 가 빈칸 = 웹서버가 게임 서버와 같은 머신(named pipe). 플레이어 브라우저가 닿으려면
  // 루프백이 아니라 LAN 주소여야 하므로 데몬 머신의 LAN IP 로 추정한다.
  return {
    url: `http://${lanIp ?? '127.0.0.1'}:${port}${suffix}`,
    source: 'lan-fallback',
    host,
    port,
    note:
      'AHC_TacticalMap_host 가 비어 있어(웹서버와 게임 서버가 같은 머신) 이 데몬 머신의 LAN IP 로 ' +
      '해석했습니다. 웹서버가 다른 머신이면 baseUrl 로 직접 지정하세요.',
  };
}

export interface OpenArgs {
  mode?: 'all' | 'client';
  target?: string;
  baseUrl?: string;
  path?: string;
}

export async function runOpen(deps: Deps, args: OpenArgs): Promise<Record<string, unknown>> {
  const mode = args.mode ?? 'all';
  if (mode === 'client' && !args.target) {
    return { ok: false, error: "mode 'client' requires target (player name)" };
  }
  if (!deps.gateway.isConnected()) return { ok: false, error: 'game not connected' };
  const mission = deps.telemetry.current();
  if (mode === 'all' && mission.dedicated && mission.playerCount === 0) {
    return {
      ok: false,
      error: 'no player clients connected — dedicated server browser open skipped',
      mode,
    };
  }

  // baseUrl 명시는 프로브 결과와 무관하게 override 로 해석된다(resolveTacMapUrl) —
  // 게임 왕복 1회를 통째로 생략한다.
  const probe = args.baseUrl
    ? null
    : await deps.exec.run({
        code: TACMAP_PROBE_SQF,
        mode: 'server',
        label: 'tacmap-probe',
        timeoutMs: 3000,
        checkRpt: false,
        context: makeSessionExecContext(deps),
      });
  const resolved = resolveTacMapUrl(
    probe ? firstAck(probe) : null,
    args.baseUrl,
    args.path ?? '/',
    pickLanIp(),
  );
  if ('error' in resolved) {
    return {
      ok: false,
      error: resolved.error,
      hint: 'arma_status 의 tacmap 필드를 확인하거나 baseUrl 로 주소를 직접 지정하세요.',
      probe: probe ? execSummary(probe) : undefined,
    };
  }

  const opened = await openOnMachines(deps, resolved.url, mode, args.target);
  return {
    ok: opened.execOk,
    url: resolved.url,
    source: resolved.source,
    tacmapHost: resolved.host,
    tacmapPort: resolved.port,
    mode,
    opened,
    note: joinNotes([...capabilityNotes(deps), resolved.note]),
  };
}

// ---------------------------------------------------------------- 등록

export function registerTacMapTools(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_tacmap_subtitle',
    {
      title: '무전 자막 표시(AHC_TacticalMap)',
      description:
        BROADCAST_POLICY_KO +
        ' "무전 자막"을 화면에 띄운다 — AHC_TacticalMap 의 zeusTitle 경로(화면 하단 레이어 911, 7초, ' +
        'PH_radio_on/off 무전 사운드). 전체/특정 진영/특정 플레이어에게 보낼 수 있다. ' +
        '자막·무전·라디오 캡션 요청은 titleText 나 BIS_fnc_dynamicText 로 재구현하지 말고 이 툴을 쓴다 ' +
        '— audience=all 일 때는 웹 전술지도 채팅 로그에도 한 줄이 남는다. ' +
        'AHC_ZeusTool 미설치 서버에서도 자막은 정상 표시되고 사운드만 빠진다(웹 UI 경로와 달리 무시되지 않는다).',
      inputSchema: {
        stack: STACK_INPUT,
        text: z
          .string()
          .min(1)
          .describe('자막 본문(필수). 제어문자·개행은 공백으로 접히고 300자에서 잘린다.'),
        speaker: z
          .string()
          .optional()
          .describe("발화자 라벨(32자 캡). 지정하면 '<발화자> : <본문>', 생략하면 본문만."),
        color: z
          .string()
          .optional()
          .describe(
            "발화자 색. 프리셋 'red'|'green'|'blue'|'yellow'|'hq'|'enemy' 또는 '#rrggbb'. 기본 'yellow'.",
          ),
        audience: z
          .enum(['all', 'side', 'players'])
          .optional()
          .describe("수신 대상. 기본 'all'(전원). 'side'면 side 필수, 'players'면 players 필수."),
        side: z
          .enum(['WEST', 'EAST', 'GUER', 'CIV'])
          .optional()
          .describe("audience='side' 대상 진영. 그룹 side 기준(captive/rating 영향 없음)."),
        players: z
          .array(z.string())
          .optional()
          .describe("audience='players' 대상 플레이어 이름 배열. 매칭 실패분은 응답 missing 에 담긴다."),
        timeoutMs: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe('결과 대기(ms). 기본 5000.'),
      },
    },
    onStack(shared, {}, async (deps, args) => jsonContent(await runSubtitle(deps, args as SubtitleArgs))),
  );

  server.registerTool(
    'arma_tacmap_mark',
    {
      title: '전술지도 위치 표시(AHC_TacticalMap)',
      description:
        BROADCAST_POLICY_KO +
        ' 좌표를 지도에 표시한다. 마커는 인게임 지도에 즉시, 웹 전술지도에는 수집(harvest)으로 반영된다 ' +
        "(resync 기본 true 면 즉시). ping=true 면 TacMap 의 지휘관 지시 핑(자막 + 20초 마커)도 함께 " +
        '보내는데, 이건 웹 지휘관 좌석이 비어 있으면 조용히 무시되므로 이 툴이 이유를 명시해 돌려준다 ' +
        "(commanderOverride 로 빈 좌석만 임시 점유 가능, 쿨다운은 우회 불가). " +
        '전술지도 화면을 특정 좌표로 포커스하는 API 는 존재하지 않는다 — 이 툴은 표시만 한다. ' +
        '"전술지도에 위치 표시" 류 요청은 arma_exec 로 마커 SQF 를 짜지 말고 이 툴을 쓴다.',
      inputSchema: {
        stack: STACK_INPUT,
        action: z
          .enum(['add', 'remove', 'clearAll'])
          .optional()
          .describe("기본 'add'. 'remove'는 id 필수. 'clearAll'은 이 툴이 만든 mcp_mark_* 만 삭제."),
        pos: z
          .array(z.number())
          .min(2)
          .max(3)
          .optional()
          .describe("월드 좌표 [x,y] 또는 [x,y,z](m). action='add' 필수."),
        text: z.string().optional().describe('마커 라벨(64자 캡). 인게임·웹 지도에 그대로 노출.'),
        kind: z
          .enum(['icon', 'ellipse', 'rectangle'])
          .optional()
          .describe("기본 'icon'. 'ellipse'/'rectangle'은 size 로 반축을 준다."),
        iconType: z
          .string()
          .optional()
          .describe("kind='icon' 마커 타입(CfgMarkers). 기본 'mil_objective'. 예: mil_dot, mil_destroy, mil_warning."),
        color: z
          .string()
          .optional()
          .describe("마커 색 클래스(CfgMarkerColors). 기본 'ColorRed'. 예: ColorBlue, ColorGreen."),
        size: z
          .array(z.number())
          .length(2)
          .optional()
          .describe('영역 마커 [a,b] 반축 길이(m). 기본 [200,200]. 전체 지름이 아니라 HALF-axis 다.'),
        dir: z.number().optional().describe('마커 회전(도). 기본 0.'),
        brush: z
          .string()
          .optional()
          .describe("영역 마커 채움 패턴. 기본 'Border'. 예: Solid, DiagGrid, Grid."),
        ttlSec: z
          .number()
          .int()
          .min(0)
          .max(3600)
          .optional()
          .describe('자동 삭제까지의 초. 0(기본)=미션 종료까지 유지.'),
        id: z
          .string()
          .optional()
          .describe("마커 식별자(실제 이름은 'mcp_mark_<id>'). 같은 id 로 다시 부르면 덮어쓴다. 생략 시 자동."),
        ping: z
          .boolean()
          .optional()
          .describe('true 면 AHC_TacticalMap_fnc_cheatPing 도 호출(지휘관 좌석 필요, 1.5초 쿨다운).'),
        pingType: z
          .enum(['rally', 'move', 'attack', 'warn', 'recon'])
          .optional()
          .describe("핑 종류. 기본 'move'."),
        pingSide: z
          .enum(['', 'WEST', 'EAST', 'GUER', 'CIV'])
          .optional()
          .describe("핑 자막 수신 진영. 기본 ''(전체). 마커는 항상 전역."),
        commanderOverride: z
          .boolean()
          .optional()
          .describe(
            '기본 false. true 면 지휘관 좌석이 비어 있을 때만 임시 점유해 게이트를 통과하고 호출 직후 ' +
              '원상복구한다(실제 지휘관이 앉아 있으면 빼앗지 않음). 쿨다운은 우회하지 못한다.',
          ),
        resync: z
          .boolean()
          .optional()
          .describe('기본 true. TacMap resync 를 호출해 웹 지도에 즉시 반영한다.'),
        timeoutMs: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe('결과 대기(ms). 기본 5000.'),
      },
    },
    onStack(shared, {}, async (deps, args) => jsonContent(await runMark(deps, args as MarkArgs))),
  );

  server.registerTool(
    'arma_tacmap_open',
    {
      title: '웹 전술지도 열기(AHC_TacticalMap)',
      description:
        BROADCAST_POLICY_KO +
        ' AHC_TacticalMap 웹 전술지도 페이지를 플레이어들의 기본 브라우저에 연다. 주소는 게임의 CBA 설정 ' +
        'AHC_TacticalMap_host/_port 를 읽어 자동 해석한다(Host 가 비어 있으면 데몬 머신의 LAN IP 로 추정). ' +
        '"전술지도 띄워줘" 류 요청에 사용한다. @arma_mcp 모드가 없는 클라이언트에서는 열리지 않는다 ' +
        '(opened.machines 로 확인).',
      inputSchema: {
        stack: STACK_INPUT,
        mode: z
          .enum(['all', 'client'])
          .optional()
          .describe("전파 대상. 기본 'all'. 'client'면 target 필수."),
        target: z.string().optional().describe("mode='client' 대상 플레이어 이름."),
        baseUrl: z
          .string()
          .optional()
          .describe('전술지도 웹 주소 직접 지정(http/https). 자동 해석이 틀릴 때만 사용.'),
        path: z.string().optional().describe("루트 이후 경로. 기본 '/'."),
      },
    },
    onStack(shared, {}, async (deps, args) => jsonContent(await runOpen(deps, args as OpenArgs))),
  );
}
