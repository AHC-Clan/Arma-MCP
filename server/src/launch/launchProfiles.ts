// launchProfiles.ts — arma_play 실행 프로필.
//
// 재실행 사이클마다 미션 경로와 모드 목록을 다시 적지 않게, 성공한 실행에서 실제로 쓴 값을
// 이름을 붙여 저장하고 다음 호출에서 profile 이름 하나로 불러온다.
//
// 저장하는 값은 해석이 끝난 값이다. modset='rpt' 로 띄웠어도 그때 RPT 헤더에서 읽은 모드
// 목록을 적는다. 즉석 생성 미션은 공유 스캐폴드 폴더가 다음 호출에 덮이므로 경로 대신
// 스캐폴드 인자를 적는다. killRunning, password, then 은 적지 않는다. 앞의 둘은 매번
// 의도를 확인해야 하는 값이고, then 은 호출마다 달라지는 셋업 코드다.
//
// 우선순위는 명시 인자, 프로필, 기본값 순이다.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import { resolveStacksRoot } from '../config.js';
import { stripStackMods } from './mods.js';
import type { MpLaunchResult } from './mpLauncher.js';
import type { PlayMode, PlayResult } from './playOrchestrator.js';
import type { PlayRole } from './autoSlot.js';
import { SAFE_SPAWN_MODES, type SafeSpawnMode } from './safeSpawn.js';

/** 프로필 이름. 파일 키와 CLI 인자로 쓰이므로 경로 문자와 공백을 받지 않는다. */
export const PROFILE_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;

export const READY_TIMEOUT_MIN_MS = 1000;
export const READY_TIMEOUT_MAX_MS = 300000;

const ReadySchema = z.object({
  rpt: z.string().min(1),
  source: z.enum(['client', 'server']).optional(),
  timeoutMs: z.number().int().min(READY_TIMEOUT_MIN_MS).max(READY_TIMEOUT_MAX_MS).optional(),
});

const ScaffoldSchema = z.object({
  world: z.string().optional(),
  name: z.string().optional(),
  playerType: z.string().optional(),
  position: z.array(z.number()).min(2).max(3).optional(),
  safeSpawn: z.enum(SAFE_SPAWN_MODES).optional(),
  initSqf: z.string().optional(),
});

// z.object 는 모르는 키를 버린다. 손으로 고친 파일에 password 가 들어 있어도 읽지 않는다.
const ProfileSchema = z.object({
  mode: z.enum(['sp', 'mp']),
  mission: z.string().optional(),
  scaffold: ScaffoldSchema.optional(),
  mods: z.array(z.string()).optional(),
  modset: z.enum(['rpt', 'explicit', 'none']).optional(),
  clientExtraArgs: z.array(z.string()).optional(),
  serverExtraArgs: z.array(z.string()).optional(),
  port: z.number().int().positive().optional(),
  autoSlot: z.boolean().optional(),
  roles: z.array(z.union([z.number().int().min(0), z.string().min(1), z.null()])).optional(),
  clients: z.number().int().min(1).max(16).optional(),
  testMods: z.array(z.string()).optional(),
  ready: ReadySchema.optional(),
  savedAt: z.string(),
});

const ProfilesFileSchema = z.object({
  v: z.literal(1),
  profiles: z.record(
    z.string().refine(isProfileName, { message: '프로필 이름이 맞지 않는다' }),
    ProfileSchema,
  ),
});

export type ProfileReady = z.infer<typeof ReadySchema>;
export type ProfileScaffold = z.infer<typeof ScaffoldSchema>;
export type LaunchProfile = z.infer<typeof ProfileSchema>;
export type LaunchProfilesFile = z.infer<typeof ProfilesFileSchema>;

/** arma_play 인자 중 프로필이 채우는 것. */
export interface ProfileArgs {
  mode?: PlayMode;
  mission?: string;
  modset?: 'rpt' | 'explicit' | 'none';
  mods?: string[];
  clientExtraArgs?: string[];
  serverExtraArgs?: string[];
  port?: number;
  autoSlot?: boolean;
  roles?: PlayRole[];
  clients?: number;
  testMods?: string[];
  world?: string;
  name?: string;
  playerType?: string;
  position?: readonly number[];
  safeSpawn?: SafeSpawnMode;
  initSqf?: string;
  ready?: ProfileReady;
}

const SCAFFOLD_KEYS = ['world', 'name', 'playerType', 'position', 'safeSpawn', 'initSqf'] as const;

/** arma.profilesFile 이 비어 있으면 ~/.arma-mcp/launch-profiles.json 으로 해석. */
export function resolveLaunchProfilesFile(cfg: Config): string {
  if (cfg.arma.profilesFile) return cfg.arma.profilesFile;
  return path.join(homedir(), '.arma-mcp', 'launch-profiles.json');
}

/** __proto__ 는 정규식을 통과하지만 객체 키로 쓰면 프로토타입을 바꾼다. 따로 막는다. */
export function isProfileName(name: string): boolean {
  return PROFILE_NAME_RE.test(name) && name !== '__proto__';
}

function emptyFile(): LaunchProfilesFile {
  return { v: 1, profiles: {} };
}

/**
 * 프로필 파일을 읽는다. 파일이 없으면 빈 목록이다.
 * 깨졌거나 형식이 틀리면 파일 경로를 담아 던진다. 저장하다 남의 프로필을 지우지 않기 위해서다.
 */
export async function loadLaunchProfiles(file: string): Promise<LaunchProfilesFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    throw new Error(`프로필 파일을 읽지 못했다: ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw new Error(`프로필 파일이 깨졌다: ${file}: ${(e as Error).message}`);
  }
  const parsed = ProfilesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    throw new Error(
      `프로필 파일 형식이 맞지 않는다: ${file}: ${where}${issue?.message ?? parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** 이름으로 프로필을 찾는다. 상속된 속성(constructor 등)은 프로필이 아니다. */
export function findProfile(data: LaunchProfilesFile, name: string): LaunchProfile | undefined {
  return Object.prototype.hasOwnProperty.call(data.profiles, name)
    ? data.profiles[name]
    : undefined;
}

export async function listProfileNames(file: string): Promise<string[]> {
  const data = await loadLaunchProfiles(file);
  return Object.keys(data.profiles).sort();
}

/** 테스트에서 rename 실패를 흉내 내려고 바꿔 끼운다. */
export interface ProfileSaveIo {
  rename?: (from: string, to: string) => Promise<void>;
}

/**
 * 프로필 하나를 저장한다. 같은 폴더의 임시 파일에 다 쓴 뒤 rename 으로 바꾼다.
 * 쓰다가 멈춰도 원래 파일은 그대로다.
 */
// 스택이 여럿이면 두 세션이 동시에 저장할 수 있다. 읽고 고치고 쓰는 사이에 서로의 항목을
// 지우지 않게 이 프로세스 안에서 한 줄로 세운다.
let saveQueue: Promise<unknown> = Promise.resolve();

export function saveLaunchProfile(
  file: string,
  name: string,
  profile: LaunchProfile,
  io: ProfileSaveIo = {},
): Promise<void> {
  const next = saveQueue.then(
    () => saveLaunchProfileNow(file, name, profile, io),
    () => saveLaunchProfileNow(file, name, profile, io),
  );
  saveQueue = next.catch(() => {});
  return next;
}

async function saveLaunchProfileNow(
  file: string,
  name: string,
  profile: LaunchProfile,
  io: ProfileSaveIo,
): Promise<void> {
  if (!isProfileName(name)) {
    throw new Error(`프로필 이름이 맞지 않는다: "${name}". 영문, 숫자, _, - 로 1~40자다.`);
  }
  const clean = ProfileSchema.parse(profile);
  const data = await loadLaunchProfiles(file);
  data.profiles[name] = clean;

  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    await (io.rename ?? rename)(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 명시 인자 위에 프로필을 얹는다. 인자에 값이 있으면 그 값이 이긴다.
 *
 * mission 을 주었거나 스캐폴드 인자를 하나라도 주었으면 프로필의 미션 경로는 쓰지 않는다.
 * 프로필에 mods 가 있거나 호출이 mods 를 주었으면 modset 은 explicit 이다.
 */
export function mergeProfile<T extends ProfileArgs>(
  args: T,
  profile: LaunchProfile,
): T & ProfileArgs {
  const out: ProfileArgs = { ...args };
  if (out.mode === undefined) out.mode = profile.mode;

  const explicitScaffold = SCAFFOLD_KEYS.some((k) => args[k] !== undefined);
  if (args.mission === undefined) {
    if (profile.mission !== undefined && !explicitScaffold) {
      out.mission = profile.mission;
    } else if (profile.scaffold) {
      const sc = profile.scaffold;
      if (out.world === undefined && sc.world !== undefined) out.world = sc.world;
      if (out.name === undefined && sc.name !== undefined) out.name = sc.name;
      if (out.playerType === undefined && sc.playerType !== undefined) out.playerType = sc.playerType;
      if (out.position === undefined && sc.position !== undefined) out.position = [...sc.position];
      if (out.safeSpawn === undefined && sc.safeSpawn !== undefined) out.safeSpawn = sc.safeSpawn;
      if (out.initSqf === undefined && sc.initSqf !== undefined) out.initSqf = sc.initSqf;
    }
  }

  if (out.mods === undefined && profile.mods !== undefined) out.mods = [...profile.mods];
  if (out.modset === undefined) {
    if (args.mods !== undefined || (profile.mods?.length ?? 0) > 0) out.modset = 'explicit';
    else if (profile.modset !== undefined) out.modset = profile.modset;
  }

  if (out.clientExtraArgs === undefined && profile.clientExtraArgs !== undefined) {
    out.clientExtraArgs = [...profile.clientExtraArgs];
  }
  if (out.testMods === undefined && profile.testMods !== undefined) {
    out.testMods = [...profile.testMods];
  }
  // mp 프로필을 sp 로 부르면 mp 전용 값은 얹지 않는다. 얹으면 호출자가 주지 않은 인자가
  // "무시된 인자" 경고로 나온다.
  if (out.mode === 'mp') {
    if (out.serverExtraArgs === undefined && profile.serverExtraArgs !== undefined) {
      out.serverExtraArgs = [...profile.serverExtraArgs];
    }
    if (out.port === undefined && profile.port !== undefined) out.port = profile.port;
    if (out.autoSlot === undefined && profile.autoSlot !== undefined) {
      out.autoSlot = profile.autoSlot;
    }
    if (out.roles === undefined && profile.roles !== undefined) out.roles = [...profile.roles];
    if (out.clients === undefined && profile.clients !== undefined) out.clients = profile.clients;
  }
  // 서버 RPT 를 보는 ready 도 mp 전용 값이다. sp 로 부르면 호출자가 주지 않은 인자로 실패한다.
  const readyFits = profile.ready?.source !== 'server' || out.mode === 'mp';
  if (out.ready === undefined && profile.ready !== undefined && readyFits) {
    out.ready = { ...profile.ready };
  }
  return out as T & ProfileArgs;
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(a) === normalize(b);
}

/** 런처가 늘 붙이는 selfModPath 는 저장하지 않는다. 설정이 바뀌면 새 경로가 붙어야 한다. */
export function stripSelfMod(cfg: Config, mods: readonly string[]): string[] {
  const self = cfg.arma.selfModPath;
  return self ? mods.filter((m) => !samePath(m, self)) : [...mods];
}

/** 주어진 미션의 절대경로. 런처와 같은 규칙으로 푼다. */
function resolvedMissionPath(cfg: Config, result: PlayResult): string {
  if (result.mode === 'mp') {
    const source = (result.launch as MpLaunchResult | undefined)?.mission?.source;
    if (source) return path.resolve(source);
  }
  const ref = result.mission.ref;
  if (path.isAbsolute(ref) || /[\\/]/.test(ref) || !cfg.arma.missionsDir) {
    return path.resolve(ref);
  }
  return path.resolve(cfg.arma.missionsDir, ref);
}

/**
 * 성공한 실행에서 저장할 프로필을 만든다.
 * opts 는 프로필을 얹은 뒤의 인자이고, 미션과 모드는 result 의 해석된 값을 쓴다.
 */
export function profileFromPlay(
  cfg: Config,
  opts: ProfileArgs,
  result: PlayResult,
  now: Date = new Date(),
): LaunchProfile {
  const profile: LaunchProfile = { mode: result.mode, savedAt: now.toISOString() };

  if (result.mission.origin === 'given') {
    profile.mission = resolvedMissionPath(cfg, result);
  } else {
    const scaffold: ProfileScaffold = { world: result.mission.world || opts.world };
    if (opts.name !== undefined) scaffold.name = opts.name;
    if (opts.playerType !== undefined) scaffold.playerType = opts.playerType;
    if (opts.position !== undefined) scaffold.position = [...opts.position];
    const safeSpawn = result.mission.safeSpawn ?? opts.safeSpawn;
    if (safeSpawn !== undefined) scaffold.safeSpawn = safeSpawn;
    if (opts.initSqf !== undefined) scaffold.initSqf = opts.initSqf;
    profile.scaffold = scaffold;
  }

  // 오버레이는 원래 기본 모드로 되돌리고 테스트 애드온 스냅샷은 뺀다. 테스트 애드온은 원본 경로로 따로 적는다.
  const launched = result.launch?.mods ?? [];
  const restored = stripStackMods(launched.join(';'), resolveStacksRoot(cfg)).modString;
  const mods = stripSelfMod(cfg, restored.split(';').filter(Boolean));
  if (mods.length > 0) profile.mods = mods;
  else profile.modset = 'none';
  if (opts.testMods && opts.testMods.length > 0) {
    profile.testMods = opts.testMods.map((p) => path.resolve(p));
  }

  if (opts.clientExtraArgs && opts.clientExtraArgs.length > 0) {
    profile.clientExtraArgs = [...opts.clientExtraArgs];
  }
  if (result.mode === 'mp') {
    if (opts.serverExtraArgs && opts.serverExtraArgs.length > 0) {
      profile.serverExtraArgs = [...opts.serverExtraArgs];
    }
    if (opts.port !== undefined) profile.port = opts.port;
    if (opts.autoSlot !== undefined) profile.autoSlot = opts.autoSlot;
    if (opts.roles !== undefined && opts.roles.length > 0) profile.roles = [...opts.roles];
    if (opts.clients !== undefined && opts.clients > 1) profile.clients = opts.clients;
  }
  if (opts.ready) profile.ready = { ...opts.ready };
  return profile;
}

/** 알 수 없는 프로필 이름의 에러 문장. 있는 이름을 함께 알려 준다. */
export function unknownProfileError(name: string, known: readonly string[]): string {
  return known.length > 0
    ? `없는 프로필이다: "${name}". 있는 프로필: ${[...known].sort().join(', ')}`
    : `없는 프로필이다: "${name}". 저장된 프로필이 하나도 없다.`;
}
