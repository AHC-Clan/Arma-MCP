// frame.ts — 길이 프리픽스 UTF-8 프레이밍. DLL의 FrameCodec 과 바이트 호환.
//   [4바이트 LE uint32 길이][payload: UTF-8]
//
// AHC_TacticalMap/project/webserver/src/frame.js 를 TS 로 포팅.

export const MAX_FRAME = 1 * 1024 * 1024; // kMaxFrameBytes 미러

export function encode(payloadStr: string): Buffer {
  const payload = Buffer.from(payloadStr, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * 상태를 가진 디코더 생성. feed(Buffer) -> payload 문자열 배열.
 * 손상된(과대) 길이 프리픽스면 throw — 호출자가 peer 를 끊어야 함.
 */
export function makeDecoder(): (chunk: Buffer) => string[] {
  let chunks: Buffer[] = [];
  let total = 0;

  function push(chunk: Buffer): void {
    if (!chunk || chunk.length === 0) return;
    chunks.push(chunk);
    total += chunk.length;
  }

  function peek(n: number): Buffer | null {
    if (chunks.length === 0 || total < n) return null;
    const first = chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    for (const c of chunks) {
      const take = Math.min(c.length, n - off);
      c.copy(out, off, 0, take);
      off += take;
      if (off === n) break;
    }
    return out;
  }

  function take(n: number): Buffer {
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = chunks[0]!;
      const want = Math.min(c.length, n - off);
      c.copy(out, off, 0, want);
      off += want;
      if (want === c.length) chunks.shift();
      else chunks[0] = c.subarray(want);
    }
    total -= n;
    return out;
  }

  return function feed(chunk: Buffer): string[] {
    push(chunk);
    const out: string[] = [];
    for (;;) {
      if (total < 4) break;
      const header = peek(4)!;
      const n = header.readUInt32LE(0);
      if (n > MAX_FRAME) throw new Error('frame too large: ' + n);
      if (total < 4 + n) break;
      take(4);
      out.push(take(n).toString('utf8'));
    }
    return out;
  };
}
