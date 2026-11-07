// windowTiler.ts: 데몬이 띄운 게임 창을 모니터마다 작업 영역의 네 칸에 놓는 판단.
//
// 창을 보고 옮기는 일은 C# 헬퍼(agentSource.ts)가 하고, 여기서는 헬퍼의 관찰을 받아 무엇을 옮길지만 정한다.
// 대상은 데몬이 띄운 클라(launch 가 noteLaunched 로 알린 pid)와 -profiles 가 stacks.root 아래인 클라다.
// 데몬이 다시 떠 알림을 잃은 default 클라 1 은 -mod 의 stacks.root 아래 경로로 가른다.
// 사람이 직접 띄운 게임과 서버(arma3server_x64)는 보지 않는다.
// 포커스 가드(focusGuard.ts)도 여기서 고른 게임 창을 대상으로 쓴다. tile 이 false 면 고르기만 하고 옮기지 않는다.
//
// 규칙
//   대상 창이 둘 이상일 때만 놓는다. 하나뿐이면 손대지 않아 그 창은 띄운 크기 그대로다.
//   칸 순서는 모니터마다 왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래. 창은 시작 시각이 이른 순으로 빈 칸을 받는다.
//   칸 안의 창은 클라이언트 영역이 설정 비율(기본 16:9)인 가장 큰 크기이고, 네 창이 작업 영역 가운데에 붙어 모인다(tileGeometry.ts).
//   바깥 창과 클라이언트 영역의 차이는 헬퍼가 창마다 잰 값을 쓴다.
//   데몬이 놓은 그대로인 창은 칸 사각형이 바뀌면(모니터, 작업 표시줄, 비율, 이전 데몬의 칸) 한 번 다시 맞춘다.
//   주 모니터 네 칸이 먼저이고, 그다음은 나머지 모니터를 왼쪽부터(같으면 위부터) 네 칸씩 채운다.
//   창이 닫히면 그 칸이 빈다. 같은 창은 같은 칸에 둔다. 모든 모니터의 칸이 차면 그 뒤 창은 칸 없이 둔다.
//   모니터가 빠져 칸이 없어진 창은 다음에 맞출 때 빈 칸을 다시 받는다.
//   창이 처음 창 모드로 보이거나 게임이 스스로 자리나 크기를 바꾸면 칸에 한 번 맞춘다(120초에 6번을 넘기면 포기).
//   사람이 끌거나 크기를 바꾸거나 최대화한 창은 다시 끌어오지 않는다(칸은 계속 그 창 몫이다).
//   사람이 했는지는 끄는 중 표시와 직전 1초 안의 마우스 왼쪽 버튼이나 Win 키로 본다.
//   게임 안에서 마우스 왼쪽 버튼을 누르는 중에 게임이 바꾼 것도 사람이 한 것으로 본다(안 끌어오는 쪽이 안전하다).
//   전체 화면(제목 표시줄 없음) 창은 옮기지 않는다. 창 모드로 바뀌면 그때 맞춘다.
//   새로 뜨는 게임은 시작 중에 창 메시지를 늦게 처리한다. 옮긴 뒤 목표에 닿을 때까지 최대 8초 기다린다.
//   같은 pid 가 다른 프로세스에 다시 쓰이면 시작 시각이 달라 다른 창으로 본다.

import path from 'node:path';
import { splitCommandLine } from '../cmdline.js';
import { profilesArg, stackOfProfiles } from '../stack/processIndex.js';
import type { FocusTarget } from './focusGuard.js';
import {
  DEFAULT_ASPECT,
  TILE_SLOTS,
  WINDOW_FRAME,
  tileClient,
  tileWindowRect,
  type Rect,
  type Size,
  type WindowFrame,
} from './tileGeometry.js';

export { TILE_COLUMNS, TILE_ROWS, TILE_SLOTS, tileWindowRect, type Rect } from './tileGeometry.js';

type RectTuple = [number, number, number, number];

/** 헬퍼가 본 창 하나. r 은 바깥 창 사각형이다. */
export interface AgentWindow {
  h: number;
  cls: string;
  r: RectTuple;
  /** 제목 표시줄이 있다(창 모드). */
  cap: boolean;
  min: boolean;
  max: boolean;
  /** 끌거나 크기를 바꾸는 중(GUI_INMOVESIZE). */
  mv: boolean;
  /** 클라이언트 영역의 화면 사각형. 이전 헬퍼는 보내지 않는다. */
  c?: RectTuple;
}

export interface AgentProc {
  pid: number;
  /** 시작 시각(epoch ms). 못 읽으면 0. */
  start: number;
  /** 명령줄. 헬퍼는 프로세스마다 처음 한 번만 보낸다. */
  cmd?: string;
  /** 명령줄을 끝내 못 읽었다. */
  cmdFail?: boolean;
  wins: AgentWindow[];
}

export interface AgentSnapshot {
  /** 주 모니터 작업 영역. */
  area: RectTuple;
  /** 모든 모니터의 작업 영역과 주 모니터 표시(1). 이전 헬퍼는 보내지 않는다. */
  mons?: [number, number, number, number, number][];
  /** 마지막 사람 입력 뒤 ms. 없으면 -1. */
  human: number;
  /** 앞 창과 그 pid(없으면 0). 이전 헬퍼는 보내지 않는다. */
  fg?: number;
  fgPid?: number;
  /** 관찰 때 마우스 단추가 눌려 있었다. */
  btn?: boolean;
  procs: AgentProc[];
}

/** 바깥 창을 (x, y) 에 width x height 로 놓는다. 창 주인이 pid 가 아니면 헬퍼가 옮기지 않는다. */
export interface MoveCommand {
  hwnd: number;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 데몬이 띄운 클라. spawnedAt 은 띄운 시각(epoch ms)이고 pid 가 다시 쓰였는지 가를 때 쓴다. */
export interface LaunchedClient {
  pid: number;
  stack: string;
  label: string;
  spawnedAt: number;
  /** 처음 맞춰 본 프로세스 시작 시각. 그 뒤로는 이 값과 같은 프로세스만 이 클라다. */
  start?: number;
}

export const SLOT_NAMES: readonly string[] = ['왼쪽 위', '오른쪽 위', '왼쪽 아래', '오른쪽 아래'];

/** 칸 이름. 주 모니터 칸은 자리만 쓰고, 다른 모니터 칸은 채우는 순서의 모니터 번호를 앞에 붙인다. */
export function slotName(slot: number): string {
  const monitor = Math.floor(slot / TILE_SLOTS);
  const cell = SLOT_NAMES[slot % TILE_SLOTS]!;
  return monitor === 0 ? cell : `모니터 ${monitor + 1} ${cell}`;
}

/**
 * 칸을 채울 모니터 작업 영역의 순서. 주 모니터가 먼저이고 나머지는 왼쪽부터, 같으면 위부터다.
 * 모니터 목록이 없으면(이전 헬퍼) 주 모니터 하나다.
 */
export function tileAreas(snap: Pick<AgentSnapshot, 'area' | 'mons'>): Rect[] {
  const mons = (snap.mons ?? []).filter((m) => m[2] > m[0] && m[3] > m[1]);
  if (mons.length === 0) return [rectOf(snap.area)];
  return [...mons]
    .sort((a, b) => b[4] - a[4] || a[0] - b[0] || a[1] - b[1])
    .map((m) => ({ l: m[0], t: m[1], r: m[2], b: m[3] }));
}

const SETTLE_MS = 8000;
const SETTLE_GRACE_MS = 2000;
const REAPPLY_LIMIT = 6;
const REAPPLY_WINDOW_MS = 120_000;
const HUMAN_RECENT_MS = 1000;
const MIN_W = 320;
const MIN_H = 240;
const GAME_CLASS = 'Arma 3';
/** 띄운 시각과 프로세스 시작 시각이 이만큼 안이면 같은 프로세스로 본다. */
const LAUNCH_MATCH_MS = 30_000;
/** 띄웠다고 알린 pid 가 이만큼 지나도 안 보이면 잊는다. */
const LAUNCH_FORGET_MS = 60_000;

/** 헬퍼가 잰 바깥 창과 클라이언트 영역의 차이. 못 쟀거나 값이 이상하면 null. */
export function measuredFrame(win: Pick<AgentWindow, 'r' | 'c'>): WindowFrame | null {
  if (!win.c) return null;
  const f = { left: win.c[0] - win.r[0], top: win.c[1] - win.r[1], right: win.r[2] - win.c[2], bottom: win.r[3] - win.c[3] };
  return Object.values(f).every((v) => Number.isInteger(v) && v >= 0 && v <= 64) ? f : null;
}

function rectOf(r: RectTuple): Rect {
  return { l: r[0], t: r[1], r: r[2], b: r[3] };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  return !!a && !!b && a.l === b.l && a.t === b.t && a.r === b.r && a.b === b.b;
}

function showRect(r: Rect | null): string {
  return r ? `(${r.l},${r.t} ${r.r - r.l}x${r.b - r.t})` : '(없음)';
}

/** 스택 이름이 패턴 중 하나에 맞는가. 패턴이 없으면 모두 맞는다. `*` 는 아무 글자나 맞는다. */
export function stackAllowed(stack: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((p) => {
    const rx = '^' + p.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
    return new RegExp(rx, 'i').test(stack);
  });
}

function nameArg(cmd: string): string | null {
  for (const arg of splitCommandLine(cmd)) {
    const m = /^-name=(.+)$/i.exec(arg);
    if (m) return m[1]!.trim() || null;
  }
  return null;
}

function underRoot(dir: string, root: string): boolean {
  const norm = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const d = norm(dir);
  const r = norm(root);
  return d.startsWith(r + '\\') || d.startsWith(r + '/');
}

interface Tracked {
  pid: number;
  start: number;
  stack: string;
  label: string;
  h: number | null;
  slot: number;
  manual: boolean;
  manualWhy: string | null;
  wasWindowed: boolean;
  hasApplied: boolean;
  applied: Rect | null;
  target: Rect | null;
  settling: boolean;
  settleUntil: number;
  applies: number[];
  gaveUp: boolean;
  notedFull: boolean;
  notedNoSlot: boolean;
  /** 지난 관찰의 바깥 창 사각형. */
  lastRect: Rect | null;
  /** 상태 파일에서 이어받고 아직 창을 못 봤다. */
  restored: boolean;
  /** 마지막으로 맞추려던 칸 사각형. 칸 사각형이 바뀌었는지 가를 때 쓴다. */
  aimed: Rect | null;
  /** 창 모드 창에서 잰 테두리 몫. 아직 못 쟀으면 null. */
  frame: WindowFrame | null;
}

/** 다시 떠도 이어받는 창 상태. pid 와 시작 시각이 같을 때만 이어받는다. */
export interface SavedWindow {
  pid: number;
  start: number;
  slot: number;
  manual: boolean;
  manualWhy: string | null;
  wasWindowed: boolean;
  hasApplied: boolean;
  applied: Rect | null;
  /** 마지막으로 맞추려던 칸 사각형. 이전 데몬은 남기지 않는다. */
  aimed?: Rect | null;
}

export interface TilerState {
  v: 1;
  launched: LaunchedClient[];
  windows: SavedWindow[];
}

export interface WindowTilerOptions {
  stacksRoot: string;
  /** 대상 스택 패턴. 비면 모든 스택이다. */
  stacks: readonly string[];
  /** 창을 칸에 놓는다(기본 true). false 면 대상 게임을 보기만 한다(포커스 가드만 쓸 때). */
  tile?: boolean;
  /** 칸 안 창 클라이언트 영역의 가로세로 비율(stacks.windowWidth:windowHeight). 기본 16:9. */
  aspect?: Size;
  move(cmd: MoveCommand): void;
  log?: (msg: string) => void;
  now?: () => number;
  /** 저장할 상태가 바뀌었다. */
  onChange?: () => void;
}

/** 지금 놓인 창 하나(상태 조회용). */
export interface TiledWindowInfo {
  pid: number;
  stack: string;
  label: string;
  slot: number | null;
  manual: boolean;
  windowed: boolean;
}

export class WindowTiler {
  private readonly tracked = new Map<number, Tracked>();
  private readonly ignored = new Map<number, { start: number; reason: string }>();
  private readonly launched = new Map<number, LaunchedClient>();
  private readonly cmds = new Map<string, string>();
  private readonly cmdFailed = new Set<string>();
  private saved = new Map<string, SavedWindow>();
  /** 칸을 채우는 순서의 모니터 작업 영역. 모니터마다 TILE_SLOTS 칸이다. */
  private areas: Rect[] = [];
  private active = false;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: WindowTilerOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** 데몬이 클라를 띄웠다. 다음 관찰부터 이 pid 를 대상으로 본다. */
  noteLaunched(c: { pid: number; stack: string; label: string }): void {
    if (!Number.isInteger(c.pid) || c.pid <= 0) return;
    this.launched.set(c.pid, { ...c, spawnedAt: this.now() });
    // 띄운 줄 알기 전에 관찰이 먼저 왔으면 대상이 아니라고 본 판정을 지운다.
    this.ignored.delete(c.pid);
    this.changed();
  }

  /** 헬퍼가 옮긴 결과. 실패만 남긴다. */
  onMoved(h: number, ok: boolean, err: number): void {
    if (ok) return;
    const t = [...this.tracked.values()].find((x) => x.h === h);
    this.log(`옮기기 실패: ${t ? t.label : `창 ${h}`} (${err === -1 ? '창 주인이 바뀜' : `오류 ${err}`})`);
    if (err === -1 && t) t.h = null;
  }

  importState(state: TilerState | null | undefined): void {
    if (!state || state.v !== 1) return;
    for (const c of state.launched ?? []) {
      if (Number.isInteger(c.pid) && c.pid > 0) this.launched.set(c.pid, c);
    }
    this.saved = new Map((state.windows ?? []).map((w) => [`${w.pid}:${w.start}`, w]));
  }

  exportState(): TilerState {
    return {
      v: 1,
      launched: [...this.launched.values()],
      // 아직 다시 못 본 저장 항목도 남긴다. 첫 관찰 전에 끝나도 다음 실행이 이어받는다.
      windows: [...this.saved.values(), ...[...this.tracked.values()].map((t) => ({
        pid: t.pid,
        start: t.start,
        slot: t.slot,
        manual: t.manual,
        manualWhy: t.manualWhy,
        wasWindowed: t.wasWindowed,
        hasApplied: t.hasApplied,
        applied: t.applied,
        aimed: t.aimed,
      }))],
    };
  }

  windows(): TiledWindowInfo[] {
    return this.sorted().map((t) => ({
      pid: t.pid,
      stack: t.stack,
      label: t.label,
      slot: this.opts.tile !== false && t.slot >= 0 ? t.slot : null,
      manual: t.manual,
      windowed: t.wasWindowed,
    }));
  }

  /** 헬퍼의 관찰 하나를 받아 판단한다. */
  onSnapshot(snap: AgentSnapshot): void {
    this.areas = tileAreas(snap);
    this.discover(snap);
    const byPid = new Map(snap.procs.map((p) => [p.pid, p]));
    for (const t of this.sorted()) this.pickWindow(t, byPid.get(t.pid));
    if (this.opts.tile === false) {
      // 옮기지 않을 때는 지금 창이 창 모드인지만 적는다(상태 조회용).
      for (const t of this.sorted()) {
        const win = byPid.get(t.pid)?.wins.find((w) => w.h === t.h);
        if (win && !win.min && win.cap !== t.wasWindowed) {
          t.wasWindowed = win.cap;
          this.changed();
        }
      }
      return;
    }
    // 창이 아니라 게임 프로세스를 센다. 시작 화면 창이 닫히고 게임 창이 뜨는 사이에는 창이 잠깐 없다.
    const count = this.tracked.size;
    const active = count >= 2;
    if (active !== this.active) {
      this.active = active;
      this.log(active ? `게임 창 ${count}개, 네 칸으로 놓기 시작` : `게임 창 ${count}개, 놓기 쉼(하나뿐인 창은 손대지 않음)`);
    }
    const humanRecent = snap.human >= 0 && snap.human < HUMAN_RECENT_MS;
    for (const t of this.sorted()) {
      const win = byPid.get(t.pid)?.wins.find((w) => w.h === t.h);
      this.observe(t, win, humanRecent);
    }
  }

  /** 지난 관찰에서 고른 대상 게임 창. onSnapshot 뒤에 부른다. */
  focusTargets(snap: AgentSnapshot): FocusTarget[] {
    const byPid = new Map(snap.procs.map((p) => [p.pid, p]));
    return this.sorted().map((t) => ({
      key: `${t.pid}:${t.start}`,
      pid: t.pid,
      label: t.label,
      win: byPid.get(t.pid)?.wins.find((w) => w.h === t.h),
    }));
  }

  private sorted(): Tracked[] {
    return [...this.tracked.values()].sort((a, b) => a.start - b.start || a.pid - b.pid);
  }

  private changed(): void {
    this.opts.onChange?.();
  }

  private discover(snap: AgentSnapshot): void {
    const now = this.now();
    const alive = new Map(snap.procs.map((p) => [p.pid, p]));
    const reused = (start: number, p: AgentProc): boolean => start !== 0 && p.start !== 0 && start !== p.start;
    for (const [pid, t] of this.tracked) {
      const p = alive.get(pid);
      if (!p || reused(t.start, p)) {
        this.log(`닫힘: ${t.label} pid ${pid}${t.slot >= 0 ? `, 칸 ${t.slot + 1} 비움` : ''}`);
        this.tracked.delete(pid);
        this.changed();
      }
    }
    for (const [pid, ig] of this.ignored) {
      const p = alive.get(pid);
      if (!p || reused(ig.start, p)) this.ignored.delete(pid);
    }
    for (const [pid, c] of this.launched) {
      const p = alive.get(pid);
      const gone = p ? !this.launchMatches(c, p) : now - c.spawnedAt > LAUNCH_FORGET_MS;
      if (gone) {
        this.launched.delete(pid);
        this.changed();
      }
    }
    const liveKeys = new Set(snap.procs.map((p) => `${p.pid}:${p.start}`));
    for (const k of this.cmds.keys()) if (!liveKeys.has(k)) this.cmds.delete(k);
    for (const k of this.cmdFailed) if (!liveKeys.has(k)) this.cmdFailed.delete(k);
    for (const k of this.saved.keys()) if (!liveKeys.has(k)) this.saved.delete(k);

    for (const p of snap.procs) {
      const key = `${p.pid}:${p.start}`;
      if (p.cmd !== undefined) this.cmds.set(key, p.cmd);
      if (p.cmdFail) this.cmdFailed.add(key);
      if (this.tracked.has(p.pid) || this.ignored.has(p.pid)) continue;
      const verdict = this.classify(p, this.cmds.get(key), this.cmdFailed.has(key));
      if (verdict === null) continue;
      if ('reason' in verdict) {
        this.ignored.set(p.pid, { start: p.start, reason: verdict.reason });
        this.log(`무시: pid ${p.pid} ${verdict.reason}`);
        continue;
      }
      const t: Tracked = {
        pid: p.pid,
        start: p.start,
        stack: verdict.stack,
        label: verdict.label,
        h: null,
        slot: -1,
        manual: false,
        manualWhy: null,
        wasWindowed: false,
        hasApplied: false,
        applied: null,
        target: null,
        settling: false,
        settleUntil: 0,
        applies: [],
        gaveUp: false,
        notedFull: false,
        notedNoSlot: false,
        lastRect: null,
        restored: false,
        aimed: null,
        frame: null,
      };
      this.restore(t);
      this.tracked.set(p.pid, t);
      this.log(`발견: ${t.label} (스택 ${t.stack}) pid ${t.pid}`);
      this.changed();
    }
  }

  private launchMatches(c: LaunchedClient, p: AgentProc): boolean {
    if (c.start !== undefined) return p.start === c.start;
    return p.start === 0 || Math.abs(p.start - c.spawnedAt) <= LAUNCH_MATCH_MS;
  }

  /** 대상이면 스택과 이름, 아니면 이유, 아직 모르면 null. */
  private classify(
    p: AgentProc,
    cmd: string | undefined,
    cmdFailed: boolean,
  ): { stack: string; label: string } | { reason: string } | null {
    const c = this.launched.get(p.pid);
    const launched = c && this.launchMatches(c, p) ? c : null;
    if (launched && launched.start === undefined && p.start !== 0) {
      launched.start = p.start;
      this.changed();
    }
    const profiles = cmd ? profilesArg(cmd) : null;
    let stack: string | null = null;
    if (launched) stack = launched.stack;
    else if (profiles && underRoot(profiles, this.opts.stacksRoot)) stack = stackOfProfiles(profiles, this.opts.stacksRoot);
    else if (cmd) stack = this.stackOfDaemonMarks(cmd);
    if (stack === null) {
      if (cmd === undefined && !cmdFailed) return null;
      return { reason: '데몬이 띄운 스택 게임이 아님' };
    }
    if (!stackAllowed(stack, this.opts.stacks)) return { reason: `대상 밖 스택 ${stack}` };
    const label = launched?.label ?? (cmd ? nameArg(cmd) : null) ?? stack;
    return { stack, label };
  }

  /**
   * 이전 데몬이 띄운 default 클라 1 은 알림도 스택 -profiles 도 없다. -mod 에 stacks.root 아래 경로(테스트 애드온,
   * 오버레이)가 있으면 그 스택으로 본다. autotest cfg 이름은 다른 데몬도 같아 보지 않는다.
   */
  private stackOfDaemonMarks(cmd: string): string | null {
    for (const arg of splitCommandLine(cmd)) {
      const m = /^-mod=(.*)$/i.exec(arg);
      if (!m) continue;
      for (const entry of m[1]!.replace(/^"|"$/g, '').split(';')) {
        const dir = entry.trim();
        if (dir && path.isAbsolute(dir) && underRoot(dir, this.opts.stacksRoot)) return stackOfProfiles(dir, this.opts.stacksRoot);
      }
    }
    return null;
  }

  private restore(t: Tracked): void {
    const s = this.saved.get(`${t.pid}:${t.start}`);
    if (!s) return;
    this.saved.delete(`${t.pid}:${t.start}`);
    const taken = [...this.tracked.values()].some((o) => o.slot === s.slot);
    if (s.slot >= 0 && s.slot < this.slotCount() && !taken) t.slot = s.slot;
    t.manual = s.manual;
    t.manualWhy = s.manualWhy;
    t.wasWindowed = s.wasWindowed;
    t.hasApplied = s.hasApplied;
    t.applied = s.applied;
    t.aimed = s.aimed ?? null;
    t.restored = true;
    this.log(`이어받음: ${t.label}${t.slot >= 0 ? ` 칸 ${t.slot + 1}` : ' (칸 없음)'}${t.manual ? ' (사람이 옮긴 창)' : ''}`);
  }

  /** 프로세스의 보이는 최상위 창 중 게임 창을 고른다. 고른 창이 살아 있으면 그대로 둔다. */
  private pickWindow(t: Tracked, p: AgentProc | undefined): void {
    const wins = p?.wins ?? [];
    let best: AgentWindow | null = null;
    let bestArea = -1;
    for (const w of wins) {
      const area = Math.max(0, w.r[2] - w.r[0]) * Math.max(0, w.r[3] - w.r[1]) + (w.cls === GAME_CLASS ? 2 ** 40 : 0);
      if (area > bestArea) {
        bestArea = area;
        best = w;
      }
    }
    const cur = wins.find((w) => w.h === t.h) ?? null;
    let next = cur ? cur.h : best ? best.h : null;
    // 시작 화면 창에서 게임 창으로 넘어간다.
    if (cur && best && best.h !== cur.h && cur.cls !== GAME_CLASS && best.cls === GAME_CLASS) next = best.h;
    if (next !== t.h) {
      t.h = next;
      this.changed();
    }
  }

  private observe(t: Tracked, win: AgentWindow | undefined, humanRecent: boolean): void {
    const now = this.now();
    if (!win || win.min) {
      // 창이 숨거나 작아져 확인을 못 끝낸 경우
      if (t.settling && now > t.settleUntil + SETTLE_GRACE_MS) t.settling = false;
      return;
    }
    const cur = rectOf(win.r);
    const prev = t.lastRect;
    t.lastRect = cur;
    if (cur.r - cur.l < MIN_W || cur.b - cur.t < MIN_H) return; // 시작 중의 작은 창
    if (!win.cap) {
      // 시작 화면(512x256)도 제목 표시줄이 없다. 어느 모니터의 작업 영역을 거의 덮을 때만 전체 화면으로 적는다.
      const covers = this.areas.some(
        (area) => cur.r - cur.l >= (area.r - area.l) * 0.9 && cur.b - cur.t >= (area.b - area.t) * 0.9,
      );
      if (!covers) return;
      if (!t.notedFull) {
        this.log(`전체 화면(테두리 없음)이라 못 옮김: ${t.label} ${showRect(cur)}. 창 모드(-window)로 뜨면 그때 맞춘다`);
        t.notedFull = true;
      }
      if (t.wasWindowed) {
        t.wasWindowed = false;
        this.changed();
      }
      return;
    }
    t.notedFull = false;
    const frame = measuredFrame(win);
    if (frame) t.frame = frame;

    if (win.max) {
      this.markManual(t, '최대화');
      return;
    }
    if (win.mv) {
      // 아직 한 번도 놓지 않은 창을 혼자 있을 때 옮기는 것은 사람 마음이다. 둘 이상이 되면 그때 놓는다.
      if (this.active || t.hasApplied) this.markManual(t, '끌거나 크기를 바꾸는 중');
      return;
    }

    if (t.restored) {
      // 데몬이 꺼진 사이 바뀐 자리는 누가 옮겼는지 모른다. 끌어오지 않고 지금 자리를 맞춘 자리로 받는다.
      t.restored = false;
      if (t.hasApplied && !sameRect(cur, t.applied)) {
        this.log(`이어받은 창의 자리가 ${showRect(t.applied)} 에서 ${showRect(cur)} 로 바뀌어 있어 그대로 둔다: ${t.label}`);
        t.applied = cur;
        t.aimed = this.targetOf(t);
        this.changed();
      }
    }

    if (t.settling) {
      // 옮기기를 기다리는 사이 사람이 옮겼으면 기다림을 멈추고 손대지 않는다.
      if (humanRecent && prev && !sameRect(cur, prev) && !sameRect(cur, t.target)) {
        this.markManual(t, `옮기기를 기다리는 사이 사람이 자리나 크기를 바꿈 ${showRect(prev)} -> ${showRect(cur)}`);
        return;
      }
      // 게임이 시작 중이면 창 메시지를 늦게 처리한다. 목표에 닿거나 시간이 다 될 때까지 기다린다.
      const reached = sameRect(cur, t.target);
      if (!reached && now < t.settleUntil) return;
      t.settling = false;
      t.applied = cur;
      t.hasApplied = true;
      this.changed();
      if (reached) this.log(`맞춤: ${t.label} 칸 ${t.slot + 1} ${showRect(cur)}`);
      else this.log(`칸에 다 안 맞음: ${t.label} 칸 ${t.slot + 1} 목표 ${showRect(t.target)} 실제 ${showRect(cur)} (게임이 크기를 따로 정함)`);
      return;
    }

    if (!this.active) {
      // 창이 하나뿐이면 옮기지 않는다. 전에 놓았던 창을 사람이 옮기면 그 표시만 남긴다.
      if (t.hasApplied && !t.manual && !sameRect(cur, t.applied) && humanRecent) {
        this.markManual(t, `사람이 자리나 크기를 바꿈 ${showRect(t.applied)} -> ${showRect(cur)}`);
      }
      return;
    }

    if (!t.wasWindowed) {
      // 처음 창 모드로 보임, 또는 전체 화면에서 창 모드로 바뀜. 사람이 옮겼던 표시는 지운다.
      const first = !t.hasApplied;
      t.wasWindowed = true;
      t.manual = false;
      t.manualWhy = null;
      this.changed();
      this.apply(t, cur, first ? '처음 보임' : '창 모드로 바뀜');
      return;
    }

    if (t.manual || t.gaveUp) return;
    if (t.slot < 0 || t.slot >= this.slotCount()) {
      this.apply(t, cur, t.slot < 0 ? '칸이 비어 다시 시도' : '모니터가 빠짐');
      return;
    }
    if (!t.hasApplied) {
      this.apply(t, cur, '맞춘 기록 없음');
      return;
    }
    if (sameRect(cur, t.applied)) {
      // 놓은 그대로인 창. 칸 사각형이 바뀌었으면(모니터, 작업 표시줄, 비율, 이전 데몬의 칸) 한 번 다시 맞춘다.
      const target = this.targetOf(t);
      const before = t.aimed ?? t.applied;
      if (target && !sameRect(target, before)) this.apply(t, cur, `칸이 ${showRect(before)} 에서 ${showRect(target)} 로 바뀜`);
      return;
    }

    // 자리나 크기가 달라졌다. 방금 마우스나 Win 키가 눌렸으면 사람이, 아니면 게임이 한 것으로 본다.
    if (humanRecent) {
      this.markManual(t, `사람이 자리나 크기를 바꿈 ${showRect(t.applied)} -> ${showRect(cur)}`);
      return;
    }
    this.apply(t, cur, `게임이 자리나 크기를 ${showRect(t.applied)} -> ${showRect(cur)} 로 바꿈`);
  }

  private slotCount(): number {
    return this.areas.length * TILE_SLOTS;
  }

  /**
   * 지금 stack 의 창 모드 클라 count 개를 띄우면 받을 칸의 클라이언트 영역 크기. 런처가 이 크기를 Arma3.cfg 에 적어
   * 게임이 처음부터 칸 크기로 뜨게 한다. 게임은 시작 중에 바뀐 창 크기를 렌더 해상도에 반영하지 않는다.
   * 놓지 않을 실행이면 null 이고, 칸이 모자라 칸 없이 둘 클라는 null 항목이다.
   * 같은 스택의 떠 있는 창은 이번 실행이 끄거나 바꾸므로 세지 않는다.
   */
  plannedClientSizes(stack: string, count: number): (Size | null)[] | null {
    if (this.opts.tile === false || count < 1 || this.areas.length === 0) return null;
    if (!stackAllowed(stack, this.opts.stacks)) return null;
    const others = [...this.tracked.values()].filter((t) => t.stack !== stack);
    if (others.length + count < 2) return null;
    const taken = new Set(others.map((t) => t.slot).filter((s) => s >= 0));
    // 칸 없는 앞 창(혼자라 아직 안 놓은 창)이 먼저 빈 칸을 받는다. 전체 화면 창은 칸을 받지 않는다.
    let skip = others.filter((t) => t.slot < 0 && !t.notedFull).length;
    const frame = others.find((t) => t.frame)?.frame ?? WINDOW_FRAME;
    const aspect = this.opts.aspect ?? DEFAULT_ASPECT;
    const sizes: (Size | null)[] = [];
    for (let slot = 0; slot < this.slotCount() && sizes.length < count; slot++) {
      if (taken.has(slot)) continue;
      if (skip > 0) {
        skip--;
        continue;
      }
      sizes.push(tileClient(this.areas[Math.floor(slot / TILE_SLOTS)]!, frame, aspect));
    }
    while (sizes.length < count) sizes.push(null);
    return sizes;
  }

  /** 창 t 를 놓을 바깥 창 사각형. 칸이 없으면 null. */
  private targetOf(t: Tracked): Rect | null {
    if (t.slot < 0 || t.slot >= this.slotCount()) return null;
    const area = this.areas[Math.floor(t.slot / TILE_SLOTS)]!;
    return tileWindowRect(area, t.slot % TILE_SLOTS, t.frame ?? WINDOW_FRAME, this.opts.aspect ?? DEFAULT_ASPECT);
  }

  private freeSlot(): number {
    for (let i = 0; i < this.slotCount(); i++) {
      if (![...this.tracked.values()].some((t) => t.slot === i)) return i;
    }
    return -1;
  }

  private markManual(t: Tracked, why: string): void {
    // 창 모드인 것을 본 뒤에만 부른다. 조작이 끝나도 사람이 한 표시를 지우지 않는다.
    if (!t.wasWindowed) {
      t.wasWindowed = true;
      this.changed();
    }
    if (t.slot < 0) {
      const s = this.freeSlot();
      if (s >= 0) {
        t.slot = s;
        this.log(`칸 배정(옮기지 않음): ${t.label} -> 칸 ${s + 1}`);
        this.changed();
      }
    }
    if (t.manual) return;
    t.manual = true;
    t.manualWhy = why;
    t.settling = false;
    this.changed();
    this.log(`손대지 않음: ${t.label}${t.slot >= 0 ? ` 칸 ${t.slot + 1}` : ''}, ${why}`);
  }

  private apply(t: Tracked, cur: Rect, why: string): void {
    if (this.areas.length === 0 || t.h === null) return;
    if (t.slot >= this.slotCount()) {
      this.log(`모니터가 빠져 칸 ${t.slot + 1} 이 없어짐: ${t.label}, 빈 칸을 다시 찾는다`);
      t.slot = -1;
      this.changed();
    }
    if (t.slot < 0) {
      const s = this.freeSlot();
      if (s < 0) {
        if (!t.notedNoSlot) {
          this.log(`칸이 없음(창 ${this.slotCount()}개 초과): ${t.label} 는 두고 본다`);
          t.notedNoSlot = true;
        }
        return;
      }
      t.slot = s;
      t.notedNoSlot = false;
      this.changed();
      this.log(`칸 배정: ${t.label} (스택 ${t.stack}) -> 칸 ${s + 1} ${slotName(s)}`);
    }
    const now = this.now();
    t.applies = t.applies.filter((at) => now - at <= REAPPLY_WINDOW_MS);
    if (t.applies.length >= REAPPLY_LIMIT) {
      if (!t.gaveUp) {
        t.gaveUp = true;
        this.log(`포기: ${t.label} 가 ${REAPPLY_WINDOW_MS / 1000}초에 ${REAPPLY_LIMIT}번 넘게 크기를 바꿔 더 안 맞춘다`);
      }
      return;
    }
    const target = this.targetOf(t)!;
    t.target = target;
    t.aimed = target;
    if (sameRect(cur, target)) {
      t.applied = cur;
      t.hasApplied = true;
      this.changed();
      return;
    }
    this.log(`옮김(${why}): ${t.label} 칸 ${t.slot + 1} ${showRect(cur)} -> ${showRect(target)}`);
    this.opts.move({ hwnd: t.h, pid: t.pid, x: target.l, y: target.t, width: target.r - target.l, height: target.b - target.t });
    t.applies.push(now);
    t.settling = true;
    t.settleUntil = now + SETTLE_MS;
    this.changed();
  }
}
