import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, makeDecoder, MAX_FRAME } from '../src/ipc/frame.js';

test('roundtrip: encode then decode single frame', () => {
  const decode = makeDecoder();
  const out = decode(encode('{"v":1,"type":"hello"}'));
  assert.deepEqual(out, ['{"v":1,"type":"hello"}']);
});

test('multiple frames in one chunk', () => {
  const decode = makeDecoder();
  const buf = Buffer.concat([encode('a'), encode('bb'), encode('ccc')]);
  assert.deepEqual(decode(buf), ['a', 'bb', 'ccc']);
});

test('byte-at-a-time fragmentation reassembles', () => {
  const decode = makeDecoder();
  const buf = encode('{"hello":"world"}');
  const collected: string[] = [];
  for (const byte of buf) {
    collected.push(...decode(Buffer.from([byte])));
  }
  assert.deepEqual(collected, ['{"hello":"world"}']);
});

test('frame split across two chunks at arbitrary boundary', () => {
  const decode = makeDecoder();
  const buf = encode('abcdefgh');
  const first = buf.subarray(0, 6);
  const second = buf.subarray(6);
  assert.deepEqual(decode(first), []);
  assert.deepEqual(decode(second), ['abcdefgh']);
});

test('UTF-8 / 한국어 passthrough', () => {
  const decode = makeDecoder();
  const s = '{"name":"홍길동","emoji":"🎯"}';
  assert.deepEqual(decode(encode(s)), [s]);
});

test('oversize length prefix throws', () => {
  const decode = makeDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME + 1, 0);
  assert.throws(() => decode(header), /frame too large/);
});

test('empty payload frame', () => {
  const decode = makeDecoder();
  assert.deepEqual(decode(encode('')), ['']);
});
