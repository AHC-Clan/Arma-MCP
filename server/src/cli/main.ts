// main.ts: arma-mcp CLI 진입점.
//
// 셸에서 여러 단계를 한 줄로 잇기 위한 얇은 클라이언트다. 명령마다 이미 떠 있는 데몬에
// cli 세션 하나를 열고, 도구를 부르고, 닫는다. 데몬을 띄우거나 재시작하거나 끄지 않는다.
//
// stdout 에는 명령 결과만 쓴다. 사람이 읽는 오류와 안내는 stderr 에 한 줄씩 쓴다.
// 진단 로그는 공유 logger 가 stderr 로 낸다. 종료 코드가 셸과의 계약이다(errors.ts).

import { runDoctor } from '../daemon/doctor.js';
import { describeError } from '../daemon/relayFetch.js';
import { log } from '../log.js';
import { ARMA_MCP_VERSION } from '../version.js';
import { flagOption, parseCommandArgs, rejectTokenFlag } from './args.js';
import { callCommand } from './commands/call.js';
import { execCommand } from './commands/exec.js';
import { helpText, overview } from './commands/help.js';
import { killCommand } from './commands/kill.js';
import { playCommand } from './commands/play.js';
import { statusCommand } from './commands/status.js';
import { waitCommand } from './commands/wait.js';
import { CliContext, type CliCommand, type CliIo } from './context.js';
import { CliError, EXIT, usageError } from './errors.js';

export type { CliIo } from './context.js';

const DOCTOR_USAGE = `arma-mcp doctor

게임 파이프, 데몬 포트, 토큰, 최근 daemon.log 와 relay.log 를 한 화면에 모아
연결이 안 되는 원인과 조치를 찍는다. 데몬에 세션을 열지 않는다.`;

const doctorCommand: CliCommand = {
  name: 'doctor',
  summary: '데몬 연결 문제를 진단한다',
  usage: DOCTOR_USAGE,
  async run(argv, ctx) {
    const { values, positionals } = parseCommandArgs('doctor', argv, {});
    if (flagOption(values, 'help')) {
      ctx.out(DOCTOR_USAGE);
      return EXIT.ok;
    }
    if (positionals.length > 0) throw usageError('doctor 는 인자를 받지 않는다.');
    await runDoctor(ctx.config());
    return EXIT.ok;
  },
};

export const COMMANDS: readonly CliCommand[] = [
  statusCommand,
  execCommand,
  waitCommand,
  killCommand,
  playCommand,
  callCommand,
  doctorCommand,
];

/**
 * 명령 뒤의 --stack 이름(또는 --stack=이름)을 떼어 ctx 에 둔다. -- 뒤는 보지 않는다.
 * 세션을 여는 모든 명령이 받으므로 명령마다 옵션을 늘리지 않고 여기서 한 번 처리한다.
 */
export function takeStackOption(argv: string[], ctx: CliContext): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (arg === '--stack') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw usageError('옵션 --stack 의 값이 없다. --stack b 처럼 스택 이름을 준다.');
      }
      ctx.stack = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--stack=')) {
      const value = arg.slice('--stack='.length);
      if (!value) throw usageError('옵션 --stack 의 값이 없다. --stack=b 처럼 스택 이름을 준다.');
      ctx.stack = value;
      continue;
    }
    out.push(arg);
  }
  return out;
}

async function dispatch(argv: string[], ctx: CliContext): Promise<number> {
  rejectTokenFlag(argv);
  const [first, ...rest] = argv;
  if (first === undefined) {
    ctx.err(overview(COMMANDS));
    return EXIT.usage;
  }
  if (first === '--version' || first === '-v' || first === 'version') {
    if (rest.length > 0) throw usageError(`${first} 는 인자를 받지 않는다.`);
    ctx.out(ARMA_MCP_VERSION);
    return EXIT.ok;
  }
  if (first === 'help' || first === '--help' || first === '-h') {
    if (rest.length > 1) throw usageError('help 는 명령 이름 하나만 받는다.');
    ctx.out(helpText(COMMANDS, rest[0]));
    return EXIT.ok;
  }
  const command = COMMANDS.find((candidate) => candidate.name === first);
  if (!command) {
    if (first.startsWith('-')) {
      throw usageError(`명령 앞에 옵션을 둘 수 없다: ${first}. arma-mcp help 로 명령을 본다.`);
    }
    throw usageError(`모르는 명령이다: ${first}. arma-mcp help 로 명령을 본다.`);
  }
  // doctor 는 데몬에 세션을 열지 않으므로 스택을 받지 않는다.
  const args = command.name === 'doctor' ? rest : takeStackOption(rest, ctx);
  return command.run(args, ctx);
}

/**
 * CLI 를 실행하고 종료 코드를 돌려준다. process.exit 는 부르지 않는다.
 * io 를 비우면 process 의 입출력과 환경을 쓴다.
 */
export async function runCli(argv: string[], partial: Partial<CliIo> = {}): Promise<number> {
  const io: CliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    ...partial,
  };
  const ctx = new CliContext(io);
  try {
    return await dispatch(argv, ctx);
  } catch (error) {
    // 중단으로 끊긴 호출은 어떤 오류로 돌아오든 중단이다.
    if (io.interrupt?.aborted) {
      ctx.err('중단했다.');
      return EXIT.interrupted;
    }
    if (error instanceof CliError) {
      ctx.err(error.message);
      return error.exitCode;
    }
    log.debug('[cli] internal error', error instanceof Error ? (error.stack ?? '') : String(error));
    ctx.err(`arma-mcp 내부 오류: ${describeError(error)}`);
    return EXIT.internal;
  }
}

/** 정리가 멈춰도 이 시간 뒤에는 끝낸다. 세션 DELETE 상한 1초보다 넉넉하다. */
const FORCE_EXIT_MS = 3000;

/**
 * SIGINT 와 SIGTERM 을 중단 신호로 바꾼다. 첫 신호는 진행 중인 요청을 끊고 세션을 닫게 한다.
 * 두 번째 신호나 정리 시간 초과는 곧바로 130 으로 끝낸다.
 */
export function watchProcessSignals(): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const onSignal = (): void => {
    if (controller.signal.aborted) process.exit(EXIT.interrupted);
    controller.abort(new Error('interrupted'));
    setTimeout(() => process.exit(EXIT.interrupted), FORCE_EXIT_MS).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}
