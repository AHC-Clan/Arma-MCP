// watch.ts — arma_watch 툴 등록.
//
// 폴링 루프를 게임 안에서 돌려 왕복을 1회로 줄인다. 지금까지는 헬기 착륙·유닛 전멸 같은
// "될 때까지 기다리기"를 arma_exec 반복 호출로 처리했고(실측 4분에 13콜, 다른 세션 10콜),
// 대기 프리미티브가 없어 셸 sleep 을 쓰기도 했다.

import { z } from 'zod';
import { type Deps, type ToolHost, jsonContent } from '../deps.js';
import { STACK_INPUT, onStack } from '../stackDeps.js';
import { makeSessionExecContext } from '../execContext.js';
import { withAbortSignals } from '../abort.js';
import { ackOf } from '../sqfLiteral.js';
import { sanitizeSqf, CommentRejectedError } from '../../exec/sanitize.js';
import { buildWatchSqf, buildWatchStopSqf, parseWatchAck } from '../../exec/sqfWrap.js';

const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
// v1 상한 8: 인게임 결과는 fn_execRun 의 500자 캡에 걸린다(애드온을 재빌드하지 않는다).
// 최악 8×43 + 마지막 샘플 60 + 헤더 ≈ 444자.
const MAX_SAMPLES_CAP = 8;
/** 인게임 루프가 스스로 끝날 여유. 서버 대기는 항상 이만큼 더 길다. */
const SERVER_GRACE_MS = 3000;
/** 호출자가 정하는 워치 키. SQF 문자열 리터럴로 심기므로 안전한 문자만 받는다. */
export const WATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function registerWatchTool(server: ToolHost, shared: Deps): void {
  server.registerTool(
    'arma_watch',
    {
      title: 'Arma 인게임 조건 대기',
      description:
        '게임 안에서 조건이 참이 될 때까지 폴링하고, 충족 즉시 또는 타임아웃에 한 번만 반환한다. ' +
        '폴링 루프가 게임 안에서 돌기 때문에 arma_exec 를 반복 호출하거나 셸 sleep 으로 기다릴 필요가 없다 — ' +
        '헬기 착륙·유닛 전멸·태스크 완료 같은 "될 때까지 기다리기"는 전부 이 툴을 쓴다. ' +
        'condition 은 매 틱 평가되는 SQF 불리언 식이고, sample 을 주면 매 틱 값을 함께 기록해 ' +
        '조건이 왜 충족되지 않았는지 추적할 수 있다. 두 식은 격리 실행되므로 타입 오류로 죽어도 ' +
        '전체 타임아웃을 태우지 않고 threw 로 즉시 돌아온다. ' +
        'stop 에 reqId 를 주면(또는 stopAll) 진행 중인 워치에 정지 신호를 보낸다. ' +
        'condition 은 매 틱 실행되므로 가볍게 유지한다.',
      inputSchema: {
        stack: STACK_INPUT,
        condition: z
          .string()
          .optional()
          .describe('참이 되면 대기를 끝낼 SQF 불리언 식. stop/stopAll 이 아니면 필수.'),
        sample: z
          .string()
          .optional()
          .describe('매 틱 함께 기록할 SQF 식(str 로 직렬화). 조건 미충족 원인 추적용.'),
        intervalMs: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .optional()
          .describe('평가 간격(ms). 기본 250.'),
        timeoutMs: z
          .number()
          .int()
          .min(1000)
          .max(MAX_TIMEOUT_MS)
          .optional()
          .describe('최대 대기(ms). 기본 30000, 최대 300000. 조건이 참이 되면 즉시 반환한다.'),
        maxSamples: z
          .number()
          .int()
          .min(0)
          .max(MAX_SAMPLES_CAP)
          .optional()
          .describe(
            '반환할 샘플 최대 개수(기본 8, 상한 8). 넘치면 앞의 개수-1 개와 마지막 값을 돌려주고 ' +
              '그 사이는 개수만 센다. 충족 순간의 값이 마지막 샘플이다.',
          ),
        label: z.string().optional().describe('인게임 감사 로그 라벨(기본 watch).'),
        watchId: z
          .string()
          .regex(WATCH_ID_RE)
          .optional()
          .describe(
            '이 워치의 키. 호출자가 미리 정해 두면 응답을 받기 전에도 stop 으로 멈출 수 있다. ' +
              '영문, 숫자, _, - 로 1~64자. 기본은 세션 태그와 시각으로 만든다.',
          ),
        stop: z
          .string()
          .optional()
          .describe('이 reqId 의 워치에 정지 신호를 보낸다. condition 없이 단독 사용.'),
        stopAll: z
          .boolean()
          .optional()
          .describe('true 면 진행 중인 모든 워치를 정지시킨다.'),
      },
    },
    onStack(shared, {}, async (deps, args, extra) =>
      withAbortSignals([deps.session.abortController.signal, extra?.signal], (signal) =>
        runWatch(deps, args, signal),
      ),
    ),
  );
}

interface WatchArgs {
  condition?: string;
  sample?: string;
  intervalMs?: number;
  timeoutMs?: number;
  maxSamples?: number;
  label?: string;
  watchId?: string;
  stop?: string;
  stopAll?: boolean;
}

/** arma_watch 본문. signal 은 세션 신호와 요청 신호를 묶은 것이다. */
async function runWatch(
  deps: Deps,
  args: WatchArgs,
  signal: AbortSignal,
): Promise<ReturnType<typeof jsonContent>> {
  // 내부 호출과 마찬가지로 onRptCursor 는 넘기지 않는다 —
  // 사용자의 마지막 arma_exec 커서를 워치가 덮어쓰면 안 된다.
  const ctx = makeSessionExecContext(deps, undefined, signal);

  // ── 정지 경로: 조건 없이 신호만 보낸다.
  if (args.stopAll === true || (args.stop !== undefined && args.stop !== '')) {
    const target = args.stopAll === true ? null : (args.stop as string);
    const outcome = await deps.exec.run({
      code: buildWatchStopSqf(target),
      mode: 'server',
      timeoutMs: 5000,
      label: 'watch-stop',
      checkRpt: false,
      context: ctx,
    });
    const ack = ackOf(outcome.results[0]?.parsed?.value);
    return jsonContent({
      ok: outcome.ok && ack !== null,
      stopped: target ?? 'all',
      ack,
      error: outcome.error,
      durationMs: outcome.durationMs,
    });
  }

  if (!args.condition || args.condition.trim() === '') {
    return jsonContent({
      ok: false,
      error: 'condition 이 필요합니다 (정지에는 stop 또는 stopAll 을 쓰세요).',
    });
  }

  // 사용자 코드는 SQF 문자열 리터럴로 심는다 — 리터럴로 감싸기 전에 반드시 먼저
  // 주석을 제거해야 한다. 조립 후에 sanitize 하면 리터럴 내부를 건너뛰므로
  // 주석이 살아남아 인게임 compile 이 조용히 <nil> 로 파손된다.
  let condition: string;
  let sample: string;
  try {
    condition = sanitizeSqf(args.condition, 'strip').code;
    sample = args.sample ? sanitizeSqf(args.sample, 'strip').code : '';
  } catch (e) {
    if (e instanceof CommentRejectedError) {
      return jsonContent({ ok: false, error: e.message });
    }
    throw e;
  }

  const intervalMs = clamp(args.intervalMs ?? DEFAULT_INTERVAL_MS, 50, 5000);
  const timeoutMs = clamp(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
  const maxSamples = clamp(args.maxSamples ?? MAX_SAMPLES_CAP, 0, MAX_SAMPLES_CAP);

  // reqId 를 미리 알 수 없으므로 워치 키는 세션 태그 + 시각으로 만든다.
  // 반환값에 실어 주면 다른 세션이 stop 으로 조준할 수 있다.
  // 호출자가 키를 정해 오면 그 키를 쓴다. CLI 는 중단될 때 응답 없이도 이 키로 루프를 멈춘다.
  const watchId = args.watchId ?? `w_${ctx.sessionShortId ?? 'x'}_${Date.now().toString(36)}`;

  const outcome = await deps.exec.run({
    code: buildWatchSqf({ condition, sample, watchId, intervalMs, timeoutMs, maxSamples }),
    mode: 'server',
    // 인게임 루프가 항상 먼저 끝나도록 서버 대기를 더 길게 잡는다.
    timeoutMs: timeoutMs + SERVER_GRACE_MS,
    label: args.label ?? 'watch',
    // 조건식이 죽으면 인게임에서 threw 로 돌아온다 — 그때 RPT 블록이 원인을 말해준다.
    checkRpt: false,
    context: ctx,
  });

  const parsed = parseWatchAck(ackOf(outcome.results[0]?.parsed?.value));
  if (!parsed) {
    return jsonContent({
      ok: false,
      met: false,
      reason: outcome.timedOut ? 'hung' : 'no-result',
      watchId,
      error: outcome.error ?? '워치 결과를 해석하지 못했습니다.',
      exec: {
        reqId: outcome.reqId,
        completedBy: outcome.completedBy,
        durationMs: outcome.durationMs,
        result: outcome.results[0]?.result,
      },
      rptErrors: outcome.rptErrors,
    });
  }

  const threw = parsed.reason.startsWith('threw:') || parsed.reason.startsWith('type:');
  return jsonContent({
    ok: outcome.ok,
    met: parsed.met,
    reason: parsed.reason,
    watchId,
    iterations: parsed.iterations,
    gameElapsedMs: parsed.gameElapsedMs,
    sampleCount: parsed.sampleCount,
    samplesDropped: parsed.samplesDropped,
    samples: parsed.samples,
    note: threw
      ? 'condition/sample 식이 예외로 종료됐습니다 — rptErrors 의 ' +
        "'Error in expression' 에서 원인을 확인하세요. `round <배열>` 같은 타입 오류가 가장 흔합니다."
      : undefined,
    stopHint: `arma_watch { stop: "${watchId}" }`,
    exec: {
      reqId: outcome.reqId,
      completedBy: outcome.completedBy,
      durationMs: outcome.durationMs,
    },
    rptErrors: outcome.rptErrors,
  });
}
