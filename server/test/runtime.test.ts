import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveExpectedMachines } from '../src/runtime.js';

test('deriveExpectedMachines: dedicated = 1 + players + hc', () => {
  assert.equal(deriveExpectedMachines({ dedicated: true, playerCount: 2, hcCount: 0 }, 100), 3);
  assert.equal(deriveExpectedMachines({ dedicated: true, playerCount: 2, hcCount: 1 }, 100), 4);
  assert.equal(deriveExpectedMachines({ dedicated: true, playerCount: 0, hcCount: 0 }, 100), 1);
});

test('deriveExpectedMachines: 리슨/SP = max(1, players + hc)', () => {
  // 에디터/접속 초기(플레이어 0)도 호스트 머신 1대는 응답한다.
  assert.equal(deriveExpectedMachines({ dedicated: false, playerCount: 0, hcCount: 0 }, 100), 1);
  assert.equal(deriveExpectedMachines({ dedicated: false, playerCount: 1, hcCount: 0 }, 100), 1);
  // 리슨 호스트는 본인이 playerCount 에 포함 — 호스트+클라 2명이면 3.
  assert.equal(deriveExpectedMachines({ dedicated: false, playerCount: 3, hcCount: 0 }, 100), 3);
  assert.equal(deriveExpectedMachines({ dedicated: false, playerCount: 2, hcCount: 1 }, 100), 3);
});

test('deriveExpectedMachines: 캐시 없음/스테일이면 null (quiet 폴백)', () => {
  assert.equal(deriveExpectedMachines({ dedicated: true, playerCount: 2, hcCount: 0 }, -1), null);
  assert.equal(deriveExpectedMachines({ dedicated: true, playerCount: 2, hcCount: 0 }, 10000), null);
  assert.equal(deriveExpectedMachines({ dedicated: false, playerCount: 2, hcCount: 0 }, 99999), null);
});
