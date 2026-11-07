// play.ts: arma-mcp play. arma_play 한 번으로 게임을 띄워 인게임까지 들어간다.
//
// 사용자가 준 플래그만 보낸다. CLI 기본값을 보내면 저장된 프로필 값을 덮기 때문이다.
// --setup 파일은 호출할 때마다 새로 읽어 then.code 로 보낸다. 재빌드 뒤 같은 줄을 다시 돌려도
// 고친 셋업이 실린다.

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEADLINE_MARGIN_MS,
  deadlineOption,
  flagOption,
  normalizeGamePath,
  normalizePathFlag,
  parseCommandArgs,
  parseDuration,
  readTextFile,
  stringListOption,
  stringOption,
  type OptionValues,
} from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import {
  busyMessage,
  execEntries,
  formatDuration,
  isRecord,
  jsonLine,
  num,
  readToolResult,
  str,
  toolExitCode,
  type Rendered,
  type ToolPayload,
} from '../render.js';

/** launchProfiles.ts 의 PROFILE_NAME_RE 와 같다. 명령줄에서 먼저 걸러 준다. */
const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** autoSlot.ts 의 ROLE_ROW_MAX, ROLE_TEXT_MAX 와 같다. */
const ROLE_ROW_MAX = 999;
const ROLE_TEXT_MAX = 64;
const READY_TIMEOUT_MIN_MS = 1000;
const READY_TIMEOUT_MAX_MS = 300_000;

/**
 * 데몬 쪽 대기 단계의 기본값(ms). launcher.ts, mpLauncher.ts, playOrchestrator.ts,
 * playFollowUps.ts 의 기본값과 같아야 한다. cli.test.ts 가 맞춰 본다.
 */
export const PLAY_PHASE_DEFAULTS = {
  sp: { waitForNewRptMs: 30_000, bridgeReadyTimeoutMs: 180_000 },
  mp: {
    serverReadyTimeoutMs: 60_000,
    bridgeReadyTimeoutMs: 120_000,
    clientConnectTimeoutMs: 180_000,
    inGameTimeoutMs: 180_000,
  },
} as const;
export const READY_DEFAULT_MS = 60_000;
export const THEN_DEFAULT_MS = 10_000;
/** --kill 이 프로세스 종료를 기다리는 몫. procs.ts 의 KILL_WAIT_MS 와 같다. */
export const KILL_RESERVE_MS = 15_000;
/** 줄여도 이 아래로는 내리지 않는다. */
const PHASE_FLOOR_MS = 1000;
/** 여유와 고정 몫을 빼고 대기 단계에 남아야 하는 최소 시간. 안내 문구의 30초와 같다. */
const PLAY_BUDGET_MIN_MS = 30_000;

const USAGE = `arma-mcp play [PROFILE] [옵션]

arma_play 한 번으로 게임을 띄워 인게임까지 들어간다. 준 옵션만 보내므로 프로필 값은 준 옵션만 덮인다.

  PROFILE                저장된 실행 프로필 이름
  --mode sp|mp           sp 는 싱글(기본), mp 는 데디 서버와 클라이언트
  --mission PATH         언팩 미션 폴더. 경로 구분자가 없는 이름은 missionsDir 아래 이름이다
  --mod PATH             모드 폴더. 여러 번 준다. 주면 프로필과 최근 RPT 대신 그 모드만 쓴다
  --mods-file FILE       모드 경로 목록 파일. 줄이나 ; 로 나누고 # 로 시작하는 줄은 건너뛴다
  --modset rpt|none      최근 RPT 의 모드를 쓰거나 모드 없이 띄운다
                         --mod 나 모드가 저장된 프로필과는 함께 쓰지 않는다
  --test-mod PATH        새로 빌드한 PBO, 작은 모드 폴더, addons 폴더. 여러 번 준다
                         스택 전용 테스트 애드온으로 복사해 붙이므로 빌드 출력이 잠기지 않는다
  --clients N            mp 에서 로컬로 붙일 클라 수(기본 --role 수, 없으면 1)
  --role ROLE            mp 에서 서버가 클라에게 배정할 역할. 여러 번 주면 클라 1, 2 순서다
                         숫자는 역할 번호(로비 목록의 역할 순서, 진영을 가로질러 0부터)
                         그 밖은 유닛 변수 이름, 없으면 역할 설명(대소문자 무시 부분 일치)
                         "" 는 서버 기본 배정이다. 주지 않은 클라도 그렇다
  --kill                이미 떠 있는 Arma 를 끝내고 띄운다
  --ready PATTERN        인게임 뒤 이번 실행의 새 RPT 에서 이 정규식을 기다린다
    --ready-source S     client(기본)나 server. server 는 mp 전용이다
    --ready-timeout 60s  ready 대기 한도(기본 60s, 1s 에서 5m 사이)
  --setup FILE           ready 뒤 실행할 SQF 파일. 호출할 때마다 새로 읽는다
  --save NAME            인게임과 ready 가 성공하면 이 이름으로 프로필을 저장한다
  --dry-run              띄우지 않고 인자만 계산한다. 미션 폴더는 실제로 만든다
  --deadline D           이 시간 안에 돌아오도록 데몬의 대기 한도를 줄여 보낸다
                         그래도 넘기면 호출을 끊는다(종료 코드 5). 게임은 그대로 둔다
                         ready 한도를 줄여야 하면 --save 와 함께 쓰지 않는다
  --json                 도구 JSON 을 한 줄로 찍는다

--stack 이름 으로 테스트 스택을 고른다(arma-mcp help 참고).
--mission, --mod, --test-mod 는 게임 기계의 경로다. 터널 연결에서는 절대 경로로 준다.
종료 코드는 인게임과 ready, then 이 모두 성공하면 0, 실패는 1, 다른 작업이 lease 를 쥐고 있으면 4 다.`;

type PlayMode = 'sp' | 'mp';

interface ReadyArgs {
  rpt: string;
  source?: 'client' | 'server';
  timeoutMs?: number;
}

/** 이 셸에서 읽은 프로필. 데몬이 병합할 값 중 CLI 가 미리 알아야 하는 것만 담는다. */
export interface LocalProfile {
  mode?: PlayMode;
  mods: string[];
  ready?: ReadyArgs;
}

export type LocalProfileLookup =
  | { state: 'found'; profile: LocalProfile }
  | { state: 'missing' }
  | { state: 'unknown'; reason: string };

export interface PlayRequest {
  args: Record<string, unknown>;
  profile?: string;
  json: boolean;
  /** --deadline. 주지 않았으면 undefined. */
  deadlineMs?: number;
}

/**
 * 프로필을 이 셸에서 읽는다. 데몬과 같은 설정 파일의 arma.profilesFile 을 본다.
 * 터널 연결이면 프로필 파일이 게임 기계에 있으므로 읽지 않는다.
 * 파일이나 이름이 없으면 missing 이다. 그때는 데몬이 없는 프로필이라고 답한다.
 */
export function lookupLocalProfile(ctx: CliContext, name: string): LocalProfileLookup {
  if (ctx.tunnel) {
    return { state: 'unknown', reason: '터널 연결이라 프로필 파일이 게임 기계에 있다' };
  }
  const cfg = ctx.config();
  const file = cfg.arma.profilesFile || path.join(os.homedir(), '.arma-mcp', 'launch-profiles.json');
  let raw: unknown;
  try {
    const text = readFileSync(file, 'utf8');
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'unknown', reason: `프로필 파일을 읽지 못했다: ${file}` };
  }
  const profiles = isRecord(raw) && isRecord(raw.profiles) ? raw.profiles : null;
  if (!profiles) return { state: 'unknown', reason: `프로필 파일 형식이 맞지 않는다: ${file}` };
  if (!Object.prototype.hasOwnProperty.call(profiles, name)) return { state: 'missing' };
  const entry = profiles[name];
  if (!isRecord(entry)) return { state: 'unknown', reason: `프로필 형식이 맞지 않는다: ${name}` };

  const profile: LocalProfile = {
    mods: Array.isArray(entry.mods) ? entry.mods.filter((m): m is string => typeof m === 'string') : [],
  };
  if (entry.mode === 'sp' || entry.mode === 'mp') profile.mode = entry.mode;
  const ready = entry.ready;
  if (isRecord(ready) && typeof ready.rpt === 'string') {
    profile.ready = { rpt: ready.rpt };
    if (ready.source === 'client' || ready.source === 'server') profile.ready.source = ready.source;
    if (Number.isFinite(num(ready.timeoutMs))) profile.ready.timeoutMs = num(ready.timeoutMs);
  }
  return { state: 'found', profile };
}

/**
 * --mods-file 내용을 모드 경로 목록으로. 줄이나 ; 로 나눈다.
 * 빈 줄과 # 이나 // 로 시작하는 줄은 건너뛴다. -mod= 로 시작하는 줄은 그 뒤를 읽는다.
 */
export function parseModsFile(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    if (/^-mod=/i.test(line)) line = line.slice('-mod='.length);
    for (const part of line.split(';')) {
      const entry = part.trim().replace(/^"(.*)"$/, '$1').trim();
      if (entry !== '') out.push(entry);
    }
  }
  return out;
}

/** 경로 구분자가 없는 이름. arma_play 는 이런 값을 missionsDir 아래 이름으로 푼다. */
function isBareName(value: string): boolean {
  return /^[^\\/:]+$/.test(value) && value !== '.' && value !== '..';
}

/**
 * --mission 값. 이름만 준 값은 이 셸의 폴더에 그 이름이 있을 때만 경로로 푼다.
 * 없으면 이름 그대로 보내 데몬이 missionsDir 에서 찾게 한다. 터널에서는 늘 이름 그대로다.
 */
function missionValue(value: string, ctx: CliContext): string {
  if (isBareName(value)) {
    if (ctx.tunnel) return value;
    const local = normalizePathFlag(value, '--mission', ctx.paths);
    return existsSync(local) ? local : value;
  }
  return normalizeGamePath(value, '--mission', ctx.gamePaths);
}

/** --role 값 하나. 숫자는 역할 번호, "" 는 서버 기본 배정(null), 그 밖은 역할 글자다. */
export function roleValue(value: string): number | string | null {
  const text = value.trim();
  if (text === '') return null;
  if (/^\d+$/.test(text)) {
    const row = Number(text);
    if (row > ROLE_ROW_MAX) throw usageError(`--role 역할 번호는 0 에서 ${ROLE_ROW_MAX} 사이다: ${text}`);
    return row;
  }
  if (text.length > ROLE_TEXT_MAX) throw usageError(`--role 글자는 ${ROLE_TEXT_MAX}자까지다: ${text}`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f"]/.test(text)) throw usageError('--role 글자에 제어 문자와 큰따옴표를 넣을 수 없다.');
  return text;
}

function checkProfileName(name: string, what: string): string {
  if (!PROFILE_NAME_RE.test(name) || name === '__proto__') {
    throw usageError(`${what} 이름이 맞지 않는다: ${name}. 영문, 숫자, _, - 로 1~40자다.`);
  }
  return name;
}

function modsFromFlags(values: OptionValues, ctx: CliContext): string[] | undefined {
  const mods: string[] = [];
  const modsFile = stringOption(values, 'mods-file');
  if (modsFile !== undefined) {
    const file = normalizePathFlag(modsFile, '--mods-file', ctx.paths);
    const entries = parseModsFile(readTextFile(file, '--mods-file'));
    if (entries.length === 0) throw usageError(`--mods-file 에 모드 경로가 없다: ${file}`);
    // 파일 안의 상대 경로는 그 파일이 있는 폴더를 기준으로 푼다.
    const base = { ...ctx.gamePaths, cwd: path.win32.dirname(file) };
    if (ctx.io.platform !== 'win32') base.cwd = path.dirname(file);
    for (const entry of entries) mods.push(normalizeGamePath(entry, '--mods-file', base));
  }
  for (const value of stringListOption(values, 'mod')) {
    mods.push(normalizeGamePath(value, '--mod', ctx.gamePaths));
  }
  return modsFile !== undefined || mods.length > 0 ? mods : undefined;
}

export interface DeadlinePlan {
  /** 보낼 대기 단계 한도. 모드에 맞는 이름만 담는다. */
  phases: Record<string, number>;
  /** ready 에 줄 한도. ready 가 없으면 undefined. */
  readyTimeoutMs?: number;
  /** 대기 단계에 나눠 준 전체 시간. */
  budgetMs: number;
}

/**
 * --deadline 안에 play 가 돌아오도록 대기 단계의 한도를 나눈다.
 * 단계는 차례로 돌기 때문에 합이 남은 시간을 넘으면 같은 비율로 줄인다.
 * 여유 5초, --kill 의 종료 대기, --setup 의 실행 한도는 먼저 떼어 둔다.
 */
export function planPlayDeadline(
  deadlineMs: number,
  opts: { mode: PlayMode; kill: boolean; readyTimeoutMs?: number; thenTimeoutMs?: number },
): DeadlinePlan {
  const reserved =
    DEADLINE_MARGIN_MS + (opts.kill ? KILL_RESERVE_MS : 0) + (opts.thenTimeoutMs ?? 0);
  const budgetMs = deadlineMs - reserved;
  if (budgetMs < PLAY_BUDGET_MIN_MS) {
    throw usageError(
      `--deadline 이 너무 짧다(${formatDuration(deadlineMs)}). ` +
        `여유 5초와 --kill, --setup 몫을 빼면 ${formatDuration(Math.max(0, budgetMs))} 남는다. ` +
        '대기 단계에는 30초 이상이 남아야 한다.',
    );
  }
  const phases: Record<string, number> = { ...PLAY_PHASE_DEFAULTS[opts.mode] };
  const all: Record<string, number> = { ...phases };
  if (opts.readyTimeoutMs !== undefined) all.ready = opts.readyTimeoutMs;
  const sum = Object.values(all).reduce((total, value) => total + value, 0);
  const factor = sum > budgetMs ? budgetMs / sum : 1;
  const fit = (value: number): number => Math.max(PHASE_FLOOR_MS, Math.floor(value * factor));
  for (const key of Object.keys(phases)) phases[key] = fit(phases[key]!);
  const plan: DeadlinePlan = { phases, budgetMs };
  if (opts.readyTimeoutMs !== undefined) plan.readyTimeoutMs = fit(opts.readyTimeoutMs);
  return plan;
}

function readyFromFlags(values: OptionValues): ReadyArgs | undefined {
  const pattern = stringOption(values, 'ready');
  const source = stringOption(values, 'ready-source');
  const timeoutText = stringOption(values, 'ready-timeout');
  if (pattern === undefined) {
    if (source !== undefined || timeoutText !== undefined) {
      throw usageError('--ready-source 와 --ready-timeout 은 --ready 와 함께 쓴다.');
    }
    return undefined;
  }
  if (pattern.trim() === '') throw usageError('--ready 정규식이 비어 있다.');
  try {
    new RegExp(pattern, 'i');
  } catch (error) {
    throw usageError(`--ready 정규식이 잘못됐다: ${(error as Error).message}`);
  }
  const ready: ReadyArgs = { rpt: pattern };
  if (source !== undefined) {
    if (source !== 'client' && source !== 'server') {
      throw usageError(`--ready-source 는 client 나 server 다: ${source}`);
    }
    ready.source = source;
  }
  if (timeoutText !== undefined) {
    const timeoutMs = parseDuration(timeoutText, '--ready-timeout');
    if (timeoutMs < READY_TIMEOUT_MIN_MS || timeoutMs > READY_TIMEOUT_MAX_MS) {
      throw usageError('--ready-timeout 은 1s 에서 5m 사이다.');
    }
    ready.timeoutMs = timeoutMs;
  }
  return ready;
}

export function parsePlayArgs(argv: string[], ctx: CliContext): PlayRequest | null {
  const { values, positionals } = parseCommandArgs('play', argv, {
    mode: { type: 'string' },
    mission: { type: 'string' },
    mod: { type: 'string', multiple: true },
    'mods-file': { type: 'string' },
    modset: { type: 'string' },
    'test-mod': { type: 'string', multiple: true },
    clients: { type: 'string' },
    role: { type: 'string', multiple: true },
    kill: { type: 'boolean' },
    ready: { type: 'string' },
    'ready-source': { type: 'string' },
    'ready-timeout': { type: 'string' },
    setup: { type: 'string' },
    save: { type: 'string' },
    'dry-run': { type: 'boolean' },
    deadline: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (flagOption(values, 'help')) return null;
  if (positionals.length > 1) {
    throw usageError(`프로필은 하나만 준다: ${positionals.join(' ')}`);
  }
  const profile =
    positionals[0] === undefined ? undefined : checkProfileName(positionals[0], '프로필');

  const args: Record<string, unknown> = {};
  if (profile !== undefined) args.profile = profile;

  const mode = stringOption(values, 'mode');
  if (mode !== undefined) {
    if (mode !== 'sp' && mode !== 'mp') throw usageError(`--mode 는 sp 나 mp 다: ${mode}`);
    args.mode = mode;
  }
  const mission = stringOption(values, 'mission');
  if (mission !== undefined) args.mission = missionValue(mission, ctx);

  const mods = modsFromFlags(values, ctx);
  const modset = stringOption(values, 'modset');
  if (modset !== undefined) {
    if (modset !== 'rpt' && modset !== 'none') {
      throw usageError(`--modset 은 rpt 나 none 이다: ${modset}`);
    }
    if (mods !== undefined) {
      throw usageError('--modset 은 --mod, --mods-file 과 함께 쓰지 않는다. --mod 를 주면 그 모드만 쓴다.');
    }
  }
  if (mods !== undefined) {
    args.mods = mods;
    // 데몬은 modset 이 없으면 rpt 로 보고 mods 를 버린다. 프로필이 없을 때도 이 목록을 쓰게 한다.
    args.modset = 'explicit';
  }

  const testMods = stringListOption(values, 'test-mod').map((value) =>
    normalizeGamePath(value, '--test-mod', ctx.gamePaths),
  );
  if (testMods.length > 0) args.testMods = testMods;
  const clientsText = stringOption(values, 'clients');
  if (clientsText !== undefined) {
    const clients = Number(clientsText);
    if (!Number.isInteger(clients) || clients < 1 || clients > 16) {
      throw usageError(`--clients 는 1 에서 16 사이 정수다: ${clientsText}`);
    }
    if (mode === 'sp') throw usageError('--clients 는 mp 에서만 쓴다.');
    args.clients = clients;
  }
  const roles = stringListOption(values, 'role').map(roleValue);
  if (roles.length > 0) {
    if (mode === 'sp') throw usageError('--role 은 mp 에서만 쓴다.');
    if (typeof args.clients === 'number' && roles.length > args.clients) {
      throw usageError(`--role 을 ${roles.length} 번 줬는데 --clients 는 ${args.clients} 다. 클라 하나에 역할 하나다.`);
    }
    args.roles = roles;
  }

  if (flagOption(values, 'kill')) args.killRunning = true;

  const ready = readyFromFlags(values);
  if (ready?.source === 'server' && mode === 'sp') {
    throw usageError('--ready-source server 는 mp 에서만 쓴다. sp 에는 서버 RPT 가 없다.');
  }

  const setup = stringOption(values, 'setup');
  if (setup !== undefined) {
    const file = normalizePathFlag(setup, '--setup', ctx.paths);
    const code = readTextFile(file, '--setup');
    if (code.trim() === '') throw usageError(`--setup 파일이 비어 있다: ${file}`);
    args.then = { code };
  }

  const save = stringOption(values, 'save');
  if (save !== undefined) args.saveProfile = checkProfileName(save, '--save 프로필');
  if (flagOption(values, 'dry-run')) args.dryRun = true;

  // 프로필 내용이 필요한 검사만 프로필 파일을 읽는다.
  const deadlineMs = deadlineOption(values);
  const needsProfile = profile !== undefined && (modset !== undefined || deadlineMs !== undefined);
  const lookup = needsProfile ? lookupLocalProfile(ctx, profile!) : undefined;

  if (modset !== undefined) {
    if (lookup?.state === 'found' && lookup.profile.mods.length > 0) {
      throw usageError(
        `프로필 ${profile} 에는 모드 ${lookup.profile.mods.length}개가 저장돼 있어 --modset 과 함께 쓰지 않는다. ` +
          '모드를 바꾸려면 --mod 나 --mods-file 로 준다.',
      );
    }
    if (lookup?.state === 'unknown') {
      throw usageError(
        `프로필 ${profile} 에 모드가 저장돼 있는지 확인하지 못해 --modset 과 함께 쓰지 않는다(${lookup.reason}). ` +
          '모드는 --mod 나 --mods-file 로 준다.',
      );
    }
    args.modset = modset;
  }

  let readyToSend = ready;
  if (deadlineMs !== undefined) {
    const found = lookup?.state === 'found' ? lookup.profile : undefined;
    let playMode: PlayMode | undefined = mode as PlayMode | undefined;
    if (playMode === undefined && profile !== undefined) {
      if (lookup?.state === 'unknown') {
        throw usageError(
          `--deadline 은 모드마다 대기 단계가 달라 프로필의 mode 를 알아야 한다. ` +
            `프로필 ${profile} 의 내용을 읽지 못했다(${lookup.reason}). --mode 를 함께 준다.`,
        );
      }
      playMode = found?.mode;
    }
    playMode ??= 'sp';
    // 프로필의 ready 도 한도를 줄여야 한다. 데몬이 병합할 때와 같은 조건으로 고른다.
    let readyToFit = readyToSend;
    if (readyToFit === undefined && found?.ready) {
      const fits = found.ready.source !== 'server' || playMode === 'mp';
      if (fits) readyToFit = found.ready;
    }
    const readyMs =
      readyToFit === undefined ? undefined : (readyToFit.timeoutMs ?? READY_DEFAULT_MS);
    const plan = planPlayDeadline(deadlineMs, {
      mode: playMode,
      kill: args.killRunning === true,
      readyTimeoutMs: readyMs,
      thenTimeoutMs: args.then === undefined ? undefined : THEN_DEFAULT_MS,
    });
    Object.assign(args, plan.phases);
    // 줄인 ready 는 명시 인자로 간다. 데몬은 저장할 때 명시 ready 를 그대로 싣는다.
    // 그래서 줄인 한도가 프로필에 남지 않도록 --save 와 함께 쓰지 않는다.
    if (readyToFit !== undefined && readyMs !== undefined && plan.readyTimeoutMs !== undefined) {
      if (plan.readyTimeoutMs < readyMs) {
        if (args.saveProfile !== undefined) {
          throw usageError(
            `--deadline 이 ready 한도를 ${formatDuration(readyMs)}에서 ` +
              `${formatDuration(plan.readyTimeoutMs)}로 줄인다. ` +
              '이대로 --save 하면 줄인 한도가 프로필에 남는다. ' +
              '프로필을 저장하는 실행에서는 --deadline 을 뺀다.',
          );
        }
        readyToSend = { ...readyToFit, timeoutMs: plan.readyTimeoutMs };
      }
    }
  }
  if (readyToSend !== undefined) args.ready = readyToSend;

  return { args, profile, json: flagOption(values, 'json'), deadlineMs };
}

function inGameMs(result: Record<string, unknown>): number {
  const steps = Array.isArray(result.steps) ? result.steps.filter(isRecord) : [];
  let total = 0;
  for (const step of steps) {
    const elapsed = num(step.elapsedMs);
    if (Number.isFinite(elapsed)) total += elapsed;
    if (step.name === 'inGame') break;
  }
  return total > 0 ? total : num(result.totalMs);
}

function launchDetail(result: Record<string, unknown>, mode: string): string {
  const launch = isRecord(result.launch) ? result.launch : {};
  const mission = isRecord(result.mission) ? result.mission : {};
  const parts: string[] = [];
  if (str(mission.world)) parts.push(str(mission.world));
  if (Number.isFinite(num(launch.modCount))) parts.push(`${num(launch.modCount)} mods`);
  const client = isRecord(launch.client) ? launch.client : {};
  const pid = mode === 'mp' ? num(client.pid) : num(launch.pid);
  if (Number.isFinite(pid)) parts.push(`pid ${pid}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function rptLine(rpt: unknown): string | null {
  if (!isRecord(rpt)) return null;
  const parts: string[] = [];
  const keys = ['client', 'server'].filter((key) => isRecord(rpt[key]));
  for (const key of keys) {
    const summary = rpt[key] as Record<string, unknown>;
    const count = str(summary.error) ? '읽지 못함' : String(num(summary.errorBlocks));
    parts.push(keys.length > 1 ? `${key} ${count}` : count);
  }
  return parts.length > 0 ? `rpt errors ${parts.join(', ')}` : null;
}

/**
 * 클라마다 로비 자동 배정 결과 한 줄. dry-run 은 지정을, 실행은 상태와 서버에서 읽은 역할을 적는다.
 * 자동 배정을 끈 실행은 줄이 없다.
 * 예: slot 1 assigned "OPFOR Rifleman", 2 assigned "Alpha Rifleman"
 */
function slotLine(autoSlot: unknown, dryRun: boolean): string | null {
  if (!isRecord(autoSlot) || autoSlot.requested !== true || !Array.isArray(autoSlot.clients)) return null;
  const parts = autoSlot.clients.filter(isRecord).map((c) => {
    if (dryRun) return `${num(c.index)} ${str(c.requested)}`;
    const role = typeof c.role === 'string' ? ` ${JSON.stringify(c.role)}` : '';
    return `${num(c.index)} ${str(c.state)}${role}`;
  });
  return parts.length > 0 ? `slot ${parts.join(', ')}` : null;
}

/** arma_play 결과를 몇 줄로. 성공 줄은 stdout, 실패 사유와 경고는 stderr 로 나눈다. */
export function renderPlay(result: Record<string, unknown>, profile?: string): Rendered {
  const out: Rendered = { stdout: [], stderr: [] };
  // 프로필 오류처럼 실행 전에 멈춘 결과에는 단계가 없다.
  if (typeof result.phase !== 'string') {
    out.stderr.push(`play 실패: ${str(result.error) || '결과 없음'}`);
    return out;
  }
  const mode = str(result.mode) || 'sp';
  const head = `play${profile ? ` ${profile}` : ''} ${mode}:`;
  const detail = launchDetail(result, mode);
  const launch = isRecord(result.launch) ? result.launch : {};

  if (result.dryRun === true) {
    out.stdout.push(`${head} dry-run${detail}`);
    if (mode === 'mp') {
      if (isRecord(launch.server) && str(launch.server.argString)) {
        out.stdout.push(`server ${str(launch.server.argString)}`);
      }
      if (isRecord(launch.client) && str(launch.client.argString)) {
        out.stdout.push(`client ${str(launch.client.argString)}`);
      }
    } else if (str(launch.argString)) {
      out.stdout.push(`args ${str(launch.argString)}`);
    }
  } else if (isRecord(result.inGame) && result.inGame.confirmed === true) {
    out.stdout.push(`${head} in-game ${formatDuration(inGameMs(result))}${detail}`);
  } else {
    out.stdout.push(
      `${head} 실패(${str(result.phase)}) ${formatDuration(num(result.totalMs))}${detail}`,
    );
  }

  const slot = slotLine(result.autoSlot, result.dryRun === true);
  if (slot) out.stdout.push(slot);

  const ready = isRecord(result.ready) ? result.ready : null;
  if (ready) {
    const label = `ready "${str(ready.pattern)}"`;
    if (ready.ok === true) out.stdout.push(`${label} ${formatDuration(num(ready.elapsedMs))}`);
    else if (ready.skipped === true) out.stdout.push(`${label} 건너뜀: ${str(ready.reason)}`);
    else out.stdout.push(`${label} 실패: ${str(ready.reason) || '사유 미상'}`);
  }
  const rpt = rptLine(result.rpt);
  if (rpt) out.stdout.push(rpt);

  const then = isRecord(result.then) ? result.then : null;
  if (then) {
    const exec = isRecord(then.exec) ? then.exec : null;
    const entries = exec ? execEntries(exec) : [];
    for (const entry of entries) {
      out.stdout.push(entries.length > 1 ? `then ${entry.machine}: ${entry.result}` : `then ${entry.result}`);
    }
    if (then.skipped === true) out.stdout.push(`then 건너뜀: ${str(then.reason)}`);
    else if (then.ok !== true) {
      out.stderr.push(`then 실패: ${str(then.reason) || str(exec?.error) || '결과가 오류다'}`);
    }
  }

  const section = isRecord(result.profile) ? result.profile : null;
  if (section && str(section.saved)) out.stdout.push(`profile ${str(section.saved)} 저장`);
  if (section && str(section.notSaved)) out.stderr.push(`프로필을 저장하지 않았다: ${str(section.notSaved)}`);

  if (result.ok === false) {
    out.stderr.push(`play 실패: ${str(result.error) || '사유 미상'}`);
    if (str(result.nextSteps)) out.stderr.push(str(result.nextSteps));
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String) : [];
  for (const warning of warnings) out.stderr.push(`경고: ${warning}`);
  return out;
}

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const startedAt = Date.now();
  const request = parsePlayArgs(argv, ctx);
  if (!request) {
    ctx.out(USAGE);
    return EXIT.ok;
  }

  return ctx.withSession(async (session) => {
    // --deadline 은 데몬 쪽 한도를 줄여 보내지만, 합이 어긋나도 이 시각에는 호출을 끊는다.
    // 요청 취소가 데몬의 play 를 멈추고 lease 를 푼다. 떠 있는 게임은 그대로 남는다.
    const callTimeoutMs =
      request.deadlineMs === undefined
        ? undefined
        : Math.max(1000, request.deadlineMs - (Date.now() - startedAt));
    let payload: ToolPayload;
    try {
      payload = readToolResult(
        await session.call('arma_play', request.args, { timeoutMs: callTimeoutMs }),
      );
    } catch (error) {
      if (request.deadlineMs !== undefined && error instanceof CliError && error.exitCode === EXIT.timeout) {
        throw new CliError(
          EXIT.timeout,
          `--deadline ${formatDuration(request.deadlineMs)} 안에 play 가 끝나지 않아 호출을 끊었다. ` +
            '떠 있는 게임은 그대로 두었다. arma-mcp status 로 상태를 본다.',
        );
      }
      throw error;
    }
    if (payload.isError || !isRecord(payload.json)) {
      ctx.err(`arma_play 실패: ${payload.text}`);
      return EXIT.failure;
    }
    const result = payload.json;
    const code = toolExitCode(payload);
    if (request.json) ctx.out(jsonLine(payload));
    if (code === EXIT.busy) {
      ctx.err(busyMessage(result, '띄우지 않았다')!);
      return code;
    }
    const rendered = renderPlay(result, request.profile);
    if (!request.json) for (const line of rendered.stdout) ctx.out(line);
    for (const line of rendered.stderr) ctx.err(line);
    return code;
  });
}

export const playCommand: CliCommand = {
  name: 'play',
  summary: '게임을 띄워 인게임까지 들어간다(arma_play)',
  usage: USAGE,
  run,
};
