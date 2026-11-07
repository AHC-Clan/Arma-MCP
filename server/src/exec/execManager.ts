// execManager.ts — SQF exec 요청의 발급/상관/타임아웃/RPT 크로스레퍼런스.
//
// 흐름:
//   1. 주석 제거(strip) 또는 거부(reject), 크기 검사
//   2. reqId 발급, 전송 직전 최신 RPT 커서 기록
//   3. pending 등록 → 그 다음 전송 (빠른 결과가 등록을 앞지르는 레이스 방지)
//   4. execResult(reqId 일치) 수신: server/client 는 첫 결과로 완료,
//      all 은 expectN 도달 또는 타임아웃 창까지 수집
//   5. 완료 후 checkRpt 면 커서~EOF 의 Error in expression 블록을 첨부
//      (nil, ERROR 결과와 결과 없는 타임아웃은 checkRpt 와 무관하게 첨부)
//   6. 게이트웨이 단절 시 모든 pending 즉시 실패

import { randomBytes } from 'node:crypto';
import type { Gateway, GatewayFrame } from '../ipc/gateway.js';
import { sanitizeSqf, CommentRejectedError } from './sanitize.js';
import { buildVerifySqf, parseVerifyAck } from './sqfWrap.js';
import { ackOf } from '../mcp/sqfLiteral.js';
import { newestRptAsync } from '../rpt/rptFiles.js';
import {
  extractErrorBlocks,
  waitForTextAfter,
  type ErrorBlock,
  type RptCursor,
} from '../rpt/rptReader.js';
import { log } from '../log.js';
import type { ResolvedRptSource } from '../rpt/rptSource.js';

export type ExecMode = 'server' | 'all' | 'client';

export interface ExecOptions {
  code: string;
  mode?: ExecMode;
  target?: string;
  timeoutMs?: number;
  expectN?: number;
  /** all 모드: 마지막 결과 후 이 시간(ms) 동안 무응답이면 조기 완료. 0=비활성, 기본 800. */
  allQuietMs?: number;
  label?: string;
  comments?: 'strip' | 'reject';
  checkRpt?: boolean;
  /**
   * code 실행 후 격리 실행할 증거 표현식. 여기서 타입 오류가 나도 code 의 결과는 돌아온다.
   * server 모드에서만 적용된다.
   */
  verify?: string;
  /** MCP transport/session metadata. This is intentionally not part of the public tool schema. */
  context?: ExecRequestContext;
}

export interface ExecRequestContext {
  sessionId: string;
  sessionShortId: string;
  signal?: AbortSignal;
  onRptCursor?: (cursor: RptCursor | null) => void;
  rptDir?: string;
  rptRe?: RegExp;
  rptSource?: ResolvedRptSource;
}

export interface ParsedResult {
  kind: 'value' | 'nil' | 'error';
  type?: string;
  value?: string;
}

export interface ExecResultEntry {
  machine: string;
  result: string;
  parsed: ParsedResult;
}

export type ExecCompletedBy =
  | 'first'
  | 'expectN'
  | 'quiet'
  | 'timeout'
  | 'disconnect'
  | 'cancelled';

export interface ExecOutcome {
  ok: boolean;
  error?: string;
  timedOut: boolean;
  /** 무엇이 대기를 끝냈는지 — first(단일 결과)/expectN(목표 수 도달)/quiet(정지 창)/timeout/disconnect. */
  completedBy?: ExecCompletedBy;
  durationMs: number;
  reqId: string;
  results: ExecResultEntry[];
  rptErrors: ErrorBlock[];
  /**
   * 이 실행이 보내기 직전에 잡은 RPT 커서. RPT 가 없거나 커서를 잡기 전에 멈췄으면 null 이다.
   * arma_rpt_wait 의 file 과 fromOffset 에 넘기면 이 실행 뒤 출력만 본다.
   * 세션이 호출마다 새로 열리면 since:'lastExec' 가 이어지지 않으므로 이 값으로 잇는다.
   */
  rptCursor: RptCursor | null;
  sanitized: boolean;
  resolvedSource?: ResolvedRptSource;
  /** Concurrent executions share an RPT stream, so time-window attribution is best-effort. */
  rptAttribution?: string;
  note?: string;
  /** verify 를 준 경우에만. 본문 결과와 독립적으로 판정된다. */
  verify?: {
    result: string;
    parsed: ParsedResult;
    truncated: boolean;
  };
}

interface Pending {
  mode: ExecMode;
  expectN: number;
  quietMs: number;
  results: ExecResultEntry[];
  resolve: (v: void) => void;
  timer: NodeJS.Timeout;
  quietTimer?: NodeJS.Timeout;
  timedOut: boolean;
  completedBy?: ExecCompletedBy;
  sessionId: string;
  settled: boolean;
  reason?: string;
}

/** 게임에 보내지 못한 실행의 error. arma_exec 의 capture 는 이 값이면 찍지 않는다. */
export const GAME_NOT_CONNECTED = 'game not connected';

const TIMEOUT_MIN = 500;
const TIMEOUT_MAX = 600000;
const RPT_ATTRIBUTION_NOTE =
  'RPT 오류는 실행 시간 구간으로 연관되므로 동시 실행의 오류가 함께 포함될 수 있습니다.';
const SILENT_TIMEOUT_NOTE =
  '결과가 오지 않았다. 하드 SQF 오류로 스크립트가 중단됐을 수 있어 실행 구간 RPT 오류 블록을 담았다.';
/** 감사 로그 줄을 기다리는 상한(ms). 보통은 결과가 도착한 뒤 수백 ms 안에 기록된다. */
const AUDIT_LINE_WAIT_MS = 1500;

/**
 * 애드온 fn_execResultIn.sqf 의 감사 줄 "[EXEC] result <- <machine> (reqId=<id>): ..." 을 기다린다.
 *
 * 파일 크기로 미리 판단하지 않는다. Arma 는 결과 프레임이 데몬에 닿은 뒤에 RPT 를 쓰므로,
 * 결과를 받은 시점에는 전송 감사 줄조차 아직 없는 경우가 많다(실게임에서 확인).
 * 그 시점의 크기를 보고 건너뛰면 뒤이어 기록되는 오류 블록을 놓친다.
 * -noLogs 처럼 RPT 가 전혀 자라지 않으면 상한까지 기다린다.
 * 그 비용은 스캔하는 결과(nil, ERROR, checkRpt)에만 든다.
 */
async function waitForAuditLine(cursor: RptCursor, reqId: string): Promise<void> {
  await waitForTextAfter(cursor.file, cursor.offset, `reqId=${reqId})`, AUDIT_LINE_WAIT_MS);
}

export function parseResult(result: string): ParsedResult {
  if (result.startsWith('<nil>')) return { kind: 'nil' };
  if (result.startsWith('ERROR:')) return { kind: 'error', value: result };
  const idx = result.indexOf(': ');
  if (idx > 0) {
    return { kind: 'value', type: result.slice(0, idx), value: result.slice(idx + 2) };
  }
  return { kind: 'value', value: result };
}

export class ExecManager {
  private pending = new Map<string, Pending>();

  constructor(
    private gateway: Gateway,
    private rptDir: string,
    private defaults: { defaultTimeoutMs: number; maxCodeBytes: number },
    /**
     * all 모드에서 기대 응답 머신 수를 유도(서버 1 + playerCount + hcCount 등).
     * 확신이 없으면 null — 과소 유도는 조기완료로 결과를 누락시킨다(quiet-window 가 보조).
     * async 유도(stale 시 telemetryRequest 왕복)를 허용한다.
     */
    private getExpectedMachines?: () => number | null | Promise<number | null>,
  ) {
    gateway.on('execResult', (m) => this.onResult(m));
    gateway.on('disconnected', () => this.failAll('game link dropped (mission ended?)'));
  }

  private lastCursor: RptCursor | null = null;

  /** arma_rpt_errors 의 since:'lastExec' 가 참조하는 커서. */
  lastExecCursor(): RptCursor | null {
    return this.lastCursor;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  async run(opts: ExecOptions): Promise<ExecOutcome> {
    const t0 = Date.now();
    const mode = opts.mode ?? 'server';
    const commentMode = opts.comments ?? 'strip';
    // 기본 false: 성공한 exec 에서 RPT 를 훑어봐야 나오는 게 없다(실측 515콜 중 0건).
    // 정말 필요한 경우는 아래 anyNilOrError 분기가 여전히 강제 스캔하므로,
    // "<nil> 는 모호하니 RPT 블록을 진실의 원천으로" 계약은 그대로 유지된다.
    const checkRpt = opts.checkRpt ?? false;
    const context = opts.context;
    const rptDir = context?.rptDir ?? this.rptDir;
    const rptRe = context?.rptRe;
    // verify 는 server 모드에서만 의미가 있다 — all/client 는 머신마다 결과가 오므로
    // "본문 + 증거" 한 쌍이라는 프레이밍이 성립하지 않는다.
    const verifyExpr =
      opts.verify && opts.verify.trim() !== '' && mode === 'server' ? opts.verify : undefined;
    const verifyStepSec = Math.max(1, Math.round((opts.timeoutMs ?? 5000) / 1000));
    const emptyResult = (error: string): ExecOutcome => ({
      ok: false,
      error,
      timedOut: false,
      durationMs: Date.now() - t0,
      reqId: '',
      results: [],
      rptErrors: [],
      rptCursor: null,
      sanitized: false,
      resolvedSource: context?.rptSource,
    });

    if (!opts.code || opts.code.trim() === '') return emptyResult('empty code');
    if (context?.signal?.aborted) return emptyResult('client session closed');
    if (mode === 'client' && !opts.target) {
      return emptyResult("mode 'client' requires target (player name)");
    }

    // 1. 주석 처리.
    //
    // 순서가 중요하다: verify 래핑을 쓰면 사용자 코드가 SQF 문자열 리터럴 안으로 들어가는데,
    // sanitizeSqf 는 리터럴 내부를 건드리지 않는다. 조립 뒤에 sanitize 하면 리터럴 안의
    // 주석이 살아남아 인게임 compile 이 조용히 <nil> 로 파손된다 — sanitize.ts 가 막으려던
    // 바로 그 실패가 한 층 아래에서 재발한다. 그래서 조각을 먼저 정리하고 나중에 조립한다.
    let code: string;
    let sanitized = false;
    try {
      const s = sanitizeSqf(opts.code, commentMode);
      code = s.code;
      sanitized = s.changed;
      if (verifyExpr !== undefined) {
        const v = sanitizeSqf(verifyExpr, commentMode);
        sanitized = sanitized || v.changed;
        code = buildVerifySqf({ code, verify: v.code, stepSec: verifyStepSec });
      }
    } catch (e) {
      if (e instanceof CommentRejectedError) {
        return emptyResult(`comment rejected: ${e.message}`);
      }
      throw e;
    }

    const bytes = Buffer.byteLength(code, 'utf8');
    if (bytes > this.defaults.maxCodeBytes) {
      return emptyResult(`code too large: ${bytes} bytes (max ${this.defaults.maxCodeBytes})`);
    }

    // 2. reqId + RPT 커서.
    const randomId = randomBytes(6).toString('hex');
    const sessionTag = safeSessionTag(context?.sessionShortId);
    const reqId = sessionTag ? `${sessionTag}-${randomId}` : randomId;
    // 동기 스캔은 데몬 이벤트 루프(전 세션 공유)를 막는다 — 비동기판 사용.
    const cursorFile = await newestRptAsync(rptDir, rptRe);
    const cursor: RptCursor | null = cursorFile
      ? { file: cursorFile.path, offset: cursorFile.sizeBytes }
      : null;
    if (context?.onRptCursor) context.onRptCursor(cursor);
    else this.lastCursor = cursor;

    const timeoutMs = clamp(
      opts.timeoutMs ?? (mode === 'all' ? 3000 : this.defaults.defaultTimeoutMs),
      TIMEOUT_MIN,
      TIMEOUT_MAX,
    );
    let expectN = mode === 'all' ? Math.max(0, opts.expectN ?? 0) : 1;
    // expectN 미지정 시 텔레메트리 기반 유도(있으면 도달 즉시 완료).
    if (mode === 'all' && expectN === 0 && this.getExpectedMachines) {
      const derived = await this.getExpectedMachines();
      if (derived && derived > 0) expectN = derived;
    }
    // quiet-window: 마지막 결과 후 이 시간 무응답이면 조기 완료(0=비활성).
    const quietMs =
      mode === 'all' && (opts.allQuietMs ?? 800) > 0
        ? clamp(opts.allQuietMs ?? 800, 100, timeoutMs)
        : 0;

    // 3. pending 등록 (전송 전).
    const done = new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.finish(reqId, 'timeout'), timeoutMs);
      this.pending.set(reqId, {
        mode,
        expectN,
        quietMs,
        results: [],
        resolve,
        timer,
        timedOut: false,
        sessionId: context?.sessionId ?? 'standalone',
        settled: false,
      });
    });

    const onAbort = (): void => {
      this.finish(reqId, 'cancelled', 'client session closed');
    };
    context?.signal?.addEventListener('abort', onAbort, { once: true });

    // 전송.
    const frame = {
      v: 1,
      type: 'exec',
      reqId,
      mode,
      target: opts.target ?? '',
      code,
      label: auditLabel(opts.label, sessionTag),
    };
    const sent = this.gateway.send(frame);
    if (!sent) {
      const p = this.pending.get(reqId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(reqId);
      }
      context?.signal?.removeEventListener('abort', onAbort);
      return { ...emptyResult(GAME_NOT_CONNECTED), reqId, sanitized, rptCursor: cursor };
    }
    log.debug(`[exec] sent reqId=${reqId} mode=${mode} bytes=${bytes}`);

    // 4. 완료 대기.
    await done;
    context?.signal?.removeEventListener('abort', onAbort);
    const p = this.pending.get(reqId);
    this.pending.delete(reqId);
    let results = p?.results ?? [];
    const timedOut = p?.timedOut ?? false;

    // 4b. verify 래핑을 썼으면 두 값을 되꺼내 results 를 평소 모양으로 되돌린다 —
    // 호출부가 verify 사용 여부에 따라 다른 파싱을 하지 않아도 되게 한다.
    let verifyOut: ExecOutcome['verify'];
    if (verifyExpr !== undefined && results.length > 0) {
      const v = parseVerifyAck(ackOf(results[0]?.parsed?.value));
      if (v) {
        verifyOut = {
          result: v.verify,
          parsed: parseResult(v.verify),
          truncated: v.verifyTruncated,
        };
        results = results.map((r, i) =>
          i === 0 ? { machine: r.machine, result: v.main, parsed: parseResult(v.main) } : r,
        );
      }
    }
    const completedBy = p?.completedBy;

    // 5. RPT 에러 블록 첨부.
    let rptErrors: ErrorBlock[] = [];
    const isNilOrError = (r: ExecResultEntry): boolean =>
      r.parsed.kind === 'nil' || r.parsed.kind === 'error';
    const anyNilOrError = results.some(isNilOrError);
    // 결과 없이 시간이 다 됐으면 하드 SQF 오류로 스크립트가 중단됐을 수 있다.
    // 에이전트가 arma_rpt_errors 를 따로 부르지 않게 같은 호출에 근거를 담는다.
    const silentTimeout = timedOut && results.length === 0;
    if ((checkRpt || anyNilOrError || silentTimeout) && cursor) {
      try {
        // 결과 프레임은 애드온의 감사 로그 줄보다 먼저 도착한다. 오류 블록은 그 줄보다 앞에 기록되므로
        // 감사 줄이 보일 때까지 잠깐 기다린 뒤 스캔해야 블록을 놓치지 않는다.
        // 감사 줄은 결과를 모으는 서버 쪽 RPT 에 남는다. 결과의 machine 이 무엇이든 같다.
        // 커서 RPT 가 바로 그 파일이다. 데디 서버면 서버 RPT 이고, sp 와 호스트 게임은 클라 RPT 가 서버 RPT 다.
        // sp 와 호스트 게임의 결과 machine 은 'server' 가 아니라 플레이어 이름이다.
        // 결과가 하나도 없으면 감사 줄도 없으므로 기다리지 않는다.
        if (results.length > 0) {
          await waitForAuditLine(cursor, reqId);
        }
        const ext = await extractErrorBlocks(cursor.file, cursor.offset);
        rptErrors = ext.errors;
      } catch (e) {
        log.warn('[exec] RPT 에러 스캔 실패: ' + (e as Error).message);
      }
    }

    let note: string | undefined;
    if (anyNilOrError && rptErrors.length === 0) {
      note =
        "<nil> 는 정상 nil 이거나 엔진이 삼킨 soft error 일 수 있습니다. RPT 에 'Error in expression' 이 없으면 정상 nil 로 간주하세요.";
    } else if (silentTimeout && rptErrors.length > 0) {
      note = SILENT_TIMEOUT_NOTE;
    }

    const interrupted = completedBy === 'disconnect' || completedBy === 'cancelled';
    const ok = results.length > 0 && !interrupted;
    return {
      ok,
      error: ok
        ? undefined
        : p?.reason ?? (timedOut ? 'no result (timed out)' : 'no result'),
      timedOut,
      completedBy,
      durationMs: Date.now() - t0,
      reqId,
      results,
      rptErrors,
      rptCursor: cursor,
      sanitized,
      resolvedSource: context?.rptSource,
      // 첨부된 블록이 있을 때만 귀속 주의를 단다 — 깨끗한 성공 결과마다 붙으면
      // 읽을 RPT 가 없는데도 에이전트를 RPT 조회로 유인한다.
      rptAttribution: rptErrors.length > 0 ? RPT_ATTRIBUTION_NOTE : undefined,
      note:
        note ??
        (verifyOut && verifyOut.parsed.kind !== 'value'
          ? '검증식이 값을 내지 못했습니다(본문은 별개로 판정됨). ' +
            "rptErrors 의 'Error in expression' 을 확인하세요 — " +
            '`round <배열>`, `taskState "<문자열>"` 같은 타입 오류가 가장 흔합니다.'
          : undefined),
      verify: verifyOut,
    };
  }

  private onResult(m: GatewayFrame): void {
    const reqId = String(m.reqId ?? '');
    const p = this.pending.get(reqId);
    if (!p || p.settled) return; // 이미 완료됐거나 우리 것이 아님.
    const result = String(m.result ?? '');
    p.results.push({
      machine: String(m.machine ?? '?'),
      result,
      parsed: parseResult(result),
    });
    // server/client 는 첫 결과로 완료. all 은 expectN 도달 시 조기 완료,
    // 아니면 quiet-window(마지막 결과 후 무응답 창) 재설정.
    if (p.mode !== 'all') {
      this.finish(reqId, 'first');
    } else if (p.expectN > 0 && p.results.length >= p.expectN) {
      this.finish(reqId, 'expectN');
    } else if (p.quietMs > 0) {
      if (p.quietTimer) clearTimeout(p.quietTimer);
      p.quietTimer = setTimeout(() => this.finish(reqId, 'quiet'), p.quietMs);
    }
  }

  private finish(reqId: string, by: ExecCompletedBy, reason?: string): void {
    const p = this.pending.get(reqId);
    if (!p || p.settled) return;
    p.settled = true;
    clearTimeout(p.timer);
    if (p.quietTimer) clearTimeout(p.quietTimer);
    p.timedOut = by === 'timeout';
    p.completedBy = by;
    p.reason = reason;
    p.resolve();
  }

  private failAll(reason: string): void {
    for (const reqId of this.pending.keys()) {
      this.finish(reqId, 'disconnect', reason);
    }
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function safeSessionTag(value: string | undefined): string {
  return (value ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
}

function auditLabel(label: string | undefined, sessionTag: string): string {
  const base = label ?? 'agent';
  return (sessionTag ? `[${sessionTag}] ${base}` : base).slice(0, 60);
}
