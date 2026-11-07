// autoSlot.ts — mp 로비 역할 자동 배정. 데몬이 만드는 server.cfg 의 skipLobby 와 OnAutoSelectRole 훅.
//
// 클라 SQF 로는 로비 슬롯을 잡을 수 없다(2.22 실측과 엔진 분석). lbSetCurSel 은 선택만 옮기고,
// 배정 요청은 역할 목록 더블클릭과 Space 에서만 나간다. 그래서 서버가 배정한다.
//
// server.cfg 에 skipLobby = 1 이 있으면 서버는 접속한 클라를 바로 역할에 넣는다. 그때 2.22 의
// OnAutoSelectRole 훅을 부르고, 훅이 돌려준 숫자를 역할 번호로 쓴다. 숫자가 아니면 기본 배정(사람이
// 가장 적은 진영의 첫 빈 슬롯)이다. 클라는 로비 대신 로딩 화면을 보고, 배정되면 OK 를 스스로 누른다.
// -autoInit 미션은 이미 돌고 있어 브리핑 화면 없이 들어간다.
//
// 훅은 서버 전용 GameState 에서 돈다. params, format, isEqualTo 가 없으므로 ==, select, forEach,
// findIf, typeName, toLower, find, +, str, diag_log, getRoles, getUserInfo 만 쓴다.
// 미션 description.ext 가 skipLobby 를 정하면 그 값이 server.cfg 보다 앞선다.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 역할 글자의 최대 길이. */
export const ROLE_TEXT_MAX = 64;
/** 역할 번호의 상한. 로비 역할 목록이 이보다 길 일은 없다. */
export const ROLE_ROW_MAX = 999;

/**
 * 로비에서 잡을 역할 하나. 수는 역할 번호(getRoles 순서, 로비 역할 행의 lbValue, 0부터)다.
 * 글자는 유닛 변수 이름과 정확히 같은 빈 슬롯, 없으면 역할 설명에 대소문자 무시 부분 일치하는 빈 슬롯이다.
 * null 은 서버 기본 배정이다.
 */
export type PlayRole = number | string | null;

/** 훅이 클라 이름으로 찾는 지정 하나. 이름 '' 은 다른 지정에 없는 이름의 클라다. */
export interface AutoSlotEntry {
  name: string;
  role: number | string;
}

/** 훅이 서버 RPT 에 남기는 줄의 머리. */
export const AUTO_SELECT_LOG = '[ArmaMCP] autoSelectRole';
/** 엔진이 훅의 숫자를 못 쓸 때 남기는 줄(찬 슬롯, 없는 번호). 그 뒤 기본 배정으로 간다. */
export const ON_SELECT_ROLE_ERROR = 'Error, OnSelectRole';

/** 역할 하나가 쓸 수 없는 값이면 이유를 돌려준다. */
export function roleProblem(role: PlayRole): string | null {
  if (role === null) return null;
  if (typeof role === 'number') {
    return Number.isInteger(role) && role >= 0 && role <= ROLE_ROW_MAX
      ? null
      : `역할 번호는 0 에서 ${ROLE_ROW_MAX} 사이 정수다: ${role}`;
  }
  const text = role.trim();
  if (text.length === 0) return '역할 글자가 비어 있다. 서버 기본 배정은 null 로 준다';
  if (text.length > ROLE_TEXT_MAX) return `역할 글자는 ${ROLE_TEXT_MAX}자까지다: ${text.slice(0, 20)}…`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(text)) return '역할 글자에 제어 문자와 큰따옴표를 넣을 수 없다';
  return null;
}

/** roles 와 clients 가 함께 맞는지 본다. 게임을 띄우기 전에 거른다. */
export function rolesProblem(roles: readonly PlayRole[] | undefined, clients: number | undefined): string | null {
  if (!roles || roles.length === 0) return null;
  if (clients !== undefined && roles.length > clients) {
    return `roles 는 ${roles.length} 개인데 clients 는 ${clients} 다. 클라 하나에 역할 하나다`;
  }
  for (const [i, role] of roles.entries()) {
    const problem = roleProblem(role);
    if (problem) return `roles[${i}]: ${problem}`;
  }
  return null;
}

/** 결과와 CLI 에 보일 지정 글. */
export function roleSpecText(role: PlayRole): string {
  if (role === null) return 'auto';
  return typeof role === 'number' ? `#${role}` : role.trim();
}

/** SQF 작은따옴표 문자열. server.cfg 의 큰따옴표 안에 그대로 넣을 수 있다. */
function sqfString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/**
 * OnAutoSelectRole 훅 코드. _this 는 [플레이어 이름, 플레이어 id 문자열] 이다(2.22 실측).
 *
 * 클라 이름은 getUserInfo 의 3번(-name 프로필 이름)이다. 한 PC 의 클라는 Steam ID 가 같아 이름으로 가린다.
 * 찾으면 역할 번호를, 못 찾으면 아무 값도 돌려주지 않아 기본 배정에 맡긴다. -1 은 돌려주지 않는다
 * (skipLobby 클라가 로딩 화면에서 멈춘다). 매 호출 결과를 서버 RPT 에 한 줄 남긴다.
 * getRoles 원소는 [진영, 그룹 id, 유닛 id, 클래스, bool, 차지한 플레이어 id(빈 슬롯은 ""), 역할 설명, 유닛 변수 이름, 플래그]
 * 다(2.22 실측). 이름을 _this 0번 대신 getUserInfo 로 읽는 까닭은 엔진 분석이 그 칸을 -name 으로 확정했기 때문이다.
 */
export function buildAutoSelectRoleHook(entries: readonly AutoSlotEntry[]): string {
  const want = entries
    .map((e) => `[${sqfString(e.name)}, ${typeof e.role === 'number' ? String(e.role) : sqfString(e.role.trim())}]`)
    .join(', ');
  return [
    `private _want = [${want}];`,
    "private _who = _this select 0; if (!(typeName _who == 'STRING')) then { _who = str _who };",
    "private _info = getUserInfo (_this select 1); private _name = ''; if (count _info > 3) then { _name = _info select 3 };",
    'private _spec = 0; private _has = false;',
    '{ if (!_has && ((_x select 0) == _name)) then { _spec = _x select 1; _has = true } } forEach _want;',
    "if (!_has) then { { if (!_has && ((_x select 0) == '')) then { _spec = _x select 1; _has = true } } forEach _want };",
    "private _roles = getRoles; private _pick = -1; private _how = 'none';",
    'if (_has) then {',
    "if (typeName _spec == 'SCALAR') then { _pick = _spec; _how = 'number' } else {",
    "_pick = _roles findIf { ((_x select 7) == _spec) && ((_x select 5) == '') };",
    "if (_pick >= 0) then { _how = 'var' } else {",
    'private _lw = toLower _spec;',
    "_pick = _roles findIf { ((_x select 5) == '') && (((toLower (_x select 6)) find _lw) >= 0) };",
    "if (_pick >= 0) then { _how = 'desc' } else { _how = 'nomatch' } } } };",
    "private _desc = ''; if ((_pick >= 0) && (_pick < count _roles)) then { _desc = (_roles select _pick) select 6 };",
    `diag_log ('${AUTO_SELECT_LOG}|pick=' + str _pick + '|match=' + _how + '|role=' + _desc + '|who=' + _who + '|name=' + _name);`,
    // 못 찾았으면 무엇과 비교했는지 남긴다.
    `if (_how == 'nomatch') then { diag_log ('${AUTO_SELECT_LOG}|roles=' + str _roles) };`,
    'if (_pick >= 0) then { _pick }',
  ].join(' ');
}

/** server.cfg 에 넣을 두 줄. buildServerCfg 가 큰따옴표를 겹쳐 쓰지만 훅에는 큰따옴표가 없다. */
export function autoSlotCfgLines(entries: readonly AutoSlotEntry[]): string[] {
  return ['skipLobby = 1;', `OnAutoSelectRole = "${buildAutoSelectRoleHook(entries)}";`];
}

/** 설정의 extraCfgLines 가 이미 정한 자동 배정 줄. 있으면 데몬은 제 줄을 넣지 않는다(같은 키 두 번은 server.cfg 오류). */
export function userAutoSlotLines(extraCfgLines: readonly string[] | undefined): string[] {
  return (extraCfgLines ?? []).filter((l) => /^\s*(skipLobby|OnAutoSelectRole)\s*=/i.test(l));
}

/**
 * 클라 i 의 지정을 훅 항목으로. 이름을 모르는 클라(default 스택 클라 1)는 이름 '' 이다.
 * 지정이 없는 클라는 항목이 없어 기본 배정이다.
 */
export function autoSlotEntries(
  roles: readonly PlayRole[],
  clientCount: number,
  nameOf: (index: number) => string | null,
): AutoSlotEntry[] {
  const out: AutoSlotEntry[] = [];
  for (let i = 1; i <= clientCount; i++) {
    const role = roles[i - 1] ?? null;
    if (role === null) continue;
    out.push({ name: nameOf(i) ?? '', role: typeof role === 'string' ? role.trim() : role });
  }
  return out;
}

/** 훅이 남긴 한 줄. pick 은 -1 이면 기본 배정에 맡긴 것이다. */
export interface AutoSelectLogLine {
  pick: number;
  match: 'number' | 'var' | 'desc' | 'nomatch' | 'none' | string;
  /** 훅이 고른 역할 번호의 설명. 못 골랐으면 ''. */
  role: string;
  /** _this 의 첫 원소. 2.22 실측으로 플레이어 이름이다. */
  who: string;
  name: string;
  line: string;
}

/** 서버 RPT 의 훅 줄을 읽는다. diag_log 가 줄을 따옴표로 감싸 찍은 모양도 받는다. */
export function parseAutoSelectLines(lines: readonly string[]): AutoSelectLogLine[] {
  const out: AutoSelectLogLine[] = [];
  for (const raw of lines) {
    const at = raw.indexOf(AUTO_SELECT_LOG + '|');
    if (at < 0) continue;
    let body = raw.slice(at + AUTO_SELECT_LOG.length + 1).trimEnd();
    if (at > 0 && raw[at - 1] === '"') body = body.replace(/"$/, '').replace(/""/g, '"');
    const fields = new Map<string, string>();
    for (const part of body.split('|')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
    }
    const pick = Number(fields.get('pick'));
    out.push({
      pick: Number.isFinite(pick) ? pick : -1,
      match: fields.get('match') ?? 'none',
      role: fields.get('role') ?? '',
      who: fields.get('who') ?? '',
      name: fields.get('name') ?? '',
      line: raw.trim(),
    });
  }
  return out;
}

/**
 * 미션 description.ext 가 정한 skipLobby. 정하지 않았으면 undefined 다.
 * 0 이면 server.cfg 의 skipLobby 와 훅이 무시되어 로비에서 사람이 골라야 한다.
 */
export function missionSkipLobby(missionDir: string | undefined): number | undefined {
  if (!missionDir) return undefined;
  const file = path.join(missionDir, 'description.ext');
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = /(?:^|[\s;{}])skipLobby\s*=\s*(\d+)\s*;/i.exec(text);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** 서버에서 읽은 플레이어 하나. */
export interface ServerPlayer {
  name: string;
  roleDescription: string;
  type: string;
  side: string;
  varName: string;
}

/** 플레이어를 읽는 서버 SQF. 결과는 [[name, roleDescription, typeOf, side, vehicleVarName], ...] 다. */
export const READ_PLAYERS_SQF =
  "(allPlayers - (entities 'HeadlessClient_F')) apply { [name _x, roleDescription _x, typeOf _x, str side _x, vehicleVarName _x] }";

/**
 * SQF str 로 찍은 배열 글을 읽는다. 문자열 안의 따옴표는 "" 로 겹쳐 찍힌다.
 * 문자열과 수와 배열만 다룬다. 읽지 못하면 null 이다.
 */
export function parseSqfArray(text: string): unknown[] | null {
  let json = '';
  let i = 0;
  const s = text.trim();
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === '"') {
      let str = '';
      i++;
      for (;;) {
        if (i >= s.length) return null;
        if (s[i] === '"') {
          if (s[i + 1] === '"') {
            str += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        str += s[i];
        i++;
      }
      json += JSON.stringify(str);
      continue;
    }
    json += ch;
    i++;
  }
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** READ_PLAYERS_SQF 결과를 플레이어 목록으로. */
export function parseServerPlayers(text: string): ServerPlayer[] | null {
  const arr = parseSqfArray(text);
  if (!arr) return null;
  const out: ServerPlayer[] = [];
  for (const row of arr) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [name, roleDescription, type, side, varName] = row.map((v) => (typeof v === 'string' ? v : String(v)));
    out.push({ name: name!, roleDescription: roleDescription!, type: type!, side: side!, varName: varName! });
  }
  return out;
}
