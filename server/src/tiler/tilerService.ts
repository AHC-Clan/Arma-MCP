// tilerService.ts: 데몬 안에서 창 타일러와 포커스 가드를 돌린다. C# 헬퍼를 띄우고 그 관찰을 windowTiler.ts 와 focusGuard.ts 에 넘긴다.
//
// 데몬 하나에 하나만 돈다(runtime.ts 가 게임 파이프를 가진 뒤에 시작한다). 런처는 클라를 띄울 때마다
// noteLaunchedClient 로 pid 를 알린다. 이 알림과 칸 배정은 상태 파일에 남아 데몬이 다시 떠도 이어받는다.
// 헬퍼의 stdout 은 데몬으로 오는 파이프이고 데몬 stdout 에는 아무것도 쓰지 않는다. 로그는 공용 로거(stderr)로 간다.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { ensureCsHelper } from '../csHelper.js';
import { log } from '../log.js';
import { TILER_AGENT_CS_SOURCE } from './agentSource.js';
import { FocusGuard, type FocusCommand } from './focusGuard.js';
import { WindowTiler, type AgentSnapshot, type MoveCommand, type TiledWindowInfo, type TilerState } from './windowTiler.js';

const SAVE_DEBOUNCE_MS = 1000;
const RESTART_DELAY_MS = 5000;
const RESTART_LIMIT = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

export interface TilerServiceOptions {
  stacksRoot: string;
  stacks: readonly string[];
  /** 창을 칸에 놓는다(windowTiler.enabled). 기본 true. */
  tile?: boolean;
  /** 칸 안 창 클라이언트 영역의 비율(stacks.windowWidth:windowHeight). 기본 16:9. */
  aspect?: { width: number; height: number };
  /** 앞에 없는 게임 창에 비활성 알림을 보낸다(windowTiler.focusGuard). 기본 true. */
  focusGuard?: boolean;
  /** 칸 배정과 띄운 클라를 남기는 파일. */
  stateFile: string;
  /** 시험에서 헬퍼 대신 쓴다. */
  spawnAgent?: () => Promise<ChildProcess | { error: string }>;
}

let current: WindowTilerService | null = null;

/** 데몬이 클라를 띄웠다. 타일러가 돌지 않으면 아무것도 하지 않는다. */
export function noteLaunchedClient(c: { pid: number | undefined; stack: string; label: string }): void {
  if (c.pid === undefined) return;
  current?.noteLaunched({ pid: c.pid, stack: c.stack, label: c.label });
}

/** stack 의 창 모드 클라 count 개를 지금 띄우면 받을 칸의 클라이언트 영역 크기(WindowTiler.plannedClientSizes). 타일러가 돌지 않으면 null. */
export function plannedTileSizes(stack: string, count: number): ({ width: number; height: number } | null)[] | null {
  return current ? current.plannedClientSizes(stack, count) : null;
}

/** 돌고 있는 타일러의 창 목록. 돌지 않으면 null. */
export function tiledWindows(): TiledWindowInfo[] | null {
  return current ? current.windows() : null;
}

async function defaultSpawnAgent(): Promise<ChildProcess | { error: string }> {
  const helper = await ensureCsHelper({
    prefix: 'arma-tiler',
    source: TILER_AGENT_CS_SOURCE,
    references: ['System.Management.dll'],
  });
  if ('error' in helper) return helper;
  return spawn(helper.exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
}

export class WindowTilerService {
  private readonly tiler: WindowTiler;
  private readonly guard: FocusGuard | null;
  private agent: ChildProcess | null = null;
  private stopped = false;
  private restarts: number[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: TilerServiceOptions) {
    this.tiler = new WindowTiler({
      stacksRoot: opts.stacksRoot,
      stacks: opts.stacks,
      tile: opts.tile !== false,
      ...(opts.aspect ? { aspect: opts.aspect } : {}),
      move: (cmd) => this.send(cmd),
      log: (msg) => log.info(`[tiler] ${msg}`),
      onChange: () => this.scheduleSave(),
    });
    this.tiler.importState(this.load());
    this.guard =
      opts.focusGuard === false
        ? null
        : new FocusGuard({ send: (cmd) => this.sendFocus(cmd), log: (msg) => log.info(`[tiler] ${msg}`) });
  }

  start(): void {
    current = this;
    void this.launch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (current === this) current = null;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
    const agent = this.agent;
    this.agent = null;
    if (agent && agent.exitCode === null) {
      // stdin 을 닫으면 헬퍼가 스스로 끝난다.
      agent.stdin?.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          agent.kill();
          resolve();
        }, 2000);
        agent.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  noteLaunched(c: { pid: number; stack: string; label: string }): void {
    this.tiler.noteLaunched(c);
  }

  windows(): TiledWindowInfo[] {
    return this.tiler.windows();
  }

  plannedClientSizes(stack: string, count: number): ({ width: number; height: number } | null)[] | null {
    return this.tiler.plannedClientSizes(stack, count);
  }

  private async launch(): Promise<void> {
    if (this.stopped) return;
    let child: ChildProcess | { error: string };
    try {
      child = await (this.opts.spawnAgent ?? defaultSpawnAgent)();
    } catch (e) {
      child = { error: (e as Error).message };
    }
    if ('error' in child) {
      log.warn(`[tiler] 창 헬퍼를 띄우지 못해 게임 창을 놓지 않는다: ${child.error}`);
      return;
    }
    if (this.stopped) {
      child.stdin?.end();
      return;
    }
    this.agent = child;
    child.on('error', (e) => log.warn(`[tiler] 창 헬퍼 오류: ${e.message}`));
    child.stdin?.on('error', () => {});
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => this.onLine(line));
    }
    child.once('exit', (code) => {
      if (this.agent === child) this.agent = null;
      if (this.stopped) return;
      this.scheduleRestart(code);
    });
    log.info(`[tiler] 창 헬퍼 시작 pid=${child.pid}`);
  }

  private scheduleRestart(code: number | null): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (this.restarts.length >= RESTART_LIMIT) {
      log.warn(`[tiler] 창 헬퍼가 ${RESTART_WINDOW_MS / 60_000}분에 ${RESTART_LIMIT}번 끝나 더 띄우지 않는다(마지막 종료 코드 ${code})`);
      return;
    }
    this.restarts.push(now);
    log.warn(`[tiler] 창 헬퍼가 끝남(코드 ${code}), ${RESTART_DELAY_MS / 1000}초 뒤 다시 띄운다`);
    this.restartTimer = setTimeout(() => void this.launch(), RESTART_DELAY_MS);
    this.restartTimer.unref();
  }

  private onLine(line: string): void {
    let msg: { t?: unknown; h?: unknown; ok?: unknown; err?: unknown; msg?: unknown; op?: unknown; why?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    try {
      if (msg.t === 'snap') {
        const snap = msg as unknown as AgentSnapshot;
        this.tiler.onSnapshot(snap);
        this.guard?.onSnapshot(snap, this.tiler.focusTargets(snap));
      } else if (msg.t === 'focus') this.onFocusResult(Number(msg.h), msg.ok === true, msg.why);
      else if (msg.t === 'moved') this.tiler.onMoved(Number(msg.h), msg.ok === true, Number(msg.err));
      else if (msg.t === 'error') log.warn(`[tiler] 창 헬퍼: ${String(msg.msg)}`);
    } catch (e) {
      log.warn(`[tiler] 관찰 처리 실패: ${(e as Error).message}`);
    }
  }

  /**
   * 헬퍼가 알리지 않았거나 처리를 못 본 까닭 중 앞 창이 바뀌었거나, 단추가 눌렸거나, 게임이 바빠 늦게 처리하는 것은
   * 다음 관찰이 다시 판단한다. 그 밖만 남긴다.
   */
  private onFocusResult(h: number, ok: boolean, why: unknown): void {
    if (ok || why === 'foreground' || why === 'button' || why === 'timeout' || why === 'queued') return;
    log.warn(`[tiler] 포커스 가드 비활성 알림 실패: 창 ${h} (${String(why)})`);
  }

  private sendFocus(cmd: FocusCommand): void {
    const stdin = this.agent?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`deact ${cmd.hwnd} ${cmd.pid}\n`);
  }

  private send(cmd: MoveCommand): void {
    const stdin = this.agent?.stdin;
    if (!stdin || stdin.destroyed) return;
    stdin.write(`move ${cmd.hwnd} ${cmd.pid} ${cmd.x} ${cmd.y} ${cmd.width} ${cmd.height}\n`);
  }

  private load(): TilerState | null {
    try {
      return JSON.parse(readFileSync(this.opts.stateFile, 'utf8')) as TilerState;
    } catch {
      return null;
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref();
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.opts.stateFile), { recursive: true });
      const tmp = `${this.opts.stateFile}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.tiler.exportState()), 'utf8');
      renameSync(tmp, this.opts.stateFile);
    } catch (e) {
      log.warn(`[tiler] 상태 파일 쓰기 실패: ${(e as Error).message}`);
    }
  }
}
