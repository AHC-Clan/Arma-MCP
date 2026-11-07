// log.ts — stderr 전용 로거.
//
// stdio MCP transport가 stdout을 독점하므로 stdout으로 나가는 어떤 바이트도
// 프로토콜을 오염시킨다. 모든 로그는 stderr(그리고 옵션 파일)로만 나간다.
// index.ts에서 console.* 을 이 로거로 리다이렉트하는 안전망도 건다.

import { appendFileSync } from 'node:fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = LEVELS.info;
let logFilePath = '';

export function configureLogger(opts: { level?: LogLevel; file?: string }): void {
  if (opts.level) threshold = LEVELS[opts.level];
  logFilePath = opts.file ?? '';
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const ts = new Date().toISOString();
  const parts = args.map((a) =>
    typeof a === 'string' ? a : (() => {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })(),
  );
  const line = `${ts} [${level}] ${parts.join(' ')}`;
  // 항상 stderr — stdout은 MCP transport 전용.
  process.stderr.write(line + '\n');
  if (logFilePath) {
    try {
      appendFileSync(logFilePath, line + '\n');
    } catch {
      /* 파일 로깅 실패는 무시 — stderr는 이미 나갔다 */
    }
  }
}

export const log = {
  debug: (...a: unknown[]) => emit('debug', a),
  info: (...a: unknown[]) => emit('info', a),
  warn: (...a: unknown[]) => emit('warn', a),
  error: (...a: unknown[]) => emit('error', a),
};

// console.* 이 실수로 stdout에 쓰는 것을 막는 안전망.
export function redirectConsoleToStderr(): void {
  const toStderr = (...a: unknown[]) => emit('info', a);
  console.log = toStderr;
  console.info = toStderr;
  console.warn = (...a: unknown[]) => emit('warn', a);
  console.error = (...a: unknown[]) => emit('error', a);
  console.debug = (...a: unknown[]) => emit('debug', a);
}
