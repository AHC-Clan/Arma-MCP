// context.ts: 명령이 함께 쓰는 입출력과 설정, 데몬 세션.
//
// 명령은 process 를 직접 만지지 않고 여기 io 를 쓴다. 테스트는 io 를 바꿔 끼운다.

import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../config.js';
import type { GamePathContext, PathContext, StdinLike } from './args.js';
import { openCliSession, type CliSession, type OpenCliSessionOptions } from './session.js';

export interface TextSink {
  write(chunk: string): unknown;
}

export interface CliIo {
  /** 명령 결과만 쓴다. */
  stdout: TextSink;
  /** 사람이 읽는 오류와 안내를 쓴다. */
  stderr: TextSink;
  stdin: StdinLike;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  /** 테스트 주입. 비우면 env 를 따라 설정 파일을 조용히 읽는다. */
  loadConfig?: () => Config;
  /** 중단 신호. 걸리면 진행 중인 도구 호출을 끊고 종료 코드 130 으로 끝낸다. */
  interrupt?: AbortSignal;
  /** 테스트 주입. 데몬 대신 가짜 세션을 연다. 비우면 설정의 데몬에 붙는다. */
  openSession?: (opts: OpenCliSessionOptions) => Promise<CliSession>;
}

/** 인자에 stack 이 없으면 고른 스택을 얹는다. call 에 준 JSON 의 stack 이 이긴다. */
function withStack(session: CliSession, stack: string | undefined): CliSession {
  if (!stack) return session;
  return {
    endpoint: session.endpoint,
    call: (name, args, opts) =>
      session.call(name, args.stack === undefined ? { ...args, stack } : args, opts),
    close: () => session.close(),
  };
}

export interface CliCommand {
  name: string;
  /** help 목록의 한 줄 설명. */
  summary: string;
  /** arma-mcp help NAME 이 찍는 전체 도움말. */
  usage: string;
  run(argv: string[], ctx: CliContext): Promise<number>;
}

export class CliContext {
  private cfg: Config | null = null;
  /**
   * --stack 이나 ARMA_MCP_STACK 로 고른 테스트 스택. 세션의 도구 호출마다 stack 으로 얹는다.
   * 비었으면 얹지 않아 데몬이 default 스택을 쓴다.
   */
  stack: string | undefined;

  constructor(readonly io: CliIo) {
    const fromEnv = io.env.ARMA_MCP_STACK?.trim();
    this.stack = fromEnv ? fromEnv : undefined;
  }

  out(line: string): void {
    this.io.stdout.write(line + '\n');
  }

  err(line: string): void {
    this.io.stderr.write(line + '\n');
  }

  get paths(): PathContext {
    return { cwd: this.io.cwd, platform: this.io.platform };
  }

  /**
   * 터널로 붙는 셸인지. ARMA_MCP_TOKEN 이 있으면 데몬과 게임은 다른 기계에 있다.
   * 그때는 게임 기계 경로를 이 셸 기준으로 풀지 않고, 데몬 쪽 파일도 여기서 읽지 않는다.
   */
  get tunnel(): boolean {
    return Boolean(this.io.env.ARMA_MCP_TOKEN);
  }

  /** --mission, --mod, --unlock 처럼 게임 기계에서 쓰일 경로의 해석 기준. */
  get gamePaths(): GamePathContext {
    return { ...this.paths, tunnel: this.tunnel };
  }

  config(): Config {
    this.cfg ??= this.io.loadConfig?.() ?? loadConfig(undefined, { quiet: true, env: this.io.env });
    return this.cfg;
  }

  /** 세션을 열어 fn 에 넘기고, 끝나거나 실패하면 닫는다. */
  async withSession<T>(fn: (session: CliSession) => Promise<T>): Promise<T> {
    const opts: OpenCliSessionOptions = { signal: this.io.interrupt };
    const session = this.io.openSession
      ? await this.io.openSession(opts)
      : await openCliSession(this.config(), this.io.env, opts);
    try {
      return await fn(withStack(session, this.stack));
    } finally {
      await session.close();
    }
  }

  /** CLI 가 기본으로 파일을 쓰는 곳. 작업 트리가 아니라 %TEMP%\arma-mcp 다. */
  tempDir(): string {
    const env = this.io.env;
    return path.join(env.TEMP || env.TMP || env.TMPDIR || os.tmpdir(), 'arma-mcp');
  }
}
