// rptReader.ts — RPT 내용 읽기/검색/대기/에러 블록 추출.
//
// 대용량 RPT(수백 MB) 안전: 오프셋 기반 부분 읽기 + 라인 스트리밍.
// 오프셋은 바이트 단위. UTF-8 로 디코드하되 부분 멀티바이트는 다음 읽기로 이월.

import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolveRptTarget, rptAfter, newestRpt } from './rptFiles.js';
import { createDirWatcher, type DirWatcher } from './rptWatch.js';

/** exec 크로스레퍼런스용 커서: 특정 파일의 특정 오프셋. */
export interface RptCursor {
  file: string; // 절대경로
  offset: number; // 바이트
}

export interface ReadResult {
  file: string;
  path: string;
  text: string;
  startOffset: number;
  endOffset: number;
  fileSize: number;
  truncated: boolean;
}

/** 오프셋 fromOffset 부터 maxBytes 만큼 읽기. fromOffset 미지정 시 tailLines 기준. */
export async function readRpt(
  rptDir: string,
  opts: {
    file?: string;
    tailLines?: number;
    fromOffset?: number;
    maxBytes?: number;
    rptRe?: RegExp; // 미지정 시 클라 RPT 패턴(서버 RPT 는 SERVER_RPT_RE 전달)
  },
): Promise<ReadResult | null> {
  const target = resolveRptTarget(rptDir, opts.file, opts.rptRe);
  if (!target) return null;
  const st = await stat(target.path);
  const fileSize = st.size;
  const maxBytes = opts.maxBytes ?? 65536;

  let start: number;
  if (typeof opts.fromOffset === 'number') {
    start = Math.max(0, Math.min(opts.fromOffset, fileSize));
  } else {
    // tail: 마지막 maxBytes 범위를 읽어 tailLines 로 자른다.
    start = Math.max(0, fileSize - maxBytes);
  }
  const end = Math.min(fileSize, start + maxBytes);
  const truncated = end < fileSize && typeof opts.fromOffset === 'number';

  const fh = await open(target.path, 'r');
  try {
    const len = end - start;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');

    if (typeof opts.fromOffset !== 'number' && typeof opts.tailLines === 'number') {
      const lines = text.split('\n');
      if (lines.length > opts.tailLines) {
        text = lines.slice(lines.length - opts.tailLines).join('\n');
      }
    }
    return {
      file: target.name,
      path: target.path,
      text,
      startOffset: start,
      endOffset: end,
      fileSize,
      truncated,
    };
  } finally {
    await fh.close();
  }
}

export interface SearchMatch {
  lineNumber: number;
  offset: number;
  line: string;
  context: string[];
}

export interface SearchResult {
  file: string;
  path: string;
  matches: SearchMatch[];
  scannedToOffset: number;
  truncated: boolean;
}

/** 정규식 검색 (라인 스트리밍). */
export async function searchRpt(
  rptDir: string,
  opts: {
    pattern: string;
    file?: string;
    fromOffset?: number;
    maxMatches?: number;
    contextLines?: number;
    caseSensitive?: boolean;
    rptRe?: RegExp;
  },
): Promise<SearchResult | null> {
  const target = resolveRptTarget(rptDir, opts.file, opts.rptRe);
  if (!target) return null;
  const re = new RegExp(opts.pattern, opts.caseSensitive ? '' : 'i');
  const maxMatches = opts.maxMatches ?? 50;
  const ctx = opts.contextLines ?? 2;
  const st = await stat(target.path);
  const start = Math.max(0, Math.min(opts.fromOffset ?? 0, st.size));

  const matches: SearchMatch[] = [];
  const recent: string[] = []; // 최근 ctx 줄 버퍼
  let pendingAfter: { m: SearchMatch; need: number }[] = [];
  let lineNumber = 0;
  let truncated = false;

  const stream = createReadStream(target.path, { start, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber += 1;
    // 이전 매치의 after-context 채우기.
    for (const p of pendingAfter) {
      if (p.need > 0) {
        p.m.context.push(line);
        p.need -= 1;
      }
    }
    pendingAfter = pendingAfter.filter((p) => p.need > 0);

    if (re.test(line)) {
      const before = recent.slice(Math.max(0, recent.length - ctx));
      const m: SearchMatch = {
        lineNumber,
        offset: -1, // 라인 스트리밍에서는 정확한 바이트 오프셋 비제공
        line,
        context: [...before, line],
      };
      matches.push(m);
      if (ctx > 0) pendingAfter.push({ m, need: ctx });
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
    }
    recent.push(line);
    if (recent.length > ctx + 1) recent.shift();
  }
  rl.close();
  stream.destroy();

  return {
    file: target.name,
    path: target.path,
    matches,
    scannedToOffset: st.size,
    truncated,
  };
}

export interface ErrorBlock {
  line: number;
  block: string[];
}

// SQF 오류 블록: "Error in expression" / "Script error" 가 블록을 연다.
// 후속 "Error position:", "Error <detail>", "File ..., line N" 은 연속(continuation)이다.
// 상세 줄은 클라이언트 언어로 찍힌다("Error 표현식에 정의되지 않은 변수..."). 라틴 문자로 한정하지 않는다.
//
// 블록 오프너는 (선택적) 타임스탬프 직후에 마커가 오는 줄로 앵커링한다. 그렇지 않으면
// 상세 줄 "Error Generic error in expression" 의 "error in expression"(대소문자 무시)이
// 새 블록으로 오인된다. 연속 줄은 타임스탬프+들여쓰기가 있으므로 느슨하게 매칭한다.
const TS = /^\s*(?:\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s+)?/;
const ERROR_START_RE = new RegExp(TS.source + '(?:Error in expression|Script error)', 'i');
const ERROR_CONT_RE = /Error position:|Error \S|File .*line \d+/i;
// 애드온 감사 줄("[ArmaMCP] [EXEC] result <- ... check RPT for 'Error in expression'")은
// 오류 블록 바로 뒤에 찍히고 "Error i" 를 품고 있어 연속 줄로 오인된다.
const ADDON_LOG_RE = /"\[ArmaMCP\]/;
const GENERAL_ERROR_RE =
  /Error in expression|Error position|Script error|Warning Message:|Cannot (load|open|find)|File .*line \d+|No entry/i;

/**
 * fromOffset 부터 EOF 까지 스캔하며 SQF 오류 블록을 그룹핑.
 * "Error in expression <code>" + 뒤따르는 "Error position:" / "File ... line N" 을 한 블록으로 묶는다.
 */
export async function extractErrorBlocks(
  rptPath: string,
  fromOffset = 0,
): Promise<{ errors: ErrorBlock[]; scannedToOffset: number }> {
  const st = await stat(rptPath);
  const start = Math.max(0, Math.min(fromOffset, st.size));
  const errors: ErrorBlock[] = [];
  let lineNumber = 0;
  let current: ErrorBlock | null = null;

  const stream = createReadStream(rptPath, { start, encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineNumber += 1;
    if (ERROR_START_RE.test(line)) {
      if (current) errors.push(current);
      current = { line: lineNumber, block: [line] };
    } else if (current && ERROR_CONT_RE.test(line) && !ADDON_LOG_RE.test(line)) {
      current.block.push(line);
      // 블록은 보통 몇 줄 이내. 너무 길어지면 종료.
      if (current.block.length >= 8) {
        errors.push(current);
        current = null;
      }
    } else if (current) {
      errors.push(current);
      current = null;
    }
  }
  if (current) errors.push(current);
  rl.close();
  stream.destroy();

  return { errors, scannedToOffset: st.size };
}

/**
 * file 의 offset 뒤에 needle(평문)이 기록될 때까지 pollMs 간격으로 기다린다.
 * 매번 새로 붙은 바이트만 읽는다. 폴 경계에 걸친 needle 을 놓치지 않게 앞 조각의 끝을 이어 붙인다.
 * needle 은 ASCII 라고 가정하고 latin1 로 디코드한다. 멀티바이트 문자가 폴 경계에서 잘려도 오탐이 없다.
 */
export async function waitForTextAfter(
  file: string,
  offset: number,
  needle: string,
  timeoutMs = 1500,
  pollMs = 100,
): Promise<{ found: boolean; elapsedMs: number }> {
  const startedAt = Date.now();
  const deadline = startedAt + Math.max(0, timeoutMs);
  const keep = Math.max(0, needle.length - 1);
  let pos = Math.max(0, offset);
  let carry = '';
  for (;;) {
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      size = 0; // 파일이 사라지면 다음 폴에서 다시 본다.
    }
    if (size > pos) {
      let text = '';
      try {
        const fh = await open(file, 'r');
        try {
          const len = size - pos;
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, pos);
          pos += bytesRead;
          text = carry + buf.toString('latin1', 0, bytesRead);
        } finally {
          await fh.close();
        }
      } catch {
        text = carry; // stat 과 open 사이에 사라졌다. 다음 폴에서 다시 본다.
      }
      if (text.includes(needle)) return { found: true, elapsedMs: Date.now() - startedAt };
      carry = keep > 0 ? text.slice(-keep) : '';
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { found: false, elapsedMs: Date.now() - startedAt };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, remaining)));
  }
}

/** 일반 오류 라인(블록 아님) 매칭 — arma_rpt_errors 편의 툴용 프리셋. */
export function generalErrorRegex(): RegExp {
  return new RegExp(GENERAL_ERROR_RE.source, 'i');
}

export interface WaitResult {
  found: boolean;
  file: string;
  line?: string;
  lineNumber?: number;
  offset?: number;
  elapsedMs: number;
  aborted?: boolean;
  /** 대기 시작 전에 이미 기록돼 있던 라인에 매치(프리스캔 즉답). */
  preExisting?: boolean;
  note?: string;
}

/** fromEnd 미지정 시 프리스캔하는 tail 범위. */
const PRESCAN_BYTES = 65536;

/** RPT 는 CRLF 로 기록된다. '\n' 으로 자른 줄 끝에 남은 '\r' 을 떼어 낸다. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// 애드온의 exec 감사 줄. fn_onExec.sqf 는 보낸 코드를 그대로 찍고 fn_execResultIn.sqf 는 결과를 찍는다.
// exec 커서 뒤에서 기다리면 코드 속 마커가 이 줄에 곧바로 맞는다. 기다리던 일이 일어나기 전이다.
// nil 결과 줄의 "check RPT for 'Error in expression'" 도 error 가 든 패턴에 맞는다.
// 그래서 대기는 이 줄을 보지 않는다. 준비 마커처럼 [EXEC] 가 아닌 [ArmaMCP] 줄은 그대로 본다.
const EXEC_AUDIT_RE = /"\[ArmaMCP\] \[EXEC\] /;

/** 대기 패턴이 이 줄에 맞는지. exec 감사 줄은 맞지 않는 것으로 본다. */
function waitLineMatches(re: RegExp, line: string): boolean {
  return re.test(line) && !EXEC_AUDIT_RE.test(line);
}

async function prescanTail(
  targetPath: string,
  size: number,
  re: RegExp,
): Promise<string | null> {
  const start = Math.max(0, size - PRESCAN_BYTES);
  let text: string;
  try {
    const fh = await open(targetPath, 'r');
    try {
      const len = size - start;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const lines = text.split('\n');
  if (start > 0) lines.shift(); // 범위 경계의 부분 라인은 버린다.
  for (const raw of lines) {
    const line = stripCr(raw);
    if (waitLineMatches(re, line)) return line;
  }
  return null;
}

/**
 * 패턴이 나타날 때까지 폴링 대기(기본 250ms 간격). 부분 라인은 폴 간 이월.
 * file='next' 면 현재 최신보다 뒤 이름의 새 RPT 가 생길 때까지 먼저 기다린다.
 */
export interface WaitForPatternOptions {
  pattern: string;
  file?: string; // 'newest' | 'next' | name | absPath
  timeoutMs?: number;
  fromEnd?: boolean;
  /**
   * 이 바이트 위치부터 감시한다. 이미 기록된 줄도 이 위치 뒤면 찾는다.
   * 주면 fromEnd 와 프리스캔을 쓰지 않는다. arma_exec 의 rptCursor.offset 을 그대로 받는다.
   */
  fromOffset?: number;
  pollMs?: number;
  rptRe?: RegExp;
  signal?: AbortSignal;
}

export async function waitForPattern(
  rptDir: string,
  opts: WaitForPatternOptions,
): Promise<WaitResult> {
  // 디렉터리 watch 는 폴 간격 조기 기상용 — 유실돼도 폴링이 안전망(rptWatch.ts 헤더).
  const watcher = createDirWatcher(rptDir);
  try {
    return await waitForPatternInner(rptDir, opts, watcher);
  } finally {
    watcher.dispose();
  }
}

async function waitForPatternInner(
  rptDir: string,
  opts: WaitForPatternOptions,
  watcher: DirWatcher,
): Promise<WaitResult> {
  const re = new RegExp(opts.pattern, 'i');
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollMs = opts.pollMs ?? 250;
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // 대상 파일 결정.
  let targetPath: string;
  let targetName: string;
  if (opts.file === 'next') {
    const before = newestRpt(rptDir, opts.rptRe);
    const prevName = before ? before.name : '';
    let appeared = rptAfter(rptDir, prevName, opts.rptRe);
    while (!appeared && Date.now() < deadline && !opts.signal?.aborted) {
      await watcher.wait(pollMs, opts.signal);
      appeared = rptAfter(rptDir, prevName, opts.rptRe);
    }
    if (!appeared) {
      return {
        found: false,
        file: '',
        elapsedMs: Date.now() - startTime,
        aborted: opts.signal?.aborted || undefined,
      };
    }
    targetPath = appeared.path;
    targetName = appeared.name;
  } else {
    const target = resolveRptTarget(rptDir, opts.file, opts.rptRe);
    if (!target) return { found: false, file: '', elapsedMs: Date.now() - startTime };
    targetPath = target.path;
    targetName = target.name;
  }

  // 시작 오프셋: fromEnd(기본 true)면 현재 EOF 부터. 단 fromEnd 를 명시하지 않은
  // 호출은 "이미 도착한 패턴"을 놓치고 타임아웃 전액을 소모하는 함정이 있어,
  // EOF 로 가기 전에 마지막 64KB 를 1회 프리스캔해 매치 시 즉답한다.
  // fromEnd:true 명시는 현행대로 새 출력만 기다린다.
  // fromOffset 을 주면 그 위치부터 읽는다. exec 커서를 이어받는 호출이 이 경로를 쓴다.
  let offset = 0;
  if (opts.fromOffset !== undefined) {
    offset = Math.max(0, opts.fromOffset);
  } else if (opts.fromEnd !== false) {
    let size = 0;
    try {
      size = (await stat(targetPath)).size;
    } catch {
      size = 0;
    }
    offset = size;
    if (opts.fromEnd === undefined && size > 0) {
      const hit = await prescanTail(targetPath, size, re);
      if (hit !== null) {
        return {
          found: true,
          preExisting: true,
          file: targetName,
          line: hit,
          offset: size,
          elapsedMs: Date.now() - startTime,
          note:
            '패턴이 대기 시작 전에 이미 기록돼 있었습니다(마지막 64KB 프리스캔). ' +
            '앞으로 나올 새 출력만 기다리려면 fromEnd:true 를 명시하세요.',
        };
      }
    }
  }
  let remainder = '';
  let lineNumber = 0;

  while (Date.now() < deadline && !opts.signal?.aborted) {
    let size = 0;
    try {
      size = (await stat(targetPath)).size;
    } catch {
      /* 파일이 아직/사라짐 */
    }
    if (size > offset) {
      const fh = await open(targetPath, 'r');
      try {
        const len = size - offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        offset = size;
        const text = remainder + buf.toString('utf8');
        const lines = text.split('\n');
        remainder = lines.pop() ?? '';
        for (const raw of lines) {
          lineNumber += 1;
          const line = stripCr(raw);
          if (waitLineMatches(re, line)) {
            return {
              found: true,
              file: targetName,
              line,
              lineNumber,
              offset,
              elapsedMs: Date.now() - startTime,
            };
          }
        }
      } finally {
        await fh.close();
      }
    }
    await watcher.wait(pollMs, opts.signal);
  }
  // 세션/요청 취소는 마지막 부분 라인의 우연한 매치보다 우선한다.
  if (opts.signal?.aborted) {
    return {
      found: false,
      file: targetName,
      elapsedMs: Date.now() - startTime,
      aborted: true,
    };
  }

  // 마지막 remainder 검사.
  const tail = stripCr(remainder);
  if (tail && waitLineMatches(re, tail)) {
    return {
      found: true,
      file: targetName,
      line: tail,
      offset,
      elapsedMs: Date.now() - startTime,
    };
  }
  return {
    found: false,
    file: targetName,
    elapsedMs: Date.now() - startTime,
    aborted: opts.signal?.aborted || undefined,
  };
}
