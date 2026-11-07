// help.ts: arma-mcp help [COMMAND].

import type { CliCommand } from '../context.js';
import { usageError } from '../errors.js';

const EXIT_CODES =
  '종료 코드: 0 성공, 1 도구나 게임 실패, 2 사용법 오류, 3 데몬 연결 문제, ' +
  '4 lease 사용 중, 5 대기 시간 초과, 70 내부 오류, 130 중단';

/** 명령 목록. 명령이 없거나 모르는 명령일 때도 이 글을 stderr 에 쓴다. */
export function overview(commands: readonly CliCommand[]): string {
  const width = Math.max(...commands.map((command) => command.name.length), 'help'.length) + 2;
  const rows = commands.map((command) => `  ${command.name.padEnd(width)}${command.summary}`);
  return [
    'arma-mcp <명령> [옵션]',
    '',
    '실행 중인 Arma-MCP 데몬에 붙어 도구를 부른다. 데몬을 띄우거나 끄지 않는다.',
    '',
    '명령:',
    ...rows,
    `  ${'help'.padEnd(width)}도움말을 본다. arma-mcp help exec 처럼 명령을 붙인다`,
    '',
    '  --version  버전을 찍는다',
    '',
    'doctor 를 뺀 모든 명령은 --stack 이름 을 받는다. 그 테스트 스택의 게임에 도구를 부른다.',
    '없으면 ARMA_MCP_STACK 환경 변수를 쓰고, 그것도 없으면 default 스택이다.',
    '',
    EXIT_CODES,
  ].join('\n');
}

export function helpText(commands: readonly CliCommand[], name: string | undefined): string {
  if (name === undefined || name === 'help') return overview(commands);
  const command = commands.find((candidate) => candidate.name === name);
  if (!command) throw usageError(`모르는 명령이다: ${name}. arma-mcp help 로 명령을 본다.`);
  return command.usage;
}
