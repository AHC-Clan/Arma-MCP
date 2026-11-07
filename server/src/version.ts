/** One source of truth for daemon, relay handshake, and MCP server metadata. */
export const ARMA_MCP_VERSION = '0.5.13';

/**
 * 'a.b.c' 숫자 비교. 같으면 0, 왼쪽이 크면 양수.
 *
 * 이 파일은 의도적으로 import 가 없다. self-update 경로가 버전 비교 하나 때문에
 * daemon/config 계층 전체를 끌어오지 않게 하려는 것이다.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value.split('.').map((part) => {
      const numeric = Number.parseInt(part, 10);
      return Number.isFinite(numeric) ? numeric : 0;
    });
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
