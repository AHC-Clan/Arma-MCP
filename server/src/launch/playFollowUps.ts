// playFollowUps.ts — arma_play 가 인게임에 들어간 뒤 같은 호출 안에서 하는 일.
//
// 재실행 사이클마다 준비 로그 대기, 셋업 exec, 에러 검색을 따로 부르던 것을 한 호출로 묶는다.
// 호출부는 실행 lease 를 쥔 채로 이것을 부른다. 다른 세션의 실행과 겹치지 않는다.
//
// ready 는 이번 실행이 만든 RPT 에서만 찾는다. 이전 실행의 RPT 에 남은 같은 마커를
// 준비 완료로 오인하지 않기 위해서다. 새 RPT 가 없으면 기다리지 않고 실패한다.
//
// ready 나 then 이 실패해도 프로세스는 죽이지 않는다. 게임은 진단을 위해 그대로 둔다.

import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Deps } from '../mcp/deps.js';
import { makeSessionExecContext } from '../mcp/execContext.js';
import type { ExecMode, ExecOutcome } from '../exec/execManager.js';
import { extractErrorBlocks, waitForPattern, type ErrorBlock } from '../rpt/rptReader.js';
import type { LaunchResult } from './launcher.js';
import type { MpLaunchResult } from './mpLauncher.js';
import type { PlayResult } from './playOrchestrator.js';
import { READY_TIMEOUT_MAX_MS, READY_TIMEOUT_MIN_MS } from './launchProfiles.js';

export const READY_DEFAULT_TIMEOUT_MS = 60000;
export const THEN_DEFAULT_TIMEOUT_MS = 10000;
/** 이번 실행이 만든 RPT 가 없을 때의 ready 실패 사유. */
export const NO_NEW_RPT = 'newRpt 없음';
/** rpt 요약에 싣는 앞쪽 오류 블록 수. */
export const RPT_SUMMARY_BLOCKS = 3;
const WARNING_MESSAGE = 'Warning Message:';
/** 같은 CfgPatches 클래스가 두 번 정의됐을 때 엔진이 남기는 줄. 테스트 애드온 겹침의 흔적이다. */
const CONFLICTING_ADDON = 'Conflicting addon ';
const THEN_LABEL = 'arma_play then';

export interface PlayReadySpec {
  /** 기다릴 줄의 정규식. 대소문자를 가리지 않는다. */
  rpt: string;
  source?: 'client' | 'server';
  timeoutMs?: number;
}

export interface PlayThenSpec {
  code: string;
  mode?: ExecMode;
  target?: string;
  timeoutMs?: number;
}

export interface ReadyOutcome {
  ok: boolean;
  source: 'client' | 'server';
  pattern: string;
  file?: string;
  line?: string;
  lineNumber?: number;
  elapsedMs: number;
  skipped?: boolean;
  aborted?: boolean;
  reason?: string;
}

export interface ThenOutcome {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  /** arma_exec 와 같은 모양의 실행 결과. 실행하지 않았으면 없다. */
  exec?: ExecOutcome;
}

export interface RptSummary {
  file: string;
  errorBlocks: number;
  first: ErrorBlock[];
  warningMessages: number;
  /** "Conflicting addon" 줄 수. 같은 애드온이 두 번 로드됐다는 뜻이다. */
  conflictingAddons: number;
  /** 파일을 읽지 못했을 때만. */
  error?: string;
}

export interface PlayFollowUps {
  ok: boolean;
  error?: string;
  ready?: ReadyOutcome;
  then?: ThenOutcome;
  rpt: { client?: RptSummary; server?: RptSummary };
}

export type FollowUpDeps = Pick<Deps, 'exec' | 'rptSources' | 'session'>;

/** 이번 실행이 만든 RPT 경로. sp 는 새 클라 RPT, mp 는 새 클라 RPT 와 새 서버 RPT 다. */
export function launchRptFiles(result: PlayResult): { client?: string; server?: string } {
  if (!result.launch) return {};
  if (result.mode === 'sp') {
    const sp = result.launch as LaunchResult;
    return { client: sp.newRpt?.path };
  }
  const mp = result.launch as MpLaunchResult;
  return { client: mp.client?.rpt?.path, server: mp.server?.rpt?.path };
}

function readyPatternProblem(pattern: string): string | undefined {
  try {
    new RegExp(pattern, 'i');
    return undefined;
  } catch (e) {
    return `ready.rpt 정규식이 잘못됐다: ${(e as Error).message}`;
  }
}

/** ready 인자에서 실행 전에 걸러야 할 문제를 돌려준다. 문제가 없으면 undefined. */
export function readySpecProblem(spec: PlayReadySpec, mode: 'sp' | 'mp'): string | undefined {
  const pattern = readyPatternProblem(spec.rpt);
  if (pattern) return pattern;
  if (spec.source === 'server' && mode === 'sp') {
    return "ready.source 'server' 는 mp 모드에서만 쓴다. sp 에는 서버 RPT 가 없다.";
  }
  return undefined;
}

/** then 인자에서 실행 전에 걸러야 할 문제를 돌려준다. 문제가 없으면 undefined. */
export function thenSpecProblem(spec: PlayThenSpec): string | undefined {
  if (spec.mode === 'client' && !spec.target) {
    return "then.mode 'client' 에는 target 이 있어야 한다. 대상 플레이어 이름을 준다.";
  }
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function waitReady(
  spec: PlayReadySpec,
  files: { client?: string; server?: string },
  signal?: AbortSignal,
): Promise<ReadyOutcome> {
  const source = spec.source ?? 'client';
  const base = { source, pattern: spec.rpt };
  const file = files[source];
  if (!file) return { ...base, ok: false, elapsedMs: 0, reason: NO_NEW_RPT };
  if (signal?.aborted) {
    return { ...base, ok: false, file, elapsedMs: 0, aborted: true, reason: '대기가 취소되었다' };
  }
  const problem = readyPatternProblem(spec.rpt);
  if (problem) return { ...base, ok: false, file, elapsedMs: 0, reason: problem };

  const timeoutMs = clamp(
    spec.timeoutMs ?? READY_DEFAULT_TIMEOUT_MS,
    READY_TIMEOUT_MIN_MS,
    READY_TIMEOUT_MAX_MS,
  );
  // 파일의 처음부터 본다. 이번 실행의 RPT 라 앞부분도 모두 이번 실행의 기록이다.
  const wait = await waitForPattern(path.dirname(file), {
    pattern: spec.rpt,
    file,
    fromEnd: false,
    timeoutMs,
    signal,
  });
  if (wait.found) {
    return {
      ...base,
      ok: true,
      file,
      line: wait.line?.trim(),
      lineNumber: wait.lineNumber,
      elapsedMs: wait.elapsedMs,
    };
  }
  if (wait.aborted || signal?.aborted) {
    return {
      ...base,
      ok: false,
      file,
      elapsedMs: wait.elapsedMs,
      aborted: true,
      reason: '대기가 취소되었다',
    };
  }
  return {
    ...base,
    ok: false,
    file,
    elapsedMs: wait.elapsedMs,
    reason: wait.file
      ? `${timeoutMs}ms 안에 패턴이 나오지 않았다`
      : 'RPT 파일을 열지 못했다',
  };
}

async function runThen(
  deps: FollowUpDeps,
  spec: PlayThenSpec,
  signal?: AbortSignal,
): Promise<ThenOutcome> {
  // arma_exec 와 같은 경로다. 주석 제거와 RPT 오류 첨부가 그대로 적용된다.
  // 사용자 코드이므로 세션의 lastExec 커서를 이 실행으로 옮긴다.
  const context = makeSessionExecContext(deps, (cursor) => {
    deps.session.lastExecCursor = cursor;
  });
  if (signal) context.signal = signal;
  const exec = await deps.exec.run({
    code: spec.code,
    mode: spec.mode,
    target: spec.target,
    timeoutMs: spec.timeoutMs ?? THEN_DEFAULT_TIMEOUT_MS,
    label: THEN_LABEL,
    context,
  });
  const errorResult = exec.results.find((r) => r.parsed.kind === 'error');
  if (!exec.ok) return { ok: false, reason: exec.error ?? '결과가 오지 않았다', exec };
  if (errorResult) return { ok: false, reason: errorResult.result, exec };
  if (exec.rptErrors.length > 0) {
    return { ok: false, reason: '실행 구간 RPT 에 SQF 오류 블록이 남았다', exec };
  }
  return { ok: true, exec };
}

async function countLines(file: string): Promise<{ warningMessages: number; conflictingAddons: number }> {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let warningMessages = 0;
  let conflictingAddons = 0;
  try {
    for await (const line of rl) {
      if (line.includes(WARNING_MESSAGE)) warningMessages += 1;
      if (line.includes(CONFLICTING_ADDON)) conflictingAddons += 1;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { warningMessages, conflictingAddons };
}

export async function summarizeRpt(file: string): Promise<RptSummary> {
  try {
    const [blocks, counts] = await Promise.all([extractErrorBlocks(file, 0), countLines(file)]);
    return {
      file,
      errorBlocks: blocks.errors.length,
      first: blocks.errors.slice(0, RPT_SUMMARY_BLOCKS),
      warningMessages: counts.warningMessages,
      conflictingAddons: counts.conflictingAddons,
    };
  } catch (e) {
    return {
      file,
      errorBlocks: 0,
      first: [],
      warningMessages: 0,
      conflictingAddons: 0,
      error: (e as Error).message,
    };
  }
}

/**
 * ready 대기, then 실행, rpt 요약을 차례로 한다. dryRun 이 아닌 실행 뒤에 부른다.
 *
 * 인게임 진입에 실패한 실행이면 ready 와 then 은 건너뛰고 rpt 요약만 붙인다.
 * ready 가 실패하면 then 도 건너뛴다. 셋업 코드는 준비가 끝난 게임을 전제로 하기 때문이다.
 */
export async function runPlayFollowUps(
  deps: FollowUpDeps,
  result: PlayResult,
  specs: { ready?: PlayReadySpec; then?: PlayThenSpec },
  signal?: AbortSignal,
): Promise<PlayFollowUps> {
  const files = launchRptFiles(result);
  const out: PlayFollowUps = { ok: true, rpt: {} };
  const notInGame = '인게임 진입을 확인하지 못해 건너뛰었다';

  if (specs.ready) {
    out.ready = result.ok
      ? await waitReady(specs.ready, files, signal)
      : {
          ok: false,
          source: specs.ready.source ?? 'client',
          pattern: specs.ready.rpt,
          elapsedMs: 0,
          skipped: true,
          reason: notInGame,
        };
  }

  if (specs.then) {
    if (!result.ok) {
      out.then = { ok: false, skipped: true, reason: notInGame };
    } else if (out.ready && !out.ready.ok) {
      out.then = { ok: false, skipped: true, reason: 'ready 가 실패해 실행하지 않았다' };
    } else if (signal?.aborted) {
      out.then = { ok: false, skipped: true, reason: '취소되어 실행하지 않았다' };
    } else {
      out.then = await runThen(deps, specs.then, signal);
    }
  }

  // 요약은 then 뒤에 만든다. 셋업 코드가 남긴 오류도 함께 세기 위해서다.
  const [client, server] = await Promise.all([
    files.client ? summarizeRpt(files.client) : Promise.resolve(undefined),
    files.server ? summarizeRpt(files.server) : Promise.resolve(undefined),
  ]);
  if (client) out.rpt.client = client;
  if (server) out.rpt.server = server;

  if (out.ready && !out.ready.ok) {
    out.ok = false;
    out.error = `ready 실패: ${out.ready.reason ?? '사유 미상'}`;
  } else if (out.then && !out.then.ok) {
    out.ok = false;
    out.error = `then 실패: ${out.then.reason ?? '사유 미상'}`;
  }
  return out;
}
