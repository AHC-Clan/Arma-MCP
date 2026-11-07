// wait.ts: arma-mcp wait. RPT 줄, 게임 연결, 게임 안 조건 중 하나를 기다린다.
//
// 기다리는 일은 데몬과 게임 안에서 한다. CLI 는 도구를 부르고 결과가 올 때까지 둔다.
// 시간 안에 오지 않으면 종료 코드 5 다. 셸에서 && 로 다음 단계를 이어 쓰기 위한 명령이다.

import { randomBytes } from 'node:crypto';
import {
  DEADLINE_MARGIN_MS,
  deadlineOption,
  flagOption,
  msysDrivePath,
  parseCommandArgs,
  parseDuration,
  stringOption,
  type OptionValues,
} from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { EXIT, usageError, type ExitCode } from '../errors.js';
import {
  formatDuration,
  isRecord,
  jsonLine,
  num,
  readToolResult,
  renderStatus,
  str,
  toolExitCode,
  type ToolPayload,
} from '../render.js';
import type { CliSession } from '../session.js';

/** 대기 한도의 기본값. 싱글 부팅과 준비 마커가 대개 이 안에 들어온다. */
export const WAIT_DEFAULT_MS = 100_000;
/** arma_rpt_wait 와 arma_status 가 받는 최대 대기. */
const TOOL_WAIT_MAX_MS = 600_000;
/** wait sqf 는 arma_watch 를 이어 부르므로 도구 한 번의 상한보다 길게 받는다. */
const SQF_WAIT_MAX_MS = 3_600_000;
/** arma_watch 한 번이 받는 최대 대기. 이보다 길면 조각으로 나눠 부른다. */
export const WATCH_SLICE_MAX_MS = 300_000;
/** arma_watch 한 번이 받는 최소 대기. 남은 시간이 이보다 짧으면 더 부르지 않는다. */
const WATCH_SLICE_MIN_MS = 1000;
const INTERVAL_MIN_MS = 50;
const INTERVAL_MAX_MS = 5000;
/** 중단된 뒤 게임 안의 워치를 멈추는 호출의 상한. main 의 강제 종료 3초 안에 끝나야 한다. */
const WATCH_STOP_TIMEOUT_MS = 1500;
/** 감사 로그에서 CLI 가 건 워치를 가린다. */
const WATCH_LABEL = 'cli-wait';

const KINDS = ['rpt', 'game', 'dedicated', 'sqf'] as const;
type WaitKind = (typeof KINDS)[number];

/** 종류마다 받는 옵션. 공통 옵션은 모두 받는다. */
const KIND_OPTIONS: Record<WaitKind, readonly string[]> = {
  rpt: ['source', 'file', 'since'],
  game: [],
  dedicated: [],
  sqf: ['sample', 'interval'],
};

const USAGE = `arma-mcp wait rpt PATTERN [--source client|server] [--file NAME] [--since FILE:OFFSET]
arma-mcp wait game|dedicated
arma-mcp wait sqf COND [--sample EXPR] [--interval 250]
공통 옵션: [--timeout 100s] [--deadline DURATION] [--json]

RPT 줄, 게임 연결, 게임 안 조건 중 하나를 기다린다. 시간 안에 오지 않으면 종료 코드 5 다.

  rpt PATTERN            RPT 에 정규식이 나올 때까지 기다린다. 대소문자는 가리지 않는다
    --source S           client 나 server. 기본은 라이브 데디 세션이면 server, 아니면 client
    --file NAME          RPT 파일 이름이나 절대 경로. 기본은 가장 최근 파일이다
    --since FILE:OFFSET  그 위치 뒤에서 찾는다. exec --rpt 가 찍는 값을 그대로 넘긴다
                         주지 않으면 파일 끝 64KB 에 이미 있는 줄도 찾는다
  game                   DLL 이 붙을 때까지 기다린다
  dedicated              데디 미션 브리지가 설 때까지 기다린다
  sqf COND               게임 안에서 COND 가 참이 될 때까지 기다린다
    --sample EXPR        매 틱 함께 기록할 식. 앞쪽 값 몇 개를 찍는다
    --interval 250       평가 간격(기본 250ms, 50ms 에서 5s 사이)

  --timeout 100s         대기 한도(기본 100s). rpt, game, dedicated 는 최대 10m, sqf 는 최대 60m
  --deadline D           명령이 이 시간 안에 끝나야 한다. 대기 한도에 여유 5초를 더해 넘으면
                         기다리지 않고 종료 코드 2 로 끝낸다
  --json                 도구 JSON 을 한 줄로 찍는다

종료 코드는 기다리던 것이 오면 0, 시간 초과는 5, 도구나 조건식 실패는 1 이다.`;

export interface WaitRequest {
  kind: WaitKind;
  timeoutMs: number;
  json: boolean;
  /** rpt 는 PATTERN, sqf 는 COND. */
  target?: string;
  values: OptionValues;
}

/** --since FILE:OFFSET. 파일 이름에 드라이브 콜론이 있으므로 마지막 콜론에서 자른다. */
export function parseSince(text: string): { file: string; offset: number } {
  const at = text.lastIndexOf(':');
  const file = at > 0 ? text.slice(0, at) : '';
  const offset = at > 0 ? text.slice(at + 1) : '';
  if (!file || !/^\d+$/.test(offset)) {
    throw usageError(`--since 는 FILE:OFFSET 이다: ${text}. exec --rpt 가 찍는 값을 넘긴다.`);
  }
  return { file, offset: Number(offset) };
}

/** --deadline 안에 대기 한도와 여유가 들어가는지 본다. 넘으면 기다리지 않는다. */
export function checkWaitDeadline(timeoutMs: number, deadlineMs: number | undefined): void {
  if (deadlineMs === undefined || timeoutMs + DEADLINE_MARGIN_MS <= deadlineMs) return;
  const fit = deadlineMs - DEADLINE_MARGIN_MS;
  const hint =
    fit > 0
      ? `--timeout 을 ${formatDuration(fit)} 이하로 준다.`
      : '--deadline 을 여유 5초보다 길게 준다.';
  throw usageError(
    `대기 한도(${formatDuration(timeoutMs)})에 여유 5초를 더하면 ` +
      `--deadline(${formatDuration(deadlineMs)})보다 길다. ${hint}`,
  );
}

export function parseWaitArgs(argv: string[]): WaitRequest | null {
  const { values, positionals } = parseCommandArgs('wait', argv, {
    source: { type: 'string' },
    file: { type: 'string' },
    since: { type: 'string' },
    sample: { type: 'string' },
    interval: { type: 'string' },
    timeout: { type: 'string' },
    deadline: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (flagOption(values, 'help')) return null;

  const [kindText, ...rest] = positionals;
  if (kindText === undefined) {
    throw usageError('무엇을 기다릴지 없다. rpt, game, dedicated, sqf 중 하나를 준다.');
  }
  if (!(KINDS as readonly string[]).includes(kindText)) {
    throw usageError(`기다릴 수 없는 종류다: ${kindText}. rpt, game, dedicated, sqf 중 하나다.`);
  }
  const kind = kindText as WaitKind;
  for (const name of ['source', 'file', 'since', 'sample', 'interval']) {
    if (values[name] !== undefined && !KIND_OPTIONS[kind].includes(name)) {
      throw usageError(`--${name} 옵션은 wait ${kind} 에 쓰지 않는다. arma-mcp help wait 로 옵션을 본다.`);
    }
  }

  let target: string | undefined;
  if (kind === 'rpt' || kind === 'sqf') {
    const what = kind === 'rpt' ? 'PATTERN' : 'COND';
    if (rest.length === 0) throw usageError(`wait ${kind} 에는 ${what} 인자가 필요하다.`);
    if (rest.length > 1) throw usageError(`${what} 인자는 하나로 준다. 공백이 있으면 따옴표로 감싼다.`);
    target = rest[0]!;
    if (target.trim() === '') throw usageError(`${what} 인자가 비어 있다.`);
  } else if (rest.length > 0) {
    throw usageError(`wait ${kind} 뒤에는 인자를 더 주지 않는다: ${rest.join(' ')}`);
  }

  const timeoutText = stringOption(values, 'timeout');
  const timeoutMs =
    timeoutText === undefined ? WAIT_DEFAULT_MS : parseDuration(timeoutText, '--timeout');
  if (kind === 'sqf') {
    if (timeoutMs < WATCH_SLICE_MIN_MS || timeoutMs > SQF_WAIT_MAX_MS) {
      throw usageError('wait sqf 의 --timeout 은 1s 에서 60m 사이다.');
    }
  } else if (timeoutMs > TOOL_WAIT_MAX_MS) {
    throw usageError(`wait ${kind} 의 --timeout 은 10m 을 넘을 수 없다.`);
  }
  checkWaitDeadline(timeoutMs, deadlineOption(values));

  return { kind, timeoutMs, json: flagOption(values, 'json'), target, values };
}

/** wait rpt 가 보낼 arma_rpt_wait 인자. */
export function rptWaitArgs(request: WaitRequest): Record<string, unknown> {
  const pattern = request.target!;
  try {
    new RegExp(pattern, 'i');
  } catch (error) {
    throw usageError(`PATTERN 정규식이 잘못됐다: ${(error as Error).message}`);
  }
  const args: Record<string, unknown> = { pattern, timeoutMs: request.timeoutMs };
  const source = stringOption(request.values, 'source');
  if (source !== undefined) {
    if (source !== 'client' && source !== 'server') {
      throw usageError(`--source 는 client 나 server 다: ${source}`);
    }
    args.source = source;
  }
  // --file 과 --since 의 파일은 게임 기계의 RPT 이름이나 절대 경로다. 셸 기준으로 풀지 않고 그대로 보낸다.
  // 데몬은 이름만 준 값을 rptDir 아래에서 찾는다. Git Bash 의 /x/... 만 드라이브 경로로 바꾼다.
  const gameFile = (value: string): string => msysDrivePath(value) ?? value;
  const file = stringOption(request.values, 'file');
  const since = stringOption(request.values, 'since');
  if (since !== undefined) {
    if (file !== undefined) throw usageError('--since 에 파일이 들어 있어 --file 과 함께 쓰지 않는다.');
    const cursor = parseSince(since);
    args.file = gameFile(cursor.file);
    args.fromOffset = cursor.offset;
  } else if (file !== undefined) {
    args.file = gameFile(file);
  }
  return args;
}

/** wait sqf 가 보낼 arma_watch 인자. timeoutMs 는 조각마다 채운다. */
export function watchArgs(request: WaitRequest, watchId: string): Record<string, unknown> {
  const args: Record<string, unknown> = {
    condition: request.target!,
    watchId,
    label: WATCH_LABEL,
  };
  const sample = stringOption(request.values, 'sample');
  if (sample !== undefined) args.sample = sample;
  const intervalText = stringOption(request.values, 'interval');
  if (intervalText !== undefined) {
    const intervalMs = parseDuration(intervalText, '--interval');
    if (intervalMs < INTERVAL_MIN_MS || intervalMs > INTERVAL_MAX_MS) {
      throw usageError('--interval 은 50ms 에서 5s 사이다.');
    }
    args.intervalMs = intervalMs;
  }
  return args;
}

function failTool(ctx: CliContext, tool: string, payload: ToolPayload): number {
  ctx.err(`${tool} 실패: ${payload.text}`);
  return EXIT.failure;
}

async function waitRpt(ctx: CliContext, session: CliSession, request: WaitRequest): Promise<number> {
  const args = rptWaitArgs(request);
  const payload = readToolResult(await session.call('arma_rpt_wait', args));
  if (payload.isError || !isRecord(payload.json)) return failTool(ctx, 'arma_rpt_wait', payload);
  const res = payload.json;
  const pattern = request.target!;
  if (request.json) ctx.out(jsonLine(payload));

  if (res.found === true) {
    if (!request.json) {
      // lineNumber 는 대기를 시작한 위치부터 센 값이라 파일의 줄 번호가 아니다. 찍지 않는다.
      ctx.out(`rpt "${pattern}" ${formatDuration(num(res.elapsedMs))}, ${str(res.file)}`);
      if (str(res.line)) ctx.out(str(res.line).trim());
    }
    if (res.preExisting === true) {
      ctx.err('대기 전에 이미 기록돼 있던 줄이다. 새 줄만 기다리려면 --since 를 준다.');
    }
    return EXIT.ok;
  }
  if (str(res.error)) {
    ctx.err(`wait rpt 실패: ${str(res.error)}`);
    return EXIT.failure;
  }
  if (res.aborted === true) {
    ctx.err('wait rpt 가 데몬에서 중단됐다.');
    return EXIT.failure;
  }
  // 파일을 정하지 못하면 기다리지 않고 바로 돌아온다. next 는 새 파일을 기다리다 시간이 다 된 것이다.
  if (str(res.file) === '' && args.file !== 'next') {
    const source = str(res.resolvedSource);
    ctx.err(`기다릴 RPT 파일을 찾지 못했다${source ? `(source ${source})` : ''}.`);
    return EXIT.failure;
  }
  ctx.err(
    `${formatDuration(request.timeoutMs)} 기다렸지만 rpt 에 "${pattern}" 줄이 나오지 않았다.`,
  );
  return EXIT.timeout;
}

async function waitReady(ctx: CliContext, session: CliSession, request: WaitRequest): Promise<number> {
  const payload = readToolResult(
    await session.call('arma_status', { waitFor: request.kind, timeoutMs: request.timeoutMs }),
  );
  if (payload.isError || !isRecord(payload.json)) return failTool(ctx, 'arma_status', payload);
  if (request.json) ctx.out(jsonLine(payload));
  else ctx.out(renderStatus(payload.json)[1]!);
  const code = toolExitCode(payload);
  if (code === EXIT.timeout) {
    ctx.err(`${request.kind} 준비를 ${formatDuration(request.timeoutMs)} 기다렸지만 오지 않았다.`);
  }
  return code;
}

/** arma_watch 결과의 종료 코드. 참이 되면 0, 시간 초과는 5, 그 밖의 끝은 모두 실패다. */
export function watchExitCode(payload: ToolPayload): ExitCode {
  const json = payload.json;
  if (payload.isError || !isRecord(json) || json.ok === false) return EXIT.failure;
  if (json.met === true) return EXIT.ok;
  return json.reason === 'timeout' ? EXIT.timeout : EXIT.failure;
}

function sampleLine(res: Record<string, unknown>): string | null {
  const samples = Array.isArray(res.samples) ? res.samples.map(String) : [];
  if (samples.length === 0) return null;
  const dropped = num(res.samplesDropped);
  // 도구는 앞 샘플과 마지막 샘플을 남기고 그 사이를 버린다.
  const more = dropped > 0 ? ` (중간 ${dropped}개는 버렸다)` : '';
  return `samples ${samples.join(' ~ ')}${more}`;
}

async function waitSqf(ctx: CliContext, session: CliSession, request: WaitRequest): Promise<number> {
  // 키를 먼저 정해 두어야 응답을 받기 전에 중단돼도 게임 안의 루프를 멈출 수 있다.
  const watchId = `cli_${randomBytes(4).toString('hex')}`;
  const base = watchArgs(request, watchId);
  const startedAt = Date.now();
  // 남은 시간은 벽시계와 끝난 조각 한도의 합 중 큰 쪽으로 센다.
  // 조각이 한도보다 일찍 timeout 으로 돌아와도 같은 조건을 끝없이 다시 부르지 않는다.
  let spentMs = 0;
  const remainingMs = (): number =>
    request.timeoutMs - Math.max(Date.now() - startedAt, spentMs);
  let slices = 0;
  let iterations = 0;
  let payload: ToolPayload;

  for (;;) {
    const remaining = remainingMs();
    const sliceMs = Math.min(WATCH_SLICE_MAX_MS, Math.max(WATCH_SLICE_MIN_MS, remaining));
    try {
      payload = readToolResult(await session.call('arma_watch', { ...base, timeoutMs: sliceMs }));
    } catch (error) {
      if (ctx.io.interrupt?.aborted) {
        // 요청 취소는 데몬의 대기만 끊는다. 게임 안의 루프는 제 한도까지 돌므로 따로 멈춘다.
        await session
          .call('arma_watch', { stop: watchId }, {
            ignoreInterrupt: true,
            timeoutMs: WATCH_STOP_TIMEOUT_MS,
          })
          .catch(() => undefined);
      }
      throw error;
    }
    slices += 1;
    const res = isRecord(payload.json) ? payload.json : {};
    if (Number.isFinite(num(res.iterations))) iterations += num(res.iterations);
    const continues =
      !payload.isError && res.ok !== false && res.met === false && res.reason === 'timeout';
    spentMs += sliceMs;
    if (!continues || remainingMs() < WATCH_SLICE_MIN_MS) break;
  }

  const elapsedMs = Date.now() - startedAt;
  if (payload.isError || !isRecord(payload.json)) return failTool(ctx, 'arma_watch', payload);
  const res = payload.json;
  const code = watchExitCode(payload);

  if (request.json) {
    ctx.out(jsonLine(payload, { slices, totalElapsedMs: elapsedMs }));
  } else if (res.ok !== false) {
    const head = res.met === true ? 'met' : str(res.reason) || 'no-result';
    ctx.out(`${head} ${formatDuration(elapsedMs)}, ${iterations}회`);
    const samples = sampleLine(res);
    if (samples) ctx.out(samples);
  }

  if (code === EXIT.timeout) {
    ctx.err(`${formatDuration(request.timeoutMs)} 안에 조건이 참이 되지 않았다.`);
  } else if (code === EXIT.failure) {
    if (res.ok === false) {
      ctx.err(`wait sqf 실패: ${str(res.error) || str(res.reason) || '결과 없음'}`);
    } else if (res.reason === 'stopped') {
      ctx.err('다른 호출이 이 워치를 멈췄다.');
    } else {
      ctx.err(`조건식이 실패했다: ${str(res.reason)}`);
    }
    if (str(res.note)) ctx.err(str(res.note));
    const blocks = Array.isArray(res.rptErrors) ? res.rptErrors.filter(isRecord) : [];
    for (const block of blocks.slice(0, 1)) {
      const lines = Array.isArray(block.block) ? block.block.map(String) : [];
      for (const line of lines.slice(0, 6)) ctx.err(`  ${line.trim()}`);
    }
  }
  return code;
}

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const request = parseWaitArgs(argv);
  if (!request) {
    ctx.out(USAGE);
    return EXIT.ok;
  }
  // 인자 오류는 세션을 열기 전에 드러낸다.
  if (request.kind === 'rpt') rptWaitArgs(request);
  if (request.kind === 'sqf') watchArgs(request, 'check');

  return ctx.withSession(async (session) => {
    if (request.kind === 'rpt') return waitRpt(ctx, session, request);
    if (request.kind === 'sqf') return waitSqf(ctx, session, request);
    return waitReady(ctx, session, request);
  });
}

export const waitCommand: CliCommand = {
  name: 'wait',
  summary: 'RPT 줄, 게임 연결, 게임 안 조건을 기다린다',
  usage: USAGE,
  run,
};
