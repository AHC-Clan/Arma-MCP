// exec.ts: arma-mcp exec. arma_exec 한 번으로 SQF 를 실행하고 결과를 찍는다.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  flagOption,
  normalizePathFlag,
  parseCommandArgs,
  parseDuration,
  readStdin,
  readTextFile,
  stringOption,
} from '../args.js';
import type { CliCommand, CliContext } from '../context.js';
import { EXIT, usageError } from '../errors.js';
import {
  execExitCode,
  isRecord,
  jsonLine,
  readToolResult,
  renderExec,
  renderExecRaw,
  rptSince,
  type ImageBlock,
} from '../render.js';

const EXEC_MODES = ['server', 'all', 'client'] as const;
const TIMEOUT_MIN_MS = 500;
const TIMEOUT_MAX_MS = 600_000;
const CAPTURE_DELAY_MAX_MS = 10_000;
/** 감사 로그에서 CLI 가 보낸 실행을 가린다. */
const DEFAULT_LABEL = 'cli';

const USAGE = `arma-mcp exec CODE | -f FILE | -  [옵션]

SQF 를 게임에서 실행하고 결과를 찍는다. 코드가 - 로 시작하면 -- 뒤에 둔다.

  -f, --file FILE    파일에서 코드를 읽는다
  -                  표준 입력에서 코드를 읽는다
  --mode MODE        server(기본), all, client
  --target NAME      --mode client 의 대상 플레이어
  --timeout 5s       결과 대기(기본 5s, all 은 3s). 500ms 에서 10m 사이
  --rpt              성공한 실행도 실행 구간 RPT 오류를 훑는다. RPT 커서를 stderr 에 FILE:OFFSET 으로 찍는다
  --verify EXPR      실행 뒤 따로 평가할 증거식. server 모드에서만 쓴다
  --label TEXT       인게임 감사 로그 라벨(기본 cli)
  --capture          실행 뒤 게임 화면을 찍어 파일로 쓰고 경로를 찍는다
    --delay 250      찍기 전 대기(기본 250ms, 최대 10s)
    --shot FILE      이미지 경로(기본 %TEMP%\\arma-mcp\\shot-<reqId>.jpg)
                     .jpg 나 .jpeg 면 JPEG, .png 면 PNG 로 찍는다
  --raw              값만 찍는다. STRING 은 따옴표를 벗기고 "" 를 " 로 되돌린다
  --json             도구 JSON 을 한 줄로 찍는다. rptSince 에 FILE:OFFSET 을 싣는다
  --out FILE         출력을 파일에 쓰고 stdout 에는 그 경로만 찍는다

종료 코드는 성공이면 0 이다. 실행 실패, ERROR 결과, RPT 오류가 붙은 nil 은 1 이다.`;

interface ExecRequest {
  args: Record<string, unknown>;
  mode: string;
  raw: boolean;
  json: boolean;
  rpt: boolean;
  capture: boolean;
  shot?: string;
  out?: string;
}

async function readCode(
  ctx: CliContext,
  file: string | undefined,
  positionals: string[],
): Promise<string> {
  if (file !== undefined) {
    if (positionals.length > 0) throw usageError('코드는 CODE, -f FILE, - 중 하나로만 준다.');
    return readTextFile(normalizePathFlag(file, '-f', ctx.paths), '-f');
  }
  if (positionals.length === 0) {
    throw usageError('실행할 코드가 없다. arma-mcp exec CODE, -f FILE, - 중 하나로 준다.');
  }
  if (positionals.length > 1) {
    throw usageError('코드는 인자 하나로 준다. 공백이 있으면 따옴표로 감싼다.');
  }
  const only = positionals[0]!;
  return only === '-' ? readStdin(ctx.io.stdin, '코드를') : only;
}

async function parseRequest(argv: string[], ctx: CliContext): Promise<ExecRequest | null> {
  const { values, positionals } = parseCommandArgs('exec', argv, {
    file: { type: 'string', short: 'f' },
    mode: { type: 'string' },
    target: { type: 'string' },
    timeout: { type: 'string' },
    rpt: { type: 'boolean' },
    verify: { type: 'string' },
    label: { type: 'string' },
    capture: { type: 'boolean' },
    delay: { type: 'string' },
    shot: { type: 'string' },
    raw: { type: 'boolean' },
    json: { type: 'boolean' },
    out: { type: 'string' },
  });
  if (flagOption(values, 'help')) return null;

  const mode = stringOption(values, 'mode') ?? 'server';
  if (!(EXEC_MODES as readonly string[]).includes(mode)) {
    throw usageError(`--mode 는 server, all, client 중 하나다: ${mode}`);
  }
  const target = stringOption(values, 'target');
  if (mode === 'client' && !target) throw usageError('--mode client 는 --target NAME 이 필요하다.');
  if (mode !== 'client' && target !== undefined) {
    throw usageError('--target 은 --mode client 와 함께 쓴다.');
  }
  const verify = stringOption(values, 'verify');
  if (verify !== undefined && mode !== 'server') {
    throw usageError('--verify 는 server 모드에서만 쓴다.');
  }
  const raw = flagOption(values, 'raw');
  const json = flagOption(values, 'json');
  if (raw && json) throw usageError('--raw 와 --json 은 함께 쓰지 않는다.');

  const capture = flagOption(values, 'capture');
  const delayText = stringOption(values, 'delay');
  const shotText = stringOption(values, 'shot');
  if (!capture && (delayText !== undefined || shotText !== undefined)) {
    throw usageError('--delay 와 --shot 은 --capture 와 함께 쓴다.');
  }

  // 경로와 값 검사를 모두 끝낸 뒤에 코드를 읽는다. 표준 입력은 한 번만 읽을 수 있다.
  const shot = shotText === undefined ? undefined : normalizePathFlag(shotText, '--shot', ctx.paths);
  const shotFormat = shot === undefined ? undefined : shotFormatFor(shot);
  const outText = stringOption(values, 'out');
  const out = outText === undefined ? undefined : normalizePathFlag(outText, '--out', ctx.paths);

  const args: Record<string, unknown> = {
    mode,
    label: stringOption(values, 'label') ?? DEFAULT_LABEL,
  };
  if (target !== undefined) args.target = target;
  if (verify !== undefined) args.verify = verify;
  const timeoutText = stringOption(values, 'timeout');
  if (timeoutText !== undefined) {
    const timeoutMs = parseDuration(timeoutText, '--timeout');
    if (timeoutMs < TIMEOUT_MIN_MS || timeoutMs > TIMEOUT_MAX_MS) {
      throw usageError('--timeout 은 500ms 에서 10m 사이다.');
    }
    args.timeoutMs = timeoutMs;
  }
  const rpt = flagOption(values, 'rpt');
  if (rpt) args.checkRpt = true;
  if (capture) {
    const delayMs = delayText === undefined ? undefined : parseDuration(delayText, '--delay');
    if (delayMs !== undefined && delayMs > CAPTURE_DELAY_MAX_MS) {
      throw usageError('--delay 는 10s 를 넘을 수 없다.');
    }
    args.capture = {
      returnImage: true,
      ...(delayMs !== undefined ? { delayMs } : {}),
      ...(shotFormat !== undefined ? { format: shotFormat } : {}),
    };
  }

  const code = await readCode(ctx, stringOption(values, 'file'), positionals);
  if (code.trim() === '') throw usageError('실행할 코드가 비어 있다.');
  args.code = code;
  return { args, mode, raw, json, rpt, capture, shot, out };
}

/**
 * --shot 확장자로 캡처 형식을 고른다. 파일 내용이 확장자와 같은 형식이어야 이미지를 여는
 * 도구가 확장자를 믿고 읽을 수 있다. 다른 확장자는 받지 않는다.
 */
export function shotFormatFor(file: string): 'jpeg' | 'png' {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'png';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpeg';
  throw usageError(`--shot 파일은 .jpg, .jpeg, .png 로 끝나야 한다: ${file}`);
}

function shotFileName(reqId: unknown, mimeType: string): string {
  const id =
    (typeof reqId === 'string' ? reqId.replace(/[^A-Za-z0-9_-]/g, '') : '') ||
    Date.now().toString(36);
  return `shot-${id}.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
}

/** 이미지를 파일로 쓴다. 기본 위치는 작업 트리가 아니라 %TEMP%\arma-mcp 다. */
export function writeShot(image: ImageBlock, file: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(image.data, 'base64'));
  return file;
}

function writeOutput(ctx: CliContext, lines: string[], out: string | undefined): void {
  if (out === undefined) {
    for (const line of lines) ctx.out(line);
    return;
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  ctx.out(out);
}

async function run(argv: string[], ctx: CliContext): Promise<number> {
  const request = await parseRequest(argv, ctx);
  if (!request) {
    ctx.out(USAGE);
    return EXIT.ok;
  }

  return ctx.withSession(async (session) => {
    const payload = readToolResult(await session.call('arma_exec', request.args));
    if (payload.isError || !isRecord(payload.json)) {
      ctx.err(`arma_exec 실패: ${payload.text}`);
      return EXIT.failure;
    }
    const outcome = payload.json;
    let code: number = execExitCode(outcome);
    const since = rptSince(outcome);

    let shot: string | null = null;
    const stderr: string[] = [];
    if (request.capture) {
      const image = payload.images[0];
      if (image) {
        shot = writeShot(
          image,
          request.shot ?? path.join(ctx.tempDir(), shotFileName(outcome.reqId, image.mimeType)),
        );
      } else {
        const meta = isRecord(outcome.capture) ? outcome.capture : {};
        stderr.push(`캡처 실패: ${typeof meta.error === 'string' ? meta.error : '이미지가 오지 않았다'}`);
        if (code === EXIT.ok) code = EXIT.failure;
      }
    }

    let stdout: string[];
    if (request.json) {
      const extra: Record<string, unknown> = {};
      if (since) extra.rptSince = since;
      if (shot) extra.shot = shot;
      stdout = [jsonLine(payload, extra)];
    } else if (request.raw) {
      const rendered = renderExecRaw(outcome);
      stdout = rendered.stdout;
      stderr.unshift(...rendered.stderr);
      if (shot) stderr.push(`shot: ${shot}`);
    } else {
      const rendered = renderExec(outcome, request.mode);
      stdout = rendered.stdout;
      if (shot) stdout.push(`shot: ${shot}`);
      stderr.unshift(...rendered.stderr);
    }
    if (request.rpt && since && !request.json) stderr.push(`rpt: ${since}`);

    writeOutput(ctx, stdout, request.out);
    for (const line of stderr) ctx.err(line);
    return code;
  });
}

export const execCommand: CliCommand = {
  name: 'exec',
  summary: 'SQF 를 실행하고 결과를 찍는다',
  usage: USAGE,
  run,
};
