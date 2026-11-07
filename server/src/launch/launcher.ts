// launcher.ts — Arma 3 실행/종료. debug-run.ps1 을 TS 로 포팅.
//
// 핵심:
//  - 모드셋 구성(rpt 헤더 복원/modSwaps/selfModPath 보장)은 mods.ts 로 분리 —
//    mpLauncher(데디 서버+클라)와 동일 로직을 공유한다.
//  - -autotest cfg 로 미션 자동 로드.
//  - spawn 은 windowsVerbatimArguments 단일 문자열: -mod="a;J:\Program Files..." 처럼
//    값에 공백/괄호가 있어 Node 기본 배열 인용으로는 깨지기 때문.

import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { newestRpt, rptAfter } from '../rpt/rptFiles.js';
import { createDirWatcher } from '../rpt/rptWatch.js';
import {
  CLIENT_IMAGE,
  KILL_WAIT_MS,
  isProcRunningAsync,
  killProcAsync,
  waitProcGone,
  invalidateProcCache,
} from '../procs.js';
import type { MpProcFns } from './mpLauncher.js';
import { resolveModset } from './mods.js';
import { battlEyeExeProblem } from './battlEye.js';
import {
  clientStackArgs,
  clientWindowSize,
  flagsIn,
  planLaunchTestMods,
  prepareClientProfile,
  stackOwnedIn,
  stackSpawnEnv,
  stripStackOwned,
  withNoPause,
  type LaunchStackOptions,
} from './stackArgs.js';
import { log } from '../log.js';
import { planSummary, stageTestMods, type StageResult } from '../stack/testMods.js';
import { spawnDetached } from './spawn.js';
import { noteLaunchedClient, plannedTileSizes } from '../tiler/tilerService.js';
import { DEFAULT_STACK_ID } from '../stack/stackContext.js';
import { combineAbortSignals } from '../mcp/abort.js';

export interface LaunchOptions {
  mission?: string;
  modset?: 'rpt' | 'explicit' | 'none';
  mods?: string[];
  worldEmpty?: boolean;
  killRunning?: boolean;
  extraArgs?: string[];
  dryRun?: boolean;
  waitForNewRptMs?: number;
  /** 새로 빌드한 PBO 나 작은 모드 폴더. 스택 전용 테스트 애드온으로 복사해 붙인다. */
  testMods?: string[];
  /** Internal process-wide launch cancellation; not exposed as MCP input. */
  signal?: AbortSignal;
}

export interface LaunchResult {
  ok: boolean;
  error?: string;
  launched: boolean;
  dryRun: boolean;
  pid?: number;
  modSource: string;
  modCount: number;
  mods: string[];
  argString: string;
  prevNewestRpt: string;
  newRpt?: { name: string; path: string };
  warning?: string;
  /** 테스트 애드온. dryRun 은 계획, 실제 실행은 만든 결과다. */
  testMods?: StageResult;
}

/** 실행 가드가 쓰는 프로세스 함수. 스택 런타임은 그 스택 프로세스만 보는 판을 넣는다. */
export type LauncherProcFns = Pick<MpProcFns, 'isProcRunningAsync' | 'killProcAsync' | 'waitProcGone'>;

const DEFAULT_LAUNCHER_PROCS: LauncherProcFns = {
  isProcRunningAsync,
  killProcAsync,
  waitProcGone,
};

export class Launcher {
  private procs: LauncherProcFns;

  constructor(
    private cfg: Config,
    private rptDir: string,
    procs: Partial<LauncherProcFns> = {},
    /** 스택 런타임이 넣는다. 없으면 0.4 와 같게 돈다. */
    private stack?: LaunchStackOptions,
  ) {
    this.procs = { ...DEFAULT_LAUNCHER_PROCS, ...procs };
  }

  private resolveMissionPath(mission: string): string | null {
    if (path.isAbsolute(mission) || /[\\/]/.test(mission)) {
      return existsSync(mission) ? path.resolve(mission) : null;
    }
    if (this.cfg.arma.missionsDir) {
      const candidate = path.join(this.cfg.arma.missionsDir, mission);
      if (existsSync(candidate)) return path.resolve(candidate);
    }
    return null;
  }

  private buildAutotestCfg(missionPath: string): { path: string; text: string } {
    const missionKey = createHash('sha256')
      .update(path.resolve(missionPath).toLowerCase())
      .digest('hex')
      .slice(0, 16);
    const cfgPath = path.join(tmpdir(), `arma-mcp-autotest-${missionKey}.cfg`);
    const escaped = missionPath.replace(/"/g, '""');
    const text = `class TestMissions\n{\n    class AutoMission\n    {\n        campaign = "";\n        mission = "${escaped}";\n    };\n};\n`;
    return { path: cfgPath, text };
  }

  killRunning(): Promise<{ killed: boolean; detail: string }> {
    return this.procs.killProcAsync(CLIENT_IMAGE);
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult> {
    const exeProblem = battlEyeExeProblem(this.cfg.arma.exePath);
    if (exeProblem) return this.fail(exeProblem, '', [], '');
    const ctx = this.stack?.ctx;
    const named = ctx !== undefined && !ctx.isDefault;
    if (named) {
      // -profiles 가 스택 소속의 표시라 호출 인자가 덮으면 그 게임을 스택이 잃는다.
      const owned = stackOwnedIn(opts.extraArgs);
      if (owned.length > 0) {
        return this.fail(
          `스택 ${ctx.id} 에서는 스택이 정하는 인자를 줄 수 없다: ${owned.join(' ')}`,
          '',
          [],
          '',
        );
      }
    }
    const { modString, modSource, warning } = resolveModset(
      this.cfg,
      this.stack?.modsetRptDir ?? this.rptDir,
      opts,
      { stacksRoot: this.stack?.stacksRoot },
    );
    let mods = modString.split(';').filter(Boolean);
    const testPlan = await planLaunchTestMods(this.stack, this.cfg, mods, opts.testMods);
    if (!testPlan.ok) return this.fail(testPlan.error, modSource, mods, '');
    if (testPlan.plan) mods = testPlan.plan.mods;
    const finalModString = mods.join(';');

    // 인자 조립. 스택 클라는 제 profiles 폴더와 이름을 받는다(default 스택은 0.4 그대로).
    const baseFlags = named ? stripStackOwned(this.cfg.arma.baseArgs) : [...this.cfg.arma.baseArgs];
    if (ctx) baseFlags.push(...clientStackArgs(ctx, 1));
    if (opts.worldEmpty) baseFlags.push('-world=empty');
    if (opts.extraArgs) baseFlags.push(...opts.extraArgs);

    let autotestCfg: { path: string; text: string } | null = null;
    if (opts.mission) {
      const missionPath = this.resolveMissionPath(opts.mission);
      if (!missionPath) {
        return this.fail(`mission not found: ${opts.mission}`, modSource, mods, '');
      }
      autotestCfg = this.buildAutotestCfg(missionPath);
      baseFlags.push(`-autotest="${autotestCfg.path}"`);
    }

    // 창이 포커스를 잃어도 게임이 멈추지 않게 한다. 설정에 이미 있으면 그대로 둔다.
    const argParts = withNoPause(baseFlags);
    if (finalModString) argParts.push(`-mod="${finalModString}"`);
    const argString = argParts.join(' ');

    const prevNewest = newestRpt(this.rptDir);
    const prevNewestName = prevNewest ? prevNewest.name : '(none)';

    const base: LaunchResult = {
      ok: true,
      launched: false,
      dryRun: !!opts.dryRun,
      modSource,
      modCount: mods.length,
      mods,
      argString,
      prevNewestRpt: prevNewestName,
      warning,
      ...(testPlan.plan ? { testMods: planSummary(testPlan.plan) } : {}),
    };

    if (opts.dryRun) {
      log.info('[launch] dryRun', argString);
      return base;
    }

    // 이미 실행 중 검사(캐시 무시 — 정확성 우선).
    if (await this.procs.isProcRunningAsync(CLIENT_IMAGE, true)) {
      if (opts.signal?.aborted) {
        return { ...base, ok: false, error: abortMessage(opts.signal) };
      }
      if (opts.killRunning) {
        const killed = await this.procs.killProcAsync(CLIENT_IMAGE);
        // 고정 대기 대신 실제로 사라질 때까지만 기다린다(보통 수백 ms, 대형 모드팩은 수 초).
        const gone = await this.procs.waitProcGone(CLIENT_IMAGE, KILL_WAIT_MS, 150);
        if (!gone) {
          return {
            ...base,
            ok: false,
            error: `기존 arma3_x64.exe가 종료되지 않아 새 프로세스를 시작하지 않음: ${killed.detail}`,
          };
        }
      } else {
        return {
          ...base,
          ok: false,
          error: 'arma3_x64 가 이미 실행 중 (killRunning:true 로 강제 종료 가능)',
        };
      }
    }

    if (opts.signal?.aborted) {
      return { ...base, ok: false, error: abortMessage(opts.signal) };
    }

    if (!existsSync(this.cfg.arma.exePath)) {
      return { ...base, ok: false, error: `Arma3 실행파일 없음: ${this.cfg.arma.exePath}` };
    }
    if (named && this.stack?.bridgeGate) {
      const problem = await this.stack.bridgeGate();
      if (problem) return { ...base, ok: false, error: problem };
    }
    if (testPlan.plan && ctx) {
      // 스택 게임이 모두 꺼진 뒤라 이전 스냅샷을 바꿀 수 있다.
      const staged = await stageTestMods(testPlan.plan, { stackRoot: ctx.root, signal: opts.signal });
      base.testMods = staged;
      if (!staged.ok) return { ...base, ok: false, error: staged.error };
    }
    if (ctx) {
      // 다른 게임 창이 떠 있어 타일러가 이 창을 칸에 놓을 거면 처음부터 칸 크기로 띄운다.
      // 게임은 시작 중에 바뀐 창 크기를 렌더 해상도에 반영하지 않아, 설정 크기로 띄우면 그 해상도로 칸에 눌려 그려진다.
      const ownProfile = ctx.clientProfilesDir(1);
      const userSize = flagsIn([...this.cfg.arma.baseArgs, ...(opts.extraArgs ?? [])], ['-x', '-y']).length > 0;
      const tileSize =
        ownProfile && !userSize && this.cfg.windowTiler.enabled
          ? (this.stack?.tilePlan ?? plannedTileSizes)(ctx.id, 1)?.[0] ?? null
          : null;
      if (tileSize) log.info(`[launch] 창 타일러 칸 크기로 띄움: ${tileSize.width}x${tileSize.height} (스택 ${ctx.id})`);
      await prepareClientProfile(ownProfile, { window: tileSize ?? clientWindowSize(this.cfg) });
    }

    if (autotestCfg) {
      try {
        writeFileSync(autotestCfg.path, autotestCfg.text, 'ascii');
      } catch (error) {
        return {
          ...base,
          ok: false,
          error: `autotest cfg 기록 실패: ${(error as Error).message}`,
        };
      }
    }

    // spawn: 단일 문자열 verbatim (mod 경로 인용부호 보존).
    let processRef;
    try {
      processRef = await spawnDetached(this.cfg.arma.exePath, [argString], {
        windowsVerbatimArguments: true,
        ...(ctx ? { env: stackSpawnEnv(ctx) } : {}),
      });
      invalidateProcCache();
    } catch (e) {
      return { ...base, ok: false, error: 'spawn 실패: ' + (e as Error).message };
    }
    const pid = processRef.pid;
    log.info(`[launch] launched pid=${pid} modSource=${modSource} mods=${mods.length}`);
    noteLaunchedClient({
      pid,
      stack: ctx?.id ?? DEFAULT_STACK_ID,
      label: ctx?.clientName(1) ?? ctx?.id ?? DEFAULT_STACK_ID,
    });

    // 새 RPT 대기(옵션).
    const result: LaunchResult = { ...base, launched: true, pid };
    const waitMs = opts.waitForNewRptMs ?? 30000;
    if (waitMs > 0) {
      const waitSignal = combineAbortSignals(opts.signal, processRef.exitSignal);
      try {
        const found = await this.waitForNewRpt(prevNewestName, waitMs, waitSignal.signal);
        if (found) {
          result.newRpt = { name: found.name, path: found.path };
        } else if (opts.signal?.aborted) {
          result.ok = false;
          result.error = abortMessage(opts.signal);
        } else if (processRef.exitSignal.aborted) {
          result.ok = false;
          result.error = `Arma 프로세스가 새 RPT 생성 전에 종료됨: ${abortMessage(processRef.exitSignal)}`;
        }
      } finally {
        waitSignal.dispose();
      }
    }
    return result;
  }

  private async waitForNewRpt(
    prevName: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ name: string; path: string } | null> {
    const deadline = Date.now() + timeoutMs;
    // watch 는 조기 기상 신호일 뿐 — 유실 시 250ms 폴링이 안전망(rptWatch.ts 헤더).
    const watcher = createDirWatcher(this.rptDir);
    try {
      while (!signal?.aborted && Date.now() < deadline) {
        const after = rptAfter(this.rptDir, prevName);
        if (after) return { name: after.name, path: after.path };
        await watcher.wait(250, signal);
      }
      return null;
    } finally {
      watcher.dispose();
    }
  }

  private fail(error: string, modSource: string, mods: string[], argString: string): LaunchResult {
    return {
      ok: false,
      error,
      launched: false,
      dryRun: false,
      modSource,
      modCount: mods.length,
      mods,
      argString,
      prevNewestRpt: '',
    };
  }
}

function abortMessage(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : 'launch operation aborted';
}
