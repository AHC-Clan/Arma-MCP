// sqfLiteral.ts — TS 값을 SQF 리터럴로 안전하게 직렬화하고, exec 결과 문자열에서
// ack 페이로드를 되꺼낸다.
//
// 서버가 조립하는 SQF 는 exec 경로에서 `compile` 만 되고 preprocess 되지 않는다.
// 따라서 조립 코드에는 주석(//, /* */)을 절대 넣지 않으며(남으면 조용히 <nil> 로 파손),
// 숫자는 지수 표기가 새지 않도록 고정 소수로 찍는다.

/** SQF 문자열 리터럴로 이스케이프(" → ""). */
export function sqfString(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * SQF 숫자 리터럴. 유한 수치만 허용한다(NaN/Infinity 는 파서를 깬다).
 *
 * toFixed 는 |n| < 1e21 에서만 고정 소수를 보장하고 그 이상은 `1e+21` 을 돌려준다.
 * 지수 표기는 SQF 파서를 깨므로 애초에 비현실적인 크기(좌표·초·미터 어느 것도
 * 1e15 에 닿지 않는다)는 여기서 거부한다.
 */
const SQF_NUMBER_MAX = 1e15;

export function sqfNumber(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`sqfNumber: non-finite number (${n})`);
  if (Math.abs(n) >= SQF_NUMBER_MAX) {
    throw new Error(`sqfNumber: magnitude out of range (${n})`);
  }
  const s = n.toFixed(6).replace(/\.?0+$/, '');
  if (s === '' || s === '-' || s === '-0') return '0';
  return s;
}

/** 문자열 배열을 SQF 배열 리터럴로. */
export function sqfStringArray(items: readonly string[]): string {
  return '[' + items.map(sqfString).join(',') + ']';
}

/**
 * fn_execRun 이 만든 `STRING: "OK:x"` 의 value 부분에서 ack 페이로드만 꺼낸다.
 *
 * fn_execRun 은 `format ["%1: %2", typeName _r, str _r]` 이므로 문자열 반환은
 * 바깥 따옴표가 그대로 남는다(BOOL 을 비교하는 arma_web_open 과 다른 점).
 * 문자열이 아니거나 따옴표로 감싸이지 않았으면 null — 호출부는 이를 실패로 다룬다.
 */
export function ackOf(parsedValue: string | undefined): string | null {
  if (typeof parsedValue !== 'string') return null;
  const t = parsedValue.trim();
  const m = /^"([\s\S]*)"$/.exec(t);
  if (!m || typeof m[1] !== 'string') return null;
  return m[1].replace(/""/g, '"');
}
