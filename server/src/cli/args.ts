// args.ts: CLI 인자 해석.
//
// node:util parseArgs 를 strict 로 쓰고, 그 오류를 사용법 오류(종료 코드 2)와 한국어 안내로 바꾼다.
// 시간 값, 경로 플래그, 파일과 표준 입력 읽기도 여기서 한 가지 규칙으로 처리한다.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { usageError } from './errors.js';

export interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
}

export type OptionValues = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface ParsedCommand {
  values: OptionValues;
  positionals: string[];
}

/**
 * 토큰은 명령줄에 두지 않는다. 명령줄은 프로세스 목록과 셸 기록에 남는다.
 * 값은 메시지에 옮기지 않는다.
 */
export function rejectTokenFlag(argv: string[]): void {
  for (const arg of argv) {
    if (arg === '--') return;
    if (arg === '--token' || arg.startsWith('--token=')) {
      throw usageError(
        '--token 은 받지 않는다. 토큰이 명령줄에 남기 때문이다. ' +
          'ARMA_MCP_TOKEN 환경 변수나 토큰 파일을 쓴다.',
      );
    }
  }
}

function quotedName(message: string): string {
  return /'([^' ]+)/.exec(message)?.[1] ?? '';
}

function translateParseError(command: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    return usageError(
      `알 수 없는 옵션: ${quotedName(message)}. arma-mcp help ${command} 로 옵션을 본다. ` +
        '값이 - 로 시작하면 -- 뒤에 둔다.',
    );
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const name = quotedName(message);
    if (/does not take an argument/.test(message)) {
      return usageError(`옵션 ${name} 에는 값을 붙이지 않는다.`);
    }
    return usageError(
      `옵션 ${name} 의 값이 없다. 값이 - 로 시작하면 ${name}=값 형태로 쓴다.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

/** 명령 하나의 인자를 strict 로 해석한다. 모든 명령이 -h, --help 를 받는다. */
export function parseCommandArgs(
  command: string,
  argv: string[],
  options: Record<string, OptionSpec>,
): ParsedCommand {
  rejectTokenFlag(argv);
  try {
    const parsed = parseArgs({
      args: argv,
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: true,
    });
    return { values: parsed.values as OptionValues, positionals: parsed.positionals };
  } catch (error) {
    throw translateParseError(command, error);
  }
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagOption(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

/** multiple 로 받은 문자열 옵션. 없으면 빈 배열이다. */
export function stringListOption(values: OptionValues, name: string): string[] {
  const value = values[name];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000 };

/**
 * 시간 값을 ms 로 읽는다. 단위가 없으면 ms 다.
 * 1500, 500ms, 30s, 1.5s, 9m 을 받는다.
 */
export function parseDuration(text: string, flag = '시간'): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(text.trim());
  if (!match) {
    throw usageError(`${flag} 의 시간 값을 읽지 못했다: ${text}. 1500, 500ms, 30s, 9m 처럼 쓴다.`);
  }
  const unit = DURATION_UNITS[(match[2] ?? 'ms').toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * unit);
}

/** --deadline 에서 떼어 두는 여유(ms). 세션을 열고 닫는 시간과 응답 전달이 이 안에 들어온다. */
export const DEADLINE_MARGIN_MS = 5000;

/**
 * --deadline 값(ms). 주지 않았으면 undefined 다. 기본값은 두지 않는다.
 * 셸 도구는 시간 한도에서 명령을 죽이지 않고 백그라운드로 넘기기도 한다. 그때 기본 deadline 은 정상 실행만 끊는다.
 */
export function deadlineOption(values: OptionValues): number | undefined {
  const text = stringOption(values, 'deadline');
  if (text === undefined) return undefined;
  const ms = parseDuration(text, '--deadline');
  if (ms <= 0) throw usageError('--deadline 은 0 보다 커야 한다.');
  return ms;
}

export interface PathContext {
  cwd: string;
  platform: NodeJS.Platform;
}

/**
 * 경로 플래그를 절대 경로로 바꾼다.
 *
 * bin/arma-mcp 는 Git Bash 의 인자 변환을 끈다. 변환은 SQF 와 정규식의 / 까지 바꾸기 때문이다.
 * 그래서 /x/... 는 여기서 드라이브 경로로 바꾼다.
 * 그 밖의 / 로 시작하는 경로(/tmp 같은 MSYS 가상 경로)는 node 가 엉뚱한 곳으로 풀므로 거부한다.
 * Windows 가 아니면 셸 경로가 곧 실제 경로이므로 그대로 푼다.
 */
export function normalizePathFlag(value: string, flag: string, ctx: PathContext): string {
  if (ctx.platform !== 'win32') return path.resolve(ctx.cwd, value);
  const drive = msysDrivePath(value);
  if (drive !== null) return drive;
  if (value.startsWith('/')) {
    throw usageError(
      `${flag} 경로 ${value} 는 Windows 경로로 바꿀 수 없다. ` +
        `cygpath -w 로 바꿔 넘긴다. 예: ${flag} "$(cygpath -w '${value}')"`,
    );
  }
  return path.win32.resolve(ctx.cwd, value);
}

/** Git Bash 의 /x/... 를 X:\... 로 바꾼다. 그 모양이 아니면 null 이다. */
export function msysDrivePath(value: string): string | null {
  const msys = /^\/([A-Za-z])(?:\/(.*))?$/.exec(value);
  return msys ? path.win32.resolve(`${msys[1]!.toUpperCase()}:/${msys[2] ?? ''}`) : null;
}

export interface GamePathContext extends PathContext {
  /** 터널 연결이면 true 다. 게임 기계가 이 셸의 기계와 다르다. */
  tunnel: boolean;
}

/** 드라이브 문자나 UNC 로 시작하는 Windows 절대 경로. 게임 기계는 Windows 다. */
function isWindowsAbsolute(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^(?:\\\\|\/\/)[^\\/]/.test(value);
}

/**
 * 게임 기계에서 쓰일 경로 플래그(--mission, --mod, --unlock)를 바꾼다.
 * 로컬 연결이면 게임 기계가 곧 이 기계이므로 normalizePathFlag 와 같다.
 * 터널 연결이면 상대 경로를 이 셸 기준으로 풀지 않는다. 다른 기계의 엉뚱한 경로가 되기 때문이다.
 * 그때는 /x/... 만 드라이브 경로로 바꾸고, Windows 절대 경로가 아니면 거부한다.
 */
export function normalizeGamePath(value: string, flag: string, ctx: GamePathContext): string {
  if (!ctx.tunnel) return normalizePathFlag(value, flag, ctx);
  const drive = msysDrivePath(value);
  if (drive !== null) return drive;
  if (isWindowsAbsolute(value)) return path.win32.normalize(value);
  throw usageError(
    `${flag} 경로 ${value} 는 게임 기계의 절대 경로로 준다. ` +
      '터널 연결(ARMA_MCP_TOKEN)에서는 상대 경로를 이 셸 기준으로 풀지 않는다.',
  );
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 로컬 텍스트 파일을 읽는다. 편집기가 붙인 BOM 은 벗긴다. */
export function readTextFile(file: string, flag: string): string {
  try {
    return stripBom(readFileSync(file, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw usageError(`${flag} 파일을 읽지 못했다: ${file} (${code})`);
  }
}

export interface StdinLike extends AsyncIterable<string | Buffer> {
  isTTY?: boolean;
}

/**
 * 표준 입력을 끝까지 읽는다. 터미널이면 사람이 입력을 끝낼 방법을 모르고 멈추므로 거부한다.
 */
export async function readStdin(stdin: StdinLike, what: string): Promise<string> {
  if (stdin.isTTY) {
    throw usageError(
      `- 는 표준 입력에서 ${what} 읽는다. 지금 표준 입력이 터미널이라 읽지 않는다. ` +
        '파이프나 heredoc 으로 넘긴다.',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return stripBom(Buffer.concat(chunks).toString('utf8'));
}
