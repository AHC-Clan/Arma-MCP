// testMods.ts — 새로 빌드한 PBO 를 스택 전용 테스트 애드온으로 붙인다.
//
// 큰 기본 모드는 원래 자리에서 모든 스택이 읽기 전용으로 함께 로드한다. 새로 빌드한 PBO 만
// <스택>\@arma_mcp_test 로 복사해 -mod 맨 뒤에 붙인다. 게임은 복사본을 잠그므로 원본 빌드
// 출력은 언제든 다시 빌드할 수 있다.
//
// 새 PBO 가 기본 모드에 이미 있는 PBO 를 고친 것이면(같은 prefix 나 같은 파일 이름) 둘이 함께
// 로드되지 않게 그 기본 모드를 <스택>\overlay\<모드 폴더명> 으로 다시 엮는다. 폴더는 새로
// 만들고 파일은 하드링크로 잇되 겹친 PBO 와 그 서명과 DLL 은 뺀다. 같은 드라이브면 복사가
// 없다. 다른 드라이브면 작은 모드만 복사하고 큰 모드는 거절한다.

import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { waitPathsWritable } from '../procs.js';
import { removeTreeNoFollow } from './fsSafe.js';
import { log } from '../log.js';

/** 오버레이 폴더에 남기는 표시. RPT 헤더에서 오버레이 경로를 원래 모드로 되돌릴 때 읽는다. */
export const OVERLAY_MARKER = 'arma-mcp-overlay.json';

const HEADER_READ_BYTES = 8192;
const PBO_VERS = 0x56657273; // 디스크 바이트 "sreV"
const READ_CONCURRENCY = 16;
const MB = 1024 * 1024;

export interface TestModFile {
  source: string;
  name: string;
  bytes: number;
  prefix: string | null;
}

export interface OverlayPlan {
  base: string;
  path: string;
  /** base 기준 상대 경로(소문자). 이 파일들은 오버레이에 넣지 않는다. */
  exclude: string[];
  method: 'hardlink' | 'copy';
}

export interface TestModPlan {
  dir: string;
  pbos: TestModFile[];
  rootFiles: TestModFile[];
  overlays: OverlayPlan[];
  /** 실제로 실을 모드. 겹친 기본 모드는 오버레이로 바뀌고 끝에 테스트 애드온이 붙는다. */
  mods: string[];
  totalBytes: number;
}

export type PlanResult = { ok: true; plan: TestModPlan } | { ok: false; error: string };

export interface PlanInput {
  testMods: readonly string[];
  /** 해석이 끝난 기본 모드(selfModPath 포함). */
  mods: readonly string[];
  testModDir: string;
  overlayDir: string;
  maxBytes: number;
  overlayCopyMaxBytes: number;
}

/** PBO 헤더 확장의 prefix. 소문자, 역슬래시, 앞뒤 구분자 없음. 없으면 null. */
export function parsePboPrefix(buf: Buffer): string | null {
  let i = 0;
  const cstr = (): string | null => {
    const end = buf.indexOf(0, i);
    if (end < 0) return null;
    const s = buf.toString('latin1', i, end);
    i = end + 1;
    return s;
  };
  const first = cstr();
  if (first !== '') return null;
  if (i + 20 > buf.length) return null;
  const method = buf.readUInt32LE(i);
  i += 20;
  if (method !== PBO_VERS) return null;
  for (;;) {
    const key = cstr();
    if (key === null || key === '') return null;
    const value = cstr();
    if (value === null) return null;
    if (key.toLowerCase() === 'prefix') return normalizePrefix(value);
  }
}

function normalizePrefix(p: string): string | null {
  const v = p.replace(/\//g, '\\').replace(/^\\+|\\+$/g, '').toLowerCase();
  return v.length > 0 ? v : null;
}

export async function readPboPrefix(file: string): Promise<string | null> {
  let fh: fsp.FileHandle | undefined;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0);
    return parsePboPrefix(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, worker));
  return out;
}

async function listFiles(dir: string, re: RegExp): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && re.test(e.name)).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileBytes(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

/** 폴더 아래 파일 크기 합. 링크는 따라가지 않는다. */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await treeBytes(p);
    else if (e.isFile()) total += await fileBytes(p);
  }
  return total;
}

function samePath(a: string, b: string): boolean {
  const n = (v: string): string => path.resolve(v).replace(/[\\/]+$/, '').toLowerCase();
  return n(a) === n(b);
}

function driveOf(p: string): string {
  return path.parse(path.resolve(p)).root.toLowerCase();
}

/** 입력 하나를 PBO 와 루트 파일로 펼친다. */
async function expandInput(
  entry: string,
): Promise<{ ok: true; pbos: string[]; rootFiles: string[] } | { ok: false; error: string }> {
  const p = path.resolve(entry);
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    return { ok: false, error: `테스트 애드온 경로가 없다: ${entry}` };
  }
  if (st.isFile()) {
    if (!/\.pbo$/i.test(p)) return { ok: false, error: `PBO 파일이 아니다: ${entry}` };
    return { ok: true, pbos: [p], rootFiles: [] };
  }
  const addons = path.join(p, 'addons');
  if (await isDir(addons)) {
    const pbos = await listFiles(addons, /\.pbo$/i);
    if (pbos.length === 0) return { ok: false, error: `모드 폴더의 addons 에 PBO 가 없다: ${entry}` };
    return { ok: true, pbos, rootFiles: await listFiles(p, /\.dll$/i) };
  }
  const pbos = await listFiles(p, /\.pbo$/i);
  if (pbos.length === 0) return { ok: false, error: `폴더에서 PBO 를 찾지 못했다: ${entry}` };
  return { ok: true, pbos, rootFiles: [] };
}

/**
 * 테스트 애드온을 어디에 어떻게 둘지 정한다. 파일은 건드리지 않는다.
 * 실패 사유는 게임을 띄우기 전에 알 수 있는 것만이다(없는 경로, 크기, 다른 드라이브의 큰 모드).
 */
export async function planTestMods(input: PlanInput): Promise<PlanResult> {
  const pboPaths: string[] = [];
  const rootPaths: string[] = [];
  const sourceDirs: string[] = [];
  for (const entry of input.testMods) {
    const ex = await expandInput(entry);
    if (!ex.ok) return ex;
    pboPaths.push(...ex.pbos);
    rootPaths.push(...ex.rootFiles);
    if (await isDir(entry)) sourceDirs.push(path.resolve(entry));
  }

  const seen = new Map<string, string>();
  for (const p of [...pboPaths, ...rootPaths]) {
    const key = path.basename(p).toLowerCase();
    const prev = seen.get(key);
    if (prev && !samePath(prev, p)) {
      return { ok: false, error: `테스트 애드온에 같은 이름의 파일이 둘이다: ${prev}, ${p}` };
    }
    seen.set(key, p);
  }

  const toFile = async (p: string, pbo: boolean): Promise<TestModFile> => ({
    source: p,
    name: path.basename(p),
    bytes: await fileBytes(p),
    prefix: pbo ? await readPboPrefix(p) : null,
  });
  const pbos = await mapLimited([...new Set(pboPaths)], (p) => toFile(p, true));
  const rootFiles = await mapLimited([...new Set(rootPaths)], (p) => toFile(p, false));
  const totalBytes = [...pbos, ...rootFiles].reduce((n, f) => n + f.bytes, 0);
  if (totalBytes > input.maxBytes) {
    return {
      ok: false,
      error:
        `테스트 애드온이 ${Math.ceil(totalBytes / MB)}MB 로 상한 ${Math.floor(input.maxBytes / MB)}MB(stacks.testModMaxMB)를 넘는다. ` +
        '새로 빌드한 PBO 만 넘긴다',
    };
  }

  // 테스트 애드온의 원본 폴더를 기본 모드로도 실으면 게임이 원본을 잠근다. 그 항목은 뺀다.
  const baseMods = input.mods.filter((m) => !sourceDirs.some((d) => samePath(d, m)));

  const testNames = new Set(pbos.map((f) => f.name.toLowerCase()));
  const testPrefixes = new Set(pbos.map((f) => f.prefix).filter((p): p is string => p !== null));
  const testRoots = new Set(rootFiles.map((f) => f.name.toLowerCase()));

  const overlays: OverlayPlan[] = [];
  const usedNames = new Set<string>();
  const mods: string[] = [];
  for (const base of baseMods) {
    const basePbos = await listFiles(path.join(base, 'addons'), /\.pbo$/i);
    const prefixes =
      testPrefixes.size > 0 ? await mapLimited(basePbos, (p) => readPboPrefix(p)) : basePbos.map(() => null);
    const exclude: string[] = [];
    basePbos.forEach((p, idx) => {
      const name = path.basename(p).toLowerCase();
      const prefix = prefixes[idx];
      if (testNames.has(name) || (prefix !== null && prefix !== undefined && testPrefixes.has(prefix))) {
        exclude.push(`addons/${name}`);
      }
    });
    for (const dll of await listFiles(base, /\.dll$/i)) {
      const name = path.basename(dll).toLowerCase();
      if (testRoots.has(name)) exclude.push(name);
    }
    if (exclude.length === 0) {
      mods.push(base);
      continue;
    }

    let folder = path.basename(path.resolve(base));
    for (let n = 2; usedNames.has(folder.toLowerCase()); n++) folder = `${path.basename(base)}_${n}`;
    usedNames.add(folder.toLowerCase());
    const target = path.join(input.overlayDir, folder);
    let method: OverlayPlan['method'] = 'hardlink';
    if (driveOf(base) !== driveOf(target)) {
      const bytes = await treeBytes(base);
      if (bytes > input.overlayCopyMaxBytes) {
        return {
          ok: false,
          error:
            `${base} 는 테스트 애드온과 겹치는 PBO 를 가진 ${Math.ceil(bytes / MB)}MB 모드다. ` +
            `스택 폴더와 드라이브가 달라 하드링크를 못 쓰고, 복사 상한 ${Math.floor(input.overlayCopyMaxBytes / MB)}MB(stacks.overlayCopyMaxMB)를 넘는다. ` +
            `설정 stacks.root 를 ${driveOf(base).toUpperCase()} 드라이브에 두면 복사 없이 된다`,
        };
      }
      method = 'copy';
    }
    overlays.push({ base: path.resolve(base), path: target, exclude, method });
    mods.push(target);
  }
  mods.push(input.testModDir);

  return {
    ok: true,
    plan: { dir: input.testModDir, pbos, rootFiles, overlays, mods, totalBytes },
  };
}

export interface StageResult {
  ok: boolean;
  error?: string;
  dir: string;
  files: { source: string; name: string; bytes: number }[];
  overlays: { base: string; path: string; excluded: string[]; method: OverlayPlan['method']; files: number }[];
}

/** 결과에 싣는 모양. dryRun 은 계획만 보여 준다. */
export function planSummary(plan: TestModPlan): StageResult {
  return {
    ok: true,
    dir: plan.dir,
    files: [...plan.pbos, ...plan.rootFiles].map((f) => ({ source: f.source, name: f.name, bytes: f.bytes })),
    overlays: plan.overlays.map((o) => ({ base: o.base, path: o.path, excluded: o.exclude, method: o.method, files: 0 })),
  };
}

function isExcluded(rel: string, exclude: readonly string[]): boolean {
  const r = rel.replace(/\\/g, '/').toLowerCase();
  return exclude.some((x) => r === x || (x.endsWith('.pbo') && r.startsWith(x + '.') && r.endsWith('.bisign')));
}

async function mirror(
  src: string,
  dst: string,
  rel: string,
  plan: OverlayPlan,
  counter: { files: number; method: OverlayPlan['method'] },
): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await mirror(s, d, childRel, plan, counter);
      continue;
    }
    if (!e.isFile() || isExcluded(childRel, plan.exclude)) continue;
    if (counter.method === 'hardlink') {
      try {
        await fsp.link(s, d);
        counter.files += 1;
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        // 같은 드라이브 문자라도 마운트 경계면 하드링크가 안 된다. 이후는 복사한다.
        counter.method = 'copy';
      }
    }
    await fsp.copyFile(s, d, fsConstants.COPYFILE_EXCL);
    counter.files += 1;
  }
}

/**
 * 계획대로 파일을 만든다. 스택의 게임이 모두 꺼진 뒤에 부른다.
 * 테스트 애드온은 스테이징에 다 쓴 뒤에 바꾸므로, 실패하면 이전 스냅샷이 남는다.
 */
export async function stageTestMods(
  plan: TestModPlan,
  opts: { stackRoot: string; signal?: AbortSignal; waitMs?: number },
): Promise<StageResult> {
  const out = planSummary(plan);
  const existing: string[] = [];
  for (const p of [plan.dir, ...plan.overlays.map((o) => o.path)]) {
    if (await isDir(p)) existing.push(p);
  }
  if (existing.length > 0) {
    // 방금 끈 게임이 파일을 놓기를 기다린다. 쓰지 않고 열었다 닫기만 한다.
    const unlock = await waitPathsWritable(existing, { timeoutMs: opts.waitMs ?? 15000, signal: opts.signal });
    const stuck = unlock.find((u) => !u.ok);
    if (stuck) return { ...out, ok: false, error: `이전 스냅샷이 아직 잠겨 있다(${stuck.path}): ${stuck.reason ?? stuck.code}` };
  }

  const staging = `${plan.dir}.staging-${process.pid}-${Date.now()}`;
  try {
    await fsp.mkdir(path.join(staging, 'addons'), { recursive: true });
    for (const f of plan.pbos) await fsp.copyFile(f.source, path.join(staging, 'addons', f.name));
    for (const f of plan.rootFiles) await fsp.copyFile(f.source, path.join(staging, f.name));
    await removeTreeNoFollow(plan.dir, opts.stackRoot);
    await fsp.rename(staging, plan.dir);
  } catch (error) {
    await removeTreeNoFollow(staging, opts.stackRoot).catch(() => {});
    return { ...out, ok: false, error: `테스트 애드온을 만들지 못했다: ${(error as Error).message}` };
  }

  for (let i = 0; i < plan.overlays.length; i++) {
    const o = plan.overlays[i]!;
    const counter = { files: 0, method: o.method };
    try {
      await removeTreeNoFollow(o.path, opts.stackRoot);
      await mirror(o.base, o.path, '', o, counter);
      await fsp.writeFile(
        path.join(o.path, OVERLAY_MARKER),
        JSON.stringify({ source: o.base, excluded: o.exclude }, null, 2) + '\n',
        'utf8',
      );
    } catch (error) {
      return { ...out, ok: false, error: `오버레이를 만들지 못했다(${o.base}): ${(error as Error).message}` };
    }
    out.overlays[i] = { ...out.overlays[i]!, method: counter.method, files: counter.files };
    log.info(`[stack] 오버레이 ${o.path}: ${counter.method} ${counter.files}개, 제외 ${o.exclude.join(', ')}`);
  }
  return out;
}
