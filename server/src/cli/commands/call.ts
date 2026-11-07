// call.ts: arma-mcp call. 읽기와 SQF 계열 MCP 도구 하나를 JSON 인자로 부른다.
//
// 프로세스를 띄우거나 죽이는 도구와 플레이어에게 보이는 방송 도구는 부르지 않는다.
// 앞의 것은 눈에 보이는 kill 과 play 명령으로만, 뒤의 것은 에이전트 세션의 MCP 도구로만 부른다.

import { flagOption, parseCommandArgs, readStdin } from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import { isRecord, jsonLine, readToolResult, toolExitCode } from '../render.js';

const PROCESS_REASON = '프로세스를 바꾸는 도구는 kill 과 play 명령으로만 부른다.';
const MISSION_REASON = '미션 파일을 만드는 도구는 play 명령으로만 부른다.';
const BROADCAST_REASON = '플레이어나 LAN 에 보이는 도구는 에이전트 세션의 MCP 도구로 부른다.';

/** 이름마다 한국어 조사를 맞춘다. 목록에 없는 이름은 "도구는" 으로 쓴다. */
const REFUSED: Record<string, { particle: '은' | '는'; reason: string }> = {
  arma_kill: { particle: '은', reason: PROCESS_REASON },
  arma_launch: { particle: '는', reason: PROCESS_REASON },
  arma_launch_mp: { particle: '는', reason: PROCESS_REASON },
  arma_launch_server: { particle: '는', reason: PROCESS_REASON },
  arma_play: { particle: '는', reason: PROCESS_REASON },
  arma_scaffold_mission: { particle: '은', reason: MISSION_REASON },
  arma_web_open: { particle: '은', reason: BROADCAST_REASON },
  arma_web_publish: { particle: '는', reason: BROADCAST_REASON },
  arma_tacmap_subtitle: { particle: '은', reason: BROADCAST_REASON },
  arma_tacmap_mark: { particle: '는', reason: BROADCAST_REASON },
  arma_tacmap_open: { particle: '은', reason: BROADCAST_REASON },
};

/** call 이 거부하는 도구면 그 안내를, 아니면 null 을 돌려준다. */
export function refusalFor(tool: string): string | null {
  const known = REFUSED[tool];
  if (known) return `${tool} ${known.particle} call 로 부를 수 없다. ${known.reason}`;
  if (tool.startsWith('arma_launch')) return `${tool} 도구는 call 로 부를 수 없다. ${PROCESS_REASON}`;
  if (tool.startsWith('arma_web_') || tool.startsWith('arma_tacmap_')) {
    return `${tool} 도구는 call 로 부를 수 없다. ${BROADCAST_REASON}`;
  }
  return null;
}

const USAGE = `arma-mcp call TOOL [JSON | - | key=value...] [--json]

MCP 도구 하나를 부르고 결과 JSON 을 찍는다.
인자는 JSON 객체 하나, 표준 입력(-), key=value 목록 중 하나로 준다.
key=value 의 값은 JSON 으로 읽히면 JSON 이고, 아니면 문자열이다.

프로세스를 바꾸는 도구(arma_kill, arma_launch, arma_launch_mp, arma_launch_server, arma_play)와
arma_scaffold_mission 은 부르지 않는다. 방송 도구(arma_web_*, arma_tacmap_*)도 부르지 않는다.

  --json   도구 JSON 을 한 줄로 찍는다. 기본은 들여쓴 JSON 이다

종료 코드는 성공이면 0 이다. 도구 실패는 1, lease 사용 중은 4, 대기 시간 초과는 5 다.`;

function parseJsonObject(text: string, source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw usageError(`${source} JSON 을 읽지 못했다: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw usageError(`${source} 는 JSON 객체여야 한다.`);
  return parsed;
}

/** key=value 의 값. JSON 으로 읽히면 그 값, 아니면 문자열이다. */
export function parseKeyValueValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function parseCallArgs(
  positionals: string[],
  ctx: CliContext,
): Promise<Record<string, unknown>> {
  if (positionals.length === 0) return {};
  const first = positionals[0]!;
  if (positionals.length === 1 && first === '-') {
    return parseJsonObject(await readStdin(ctx.io.stdin, 'JSON 인자를'), '표준 입력의');
  }
  if (positionals.length === 1 && first.trimStart().startsWith('{')) {
    return parseJsonObject(first, '인자');
  }
  const args: Record<string, unknown> = {};
  for (const pair of positionals) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(pair);
    if (!match) {
      throw usageError(
        `인자를 읽지 못했다: ${pair}. JSON 객체 하나, -, key=value 목록 중 하나로 준다.`,
      );
    }
    args[match[1]!] = parseKeyValueValue(match[2]!);
  }
  return args;
}

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommandArgs('call', argv, {
    json: { type: 'boolean' },
  });
  if (flagOption(values, 'help')) {
    ctx.out(USAGE);
    return EXIT.ok;
  }
  const [tool, ...rest] = positionals;
  if (!tool) throw usageError('부를 도구 이름이 없다. arma-mcp call TOOL 로 준다.');
  const refusal = refusalFor(tool);
  if (refusal) throw usageError(refusal);
  const args = await parseCallArgs(rest, ctx);

  // 세션마다 새로 열리므로 이 호출에는 앞선 exec 의 커서가 없다.
  if (
    tool === 'arma_rpt_errors' &&
    args.fromOffset === undefined &&
    (args.since === undefined || args.since === 'lastExec')
  ) {
    ctx.err(
      "since:'lastExec' 는 CLI 호출 사이에 이어지지 않는다. 이 호출은 파일 처음부터 훑는다. " +
        'exec 결과의 rptCursor 를 file 과 fromOffset 으로 넘긴다.',
    );
  }

  return ctx.withSession(async (session) => {
    const payload = readToolResult(await session.call(tool, args));
    if (payload.isError) {
      ctx.err(`${tool} 실패: ${payload.text}`);
      return EXIT.failure;
    }
    if (flagOption(values, 'json') || payload.json === undefined) ctx.out(jsonLine(payload));
    else ctx.out(JSON.stringify(payload.json, null, 2));
    if (payload.images.length > 0) {
      ctx.err(`이미지 ${payload.images.length}개는 찍지 않았다. 화면은 exec --capture 로 파일에 받는다.`);
    }
    return toolExitCode(payload);
  });
}

export const callCommand: CliCommand = {
  name: 'call',
  summary: 'MCP 도구 하나를 JSON 인자로 부른다',
  usage: USAGE,
  run,
};
