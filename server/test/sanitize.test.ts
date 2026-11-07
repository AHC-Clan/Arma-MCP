import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSqf, CommentRejectedError } from '../src/exec/sanitize.js';

test('strips line comment', () => {
  const r = sanitizeSqf('systemChat "hi"; // greet\n1+1');
  assert.equal(r.changed, true);
  assert.match(r.code, /systemChat "hi";/);
  assert.doesNotMatch(r.code, /greet/);
});

test('strips block comment, preserves token boundary', () => {
  const r = sanitizeSqf('a/*x*/b');
  assert.equal(r.code, 'a b');
  assert.equal(r.removedComments, 1);
});

test('preserves // inside double-quoted string (URL)', () => {
  const src = 'private _u = "http://example.com/x";';
  const r = sanitizeSqf(src);
  assert.equal(r.changed, false);
  assert.equal(r.code, src);
});

test('preserves // inside single-quoted string', () => {
  const src = "hint '// not a comment';";
  const r = sanitizeSqf(src);
  assert.equal(r.changed, false);
  assert.equal(r.code, src);
});

test('handles doubled-quote escape in double string', () => {
  const src = 'systemChat "he said ""hi"" now"; // c';
  const r = sanitizeSqf(src);
  assert.match(r.code, /"he said ""hi"" now"/);
  assert.doesNotMatch(r.code, /\/\/ c/);
});

test('handles doubled single-quote escape', () => {
  const src = "x = 'it''s here'; // c";
  const r = sanitizeSqf(src);
  assert.match(r.code, /'it''s here'/);
  assert.doesNotMatch(r.code, /\/\/ c/);
});

test('block comment spanning multiple lines', () => {
  const src = 'a = 1;\n/* multi\n line\n comment */\nb = 2;';
  const r = sanitizeSqf(src);
  assert.doesNotMatch(r.code, /multi/);
  assert.match(r.code, /a = 1;/);
  assert.match(r.code, /b = 2;/);
});

test('line comment keeps newline (line numbers preserved)', () => {
  const src = '// c1\n// c2\n1';
  const r = sanitizeSqf(src);
  // 두 개행 유지 → 코드 "1" 은 3번째 줄.
  assert.equal(r.code.split('\n').length, 3);
});

test('reject mode throws on line comment with position', () => {
  try {
    sanitizeSqf('1+1 // x', 'reject');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof CommentRejectedError);
    assert.equal(e.line, 1);
  }
});

test('reject mode does not throw when comment is inside string', () => {
  const r = sanitizeSqf('"a//b"', 'reject');
  assert.equal(r.changed, false);
});

test('no comments = unchanged', () => {
  const src = 'private _x = 5; _x + count allUnits';
  const r = sanitizeSqf(src);
  assert.equal(r.changed, false);
  assert.equal(r.code, src);
});
