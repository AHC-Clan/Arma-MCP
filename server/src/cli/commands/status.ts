// status.ts: arma-mcp status. arma_status 한 번을 4줄이나 5줄로 요약한다.

import { flagOption, parseCommandArgs, parseDuration, stringOption } from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import {
  formatDuration,
  isRecord,
  jsonLine,
  readToolResult,
  renderStatus,
  toolExitCode,
} from '../render.js';

/** --wait 의 기본 대기. 싱글 부팅은 40초 안쪽, 데디 미션은 90초 안팎이 걸린다. */
export const STATUS_WAIT_DEFAULT_MS = 90_000;
/** arma_status 가 받는 최대 대기. */
const STATUS_WAIT_MAX_MS = 600_000;

const USAGE = `arma-mcp status [--wait game|dedicated] [--timeout 90s] [--json]

데몬, 게임 연결, 프로세스, 실행 lease, 저장된 프로필을 몇 줄로 보여준다.

  --wait game        DLL 이 붙을 때까지 기다린다
  --wait dedicated   데디 미션 브리지가 설 때까지 기다린다
  --timeout 90s      대기 한도(기본 90s, 최대 10m). 넘기면 종료 코드 5
  --json             도구 JSON 을 한 줄로 찍는다`;

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseCommandArgs('status', argv, {
    wait: { type: 'string' },
    timeout: { type: 'string' },
    json: { type: 'boolean' },
  });
  if (flagOption(values, 'help')) {
    ctx.out(USAGE);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw usageError(`status 는 인자를 받지 않는다: ${positionals.join(' ')}`);
  }
  const wait = stringOption(values, 'wait');
  if (wait !== undefined && wait !== 'game' && wait !== 'dedicated') {
    throw usageError(`--wait 는 game 이나 dedicated 다: ${wait}`);
  }
  const timeoutText = stringOption(values, 'timeout');
  if (timeoutText !== undefined && wait === undefined) {
    throw usageError('--timeout 은 --wait 와 함께 쓴다.');
  }
  const timeoutMs = timeoutText === undefined ? STATUS_WAIT_DEFAULT_MS : parseDuration(timeoutText, '--timeout');
  if (timeoutMs > STATUS_WAIT_MAX_MS) {
    throw usageError('--timeout 은 10m 을 넘을 수 없다.');
  }
  const args = wait ? { waitFor: wait, timeoutMs } : {};

  return ctx.withSession(async (session) => {
    const payload = readToolResult(await session.call('arma_status', args));
    if (payload.isError || !isRecord(payload.json)) {
      ctx.err(`arma_status 실패: ${payload.text}`);
      return EXIT.failure;
    }
    const status = payload.json;
    if (flagOption(values, 'json')) ctx.out(jsonLine(payload));
    else for (const line of renderStatus(status)) ctx.out(line);

    const code = toolExitCode(payload);
    if (code === EXIT.timeout) {
      ctx.err(`${wait} 준비를 ${formatDuration(timeoutMs)} 기다렸지만 오지 않았다.`);
    }
    return code;
  });
}

export const statusCommand: CliCommand = {
  name: 'status',
  summary: '데몬, 게임 연결, 프로세스, lease 를 몇 줄로 본다',
  usage: USAGE,
  run,
};
