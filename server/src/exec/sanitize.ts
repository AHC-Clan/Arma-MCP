// sanitize.ts — SQF 코드 주석 제거/거부 (문자열 리터럴 인식).
//
// 왜 필요한가: 인게임 exec 경로는 `compile` 만 하고 preprocessFile 을 하지 않는다.
// 따라서 // 나 /* */ 주석이 남아 있으면 컴파일 결과가 조용히 <nil> 로 파손되고
// 부작용(side effect)도 실행되지 않는다. 전송 전에 반드시 제거해야 한다.
//
// 문자열 안의 `//` 는 주석이 아니다: "http://example.com" 은 보존해야 하고,
// '// not a comment' 도 보존해야 한다. SQF 문자열 이스케이프는 따옴표 doubling:
//   "그는 ""안녕"" 했다"   →  그는 "안녕" 했다
//   'it''s'                →  it's

export interface SanitizeResult {
  code: string;
  changed: boolean;
  removedComments: number;
}

export class CommentRejectedError extends Error {
  constructor(
    message: string,
    public readonly line: number,
    public readonly col: number,
  ) {
    super(message);
    this.name = 'CommentRejectedError';
  }
}

type Mode = 'strip' | 'reject';

/**
 * SQF 소스에서 주석을 제거(strip)하거나, 발견 시 예외를 던진다(reject).
 * 문자열 리터럴 내부의 //, /* 는 건드리지 않는다.
 */
export function sanitizeSqf(src: string, mode: Mode = 'strip'): SanitizeResult {
  let out = '';
  let removed = 0;
  let line = 1;
  let col = 1;
  const n = src.length;
  let i = 0;

  const advance = (ch: string): void => {
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
  };

  while (i < n) {
    const ch = src[i]!;
    const next = i + 1 < n ? src[i + 1] : '';

    // 문자열 리터럴: " 또는 ' 로 시작. 같은 따옴표가 doubling 이면 리터럴 내부.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      advance(ch);
      i += 1;
      while (i < n) {
        const c = src[i]!;
        if (c === quote) {
          if (i + 1 < n && src[i + 1] === quote) {
            // doubled quote — 이스케이프된 따옴표, 리터럴 계속.
            out += c + c;
            advance(c);
            advance(c);
            i += 2;
            continue;
          }
          // 리터럴 종료.
          out += c;
          advance(c);
          i += 1;
          break;
        }
        out += c;
        advance(c);
        i += 1;
      }
      continue;
    }

    // 라인 주석.
    if (ch === '/' && next === '/') {
      if (mode === 'reject') {
        throw new CommentRejectedError(`line comment at ${line}:${col}`, line, col);
      }
      removed += 1;
      while (i < n && src[i] !== '\n') i += 1;
      // 개행은 남겨서 라인 번호(RPT 대조)를 보존.
      continue;
    }

    // 블록 주석.
    if (ch === '/' && next === '*') {
      if (mode === 'reject') {
        throw new CommentRejectedError(`block comment at ${line}:${col}`, line, col);
      }
      removed += 1;
      i += 2;
      col += 2;
      while (i < n && !(src[i] === '*' && i + 1 < n && src[i + 1] === '/')) {
        advance(src[i]!);
        i += 1;
      }
      // 닫는 */ 소비.
      if (i < n) {
        i += 2;
        col += 2;
      }
      // 블록 주석을 공백 1개로 치환해 토큰 경계를 유지 (a/*x*/b → a b).
      out += ' ';
      continue;
    }

    out += ch;
    advance(ch);
    i += 1;
  }

  return { code: out, changed: removed > 0, removedComments: removed };
}
