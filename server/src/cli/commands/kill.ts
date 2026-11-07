// kill.ts: arma-mcp kill. arma_kill 한 번으로 Arma 를 끝내고 잠금 해제까지 기다린다.
//
// MCP 도구의 기본은 실행 중인 다른 세션의 launch, play 를 끊는 것이다. CLI 는 --preempt 없이는
// 끊지 않고 lease 주인을 알린다(종료 코드 4). 재빌드 스크립트가 남의 실행을 모르고 죽이지 않게 하려는 것이다.

import {
  flagOption,
  normalizeGamePath,
  parseCommandArgs,
  parseDuration,
  stringListOption,
  stringOption,
} from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import {
  busyMessage,
  formatDuration,
  isRecord,
  jsonLine,
  num,
  operationText,
  readToolResult,
  str,
  toolExitCode,
  type Rendered,
} from '../render.js';

const TARGETS = ['all', 'client', 'server'] as const;
/** arma_kill 이 받는 최대 대기와 잠금 경로 수. */
const KILL_WAIT_MAX_MS = 60_000;
const UNLOCK_MAX = 32;

const USAGE = `arma-mcp kill [all|client|server] [--unlock PATH]... [--wait 15s] [--preempt] [--json]

Arma 프로세스를 끝내고 사라질 때까지 기다린다. 기본 대상은 all 이다(클라이언트와 데디 서버).

  --unlock PATH   끝낸 뒤 이 파일이나 모드 폴더의 PBO, DLL 이 쓰기 가능해질 때까지 기다린다
                  여러 번 줄 수 있다. 게임 기계의 경로다. 터널 연결에서는 절대 경로로 준다
  --wait 15s      프로세스 종료와 잠금 해제를 기다리는 한도(기본 15s, 최대 60s). 0 이면 기다리지 않는다
  --preempt       다른 세션의 launch 나 play 가 돌고 있어도 끊고 끝낸다
  --json          도구 JSON 을 한 줄로 찍는다

--preempt 가 없으면 다른 세션의 작업이 돌 때 끝내지 않고 lease 주인을 알린다(종료 코드 4).
종료 코드는 성공이면 0, 남은 프로세스나 풀리지 않은 잠금이 있으면 1 이다.`;

export interface KillRequest {
  args: Record<string, unknown>;
  json: boolean;
}

export function parseKillArgs(argv: string[], ctx: CliContext): KillRequest | null {
  const { values, positionals } = parseCommandArgs('kill', argv, {
    unlock: { type: 'string', multiple: true },
    wait: { type: 'string' },
    preempt: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (flagOption(values, 'help')) return null;
  if (positionals.length > 1) {
    throw usageError(`kill 대상은 하나만 준다: ${positionals.join(' ')}`);
  }
  const target = positionals[0];
  if (target !== undefined && !(TARGETS as readonly string[]).includes(target)) {
    throw usageError(`kill 대상은 all, client, server 중 하나다: ${target}`);
  }

  // 다른 세션의 실행은 명시했을 때만 끊는다. 도구 기본값(true)에 기대지 않고 늘 보낸다.
  const args: Record<string, unknown> = { preempt: flagOption(values, 'preempt') };
  if (target !== undefined) args.target = target;
  const waitText = stringOption(values, 'wait');
  if (waitText !== undefined) {
    const waitMs = parseDuration(waitText, '--wait');
    if (waitMs > KILL_WAIT_MAX_MS) throw usageError('--wait 는 60s 를 넘을 수 없다.');
    args.waitMs = waitMs;
  }
  const unlock = stringListOption(values, 'unlock');
  if (unlock.length > UNLOCK_MAX) throw usageError(`--unlock 은 ${UNLOCK_MAX}개까지 준다.`);
  if (unlock.length > 0) {
    args.unlockPaths = unlock.map((value) => normalizeGamePath(value, '--unlock', ctx.gamePaths));
  }
  return { args, json: flagOption(values, 'json') };
}

function entryLine(name: string, entry: Record<string, unknown>): { line: string; failed: boolean } {
  const label = name.padEnd(8);
  const detail = str(entry.detail);
  if (entry.gone === false) {
    return { line: `${label} 남아 있다${detail ? `: ${detail}` : ''}`, failed: true };
  }
  if (entry.killed === true) {
    if (entry.gone === true) {
      return { line: `${label} 끝냈다, ${formatDuration(num(entry.waitedMs))}`, failed: false };
    }
    return { line: `${label} 종료 신호를 보냈다. 사라졌는지는 보지 않았다`, failed: false };
  }
  return { line: `${label} 실행 중이 아니었다`, failed: false };
}

/** arma_kill 결과를 줄로. 남은 프로세스와 잠긴 경로는 stderr 에 하나씩 적는다. */
export function renderKill(result: Record<string, unknown>): Rendered {
  const out: Rendered = { stdout: [], stderr: [] };
  for (const name of ['client', 'server']) {
    const entry = result[name];
    if (!isRecord(entry)) continue;
    const { line, failed } = entryLine(name, entry);
    out.stdout.push(line);
    if (failed) out.stderr.push(`${name} 프로세스가 아직 남아 있다${str(entry.detail) ? `: ${str(entry.detail)}` : ''}`);
  }
  const unlock = Array.isArray(result.unlock) ? result.unlock.filter(isRecord) : [];
  for (const item of unlock) {
    const file = str(item.path);
    if (item.ok === true) {
      out.stdout.push(`unlock   ${file} 풀림, ${formatDuration(num(item.waitedMs))}`);
      continue;
    }
    const why = [str(item.reason), str(item.code)].filter(Boolean).join(', ');
    out.stdout.push(`unlock   ${file} 잠김${why ? `(${why})` : ''}`);
    out.stderr.push(`잠금이 풀리지 않았다: ${file}${why ? ` (${why})` : ''}`);
  }
  if (isRecord(result.interruptedOperation)) {
    out.stdout.push(`끊은 작업 ${operationText(result.interruptedOperation)}`);
  }
  return out;
}

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const request = parseKillArgs(argv, ctx);
  if (!request) {
    ctx.out(USAGE);
    return EXIT.ok;
  }

  return ctx.withSession(async (session) => {
    const payload = readToolResult(await session.call('arma_kill', request.args));
    if (payload.isError || !isRecord(payload.json)) {
      ctx.err(`arma_kill 실패: ${payload.text}`);
      return EXIT.failure;
    }
    const result = payload.json;
    const code = toolExitCode(payload);
    if (code === EXIT.busy) {
      if (request.json) ctx.out(jsonLine(payload));
      ctx.err(busyMessage(result, '끝내지 않았다')!);
      ctx.err('그 작업이 끝난 뒤 다시 하거나 --preempt 로 끊는다.');
      return code;
    }
    const rendered = renderKill(result);
    if (request.json) ctx.out(jsonLine(payload));
    else for (const line of rendered.stdout) ctx.out(line);
    for (const line of rendered.stderr) ctx.err(line);
    if (code === EXIT.failure && rendered.stderr.length === 0) {
      ctx.err(`kill 실패: ${str(result.error) || '남은 프로세스나 잠긴 경로가 있다'}`);
    }
    return code;
  });
}

export const killCommand: CliCommand = {
  name: 'kill',
  summary: 'Arma 를 끝내고 모드 폴더 잠금이 풀릴 때까지 기다린다',
  usage: USAGE,
  run,
};
