import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSqfValue, tryParseSqfValue } from '../src/zeus/sqfValue.js';

test('sqfValue: str 로 찍힌 중첩 배열, 문자열, 숫자, 불리언을 읽는다', () => {
  assert.deepEqual(parseSqfValue('[3,2,[["unit","2:345","소총수",true]],["Korean",false,true]]'), [
    3,
    2,
    [['unit', '2:345', '소총수', true]],
    ['Korean', false, true],
  ]);
  assert.deepEqual(parseSqfValue('[]'), []);
  assert.deepEqual(parseSqfValue(' [ 1 , [ ] ] '), [1, []]);
});

test('sqfValue: "" 이스케이프와 한국어와 기호를 그대로 둔다', () => {
  assert.equal(parseSqfValue('"say ""hi"""'), 'say "hi"');
  assert.deepEqual(parseSqfValue('["알파 1-1","a|b, c]"]'), ['알파 1-1', 'a|b, c]']);
});

test('sqfValue: 음수, 소수, 지수 표기', () => {
  assert.deepEqual(parseSqfValue('[-1,0.5,1.23457e+006,-2.5e-003,.5]'), [-1, 0.5, 1234570, -0.0025, 0.5]);
});

test('sqfValue: any 와 <null> 은 null, 객체 str 같은 맨 낱말은 거부한다', () => {
  assert.deepEqual(parseSqfValue('[any,<null>]'), [null, null]);
  assert.throws(() => parseSqfValue('[B Alpha 1-1:1]'));
  assert.throws(() => parseSqfValue('["open'));
  assert.throws(() => parseSqfValue('[1,2'));
  assert.throws(() => parseSqfValue('[1] trailing'));
  assert.equal(tryParseSqfValue('[1,'), null);
  assert.equal(tryParseSqfValue(undefined), null);
});
