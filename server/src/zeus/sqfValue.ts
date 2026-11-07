// sqfValue.ts: fn_execRun 이 `str` 로 찍어 보낸 SQF 값을 TS 값으로 되읽는다.
//
// exec 결과는 `ARRAY: [...]` 처럼 typeName 과 str 텍스트로 온다. 조립 SQF 는 배열 안에
// 문자열, 숫자, 불리언만 담으므로 그 셋과 배열만 읽는다. `str` 은 문자열 안의 " 를 "" 로
// 두 번 쓰고, 큰 수는 1.23457e+006 처럼 지수로 찍는다.

export type SqfValue = string | number | boolean | null | SqfValue[];

export class SqfParseError extends Error {}

/** `any`, `<null>`, `nil` 은 null 로 읽는다. 그 밖의 맨 낱말(객체 str 등)은 거부한다. */
const NULL_WORDS = new Set(['any', '<null>', 'nil']);

export function parseSqfValue(text: string): SqfValue {
  let i = 0;

  const fail = (what: string): never => {
    throw new SqfParseError(`${what} at ${i}: ${text.slice(Math.max(0, i - 20), i + 20)}`);
  };

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };

  const readString = (): string => {
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const ch = text[i] as string;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          out += '"';
          i += 2;
          continue;
        }
        i++;
        return out;
      }
      out += ch;
      i++;
    }
  };

  const readArray = (): SqfValue[] => {
    i++;
    const out: SqfValue[] = [];
    skipWs();
    if (text[i] === ']') {
      i++;
      return out;
    }
    for (;;) {
      out.push(readValue());
      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return out;
      }
      fail('expected , or ]');
    }
  };

  const readWord = (): SqfValue => {
    const m = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(i));
    if (m) {
      i += m[0].length;
      const n = Number(m[0]);
      if (!Number.isFinite(n)) fail('bad number');
      return n;
    }
    const w = /^[<A-Za-z_][A-Za-z0-9_>-]*/.exec(text.slice(i));
    if (!w) return fail('unexpected character');
    const word = w[0];
    i += word.length;
    const lower = word.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    if (NULL_WORDS.has(lower)) return null;
    return fail(`unexpected word '${word}'`);
  };

  const readValue = (): SqfValue => {
    skipWs();
    const ch = text[i];
    if (ch === '[') return readArray();
    if (ch === '"') return readString();
    if (ch === undefined) return fail('unexpected end');
    return readWord();
  };

  const value = readValue();
  skipWs();
  if (i !== text.length) fail('trailing text');
  return value;
}

/** 실패하면 null. 호출부가 오류 문구를 정한다. */
export function tryParseSqfValue(text: string | undefined): SqfValue | null {
  if (typeof text !== 'string') return null;
  try {
    return parseSqfValue(text);
  } catch {
    return null;
  }
}
