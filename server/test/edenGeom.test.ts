// edenGeom.test.ts: Eden 툴의 배치 판정과 관계 풀기(게임 불필요).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  axes,
  bearing,
  besidePos,
  cameraFor,
  findOverlaps,
  frameOf,
  groundVerdict,
  overlap2D,
  type EdenBox,
} from '../src/eden/edenGeom.js';
import { mapRow, solvePlacement } from '../src/eden/edenRuntime.js';

function box(over: Partial<EdenBox> = {}): EdenBox {
  return {
    id: 1,
    kind: 'object',
    class: 'Land_Box',
    name: '',
    layer: '',
    center: [0, 0, 0.5],
    dir: 0,
    half: [1, 1, 0.5],
    bottom: 0,
    gapMin: 0,
    gapMax: 0,
    tilt: 0,
    attrZ: 0,
    water: false,
    hasBox: true,
    ...over,
  };
}

const near = (a: number, b: number, eps = 1e-6): void => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('axes: 방위각 0 은 앞이 북쪽, 90 은 앞이 동쪽이고 오른쪽이 남쪽이다', () => {
  const n = axes(0);
  near(n.fwd[0], 0);
  near(n.fwd[1], 1);
  near(n.right[0], 1);
  const e = axes(90);
  near(e.fwd[0], 1);
  near(e.right[1], -1);
});

test('bearing: 북쪽에서 시계 방향 도', () => {
  assert.equal(bearing([0, 0], [1, 0]), 90);
  assert.equal(bearing([0, 0], [0, -1]), 180);
  assert.equal(bearing([5, 5], [4, 5]), 270);
});

test('groundVerdict: 가장 가까운 모서리 틈으로 판정하고 경사 벌어짐을 준다', () => {
  assert.deepEqual(groundVerdict(box({ gapMin: 0.02, gapMax: 0.03 })), { state: 'ground', gap: 0.02, spread: 0.01 });
  assert.equal(groundVerdict(box({ gapMin: 0.4, gapMax: 0.4 })).state, 'floating');
  const slope = groundVerdict(box({ gapMin: -0.3, gapMax: 0.1 }));
  assert.equal(slope.state, 'sunk');
  assert.equal(slope.spread, 0.4);
});

test('overlap2D: 축 정렬 상자는 겹친 폭, 떨어지면 0, 돌린 상자도 분리축으로 잰다', () => {
  near(overlap2D(box(), box({ id: 2, center: [1.5, 0, 0.5] })), 0.5);
  assert.equal(overlap2D(box(), box({ id: 2, center: [2.5, 0, 0.5] })), 0);
  // 45도 돌린 2x2 상자는 x 축으로 반폭이 √2 다. 중심 거리 2.3 이면 1 + √2 - 2.3 만큼 겹친다.
  near(overlap2D(box(), box({ id: 2, center: [2.3, 0, 0.5], dir: 45 })), 1 + Math.SQRT2 - 2.3, 1e-9);
});

test('findOverlaps: 위에 쌓은 상자는 겹침이 아니고, 맵 물체는 클래스로 알린다', () => {
  const base = box();
  const stacked = box({ id: 2, center: [0, 0, 1.5], bottom: 1 });
  assert.deepEqual(findOverlaps([base, stacked]), []);
  const tree = box({ id: 0, kind: 'map', class: 't_pinus.p3d', center: [1, 0, 0.5] });
  assert.deepEqual(findOverlaps([base], [tree]), [{ a: 1, b: 0, bClass: 't_pinus.p3d', depth: 1 }]);
  const marker = box({ id: 3, kind: 'marker', hasBox: false, center: [0, 0, 0] });
  assert.deepEqual(findOverlaps([base, marker]), []);
});

test('besidePos: ref 의 쪽에 상자끼리 맞닿게, ref 가 돌아 있으면 그 축으로', () => {
  const ref = box({ half: [1, 2, 1], center: [10, 20, 1] });
  assert.deepEqual(besidePos(ref, 'front', [0.5, 0.5, 0.5], 0), [10, 22.5]);
  assert.deepEqual(besidePos(ref, 'right', [0.5, 0.5, 0.5], 0, 1), [12.5, 20]);
  assert.deepEqual(besidePos(ref, 'left', [0.5, 0.5, 0.5], 0, 0, 1), [8.5, 21]);
  const east = box({ half: [1, 2, 1], center: [0, 0, 1], dir: 90 });
  assert.deepEqual(besidePos(east, 'front', [0.5, 0.5, 0.5], 90), [2.5, 0]);
});

test('frameOf 와 cameraFor: 위에서는 바로 아래를, 비스듬히는 중심을 보고 위쪽 벡터가 수직이다', () => {
  const f = frameOf([box(), box({ id: 2, center: [10, 0, 0.5] })]);
  assert.deepEqual(f.center, [5, 0, 0.5]);
  const top = cameraFor('top', f.center, f.radius);
  assert.deepEqual(top.vectorDir, [0, 0, -1]);
  assert.ok(top.pos[2] > f.center[2]);
  const iso = cameraFor('iso', [0, 0, 0], 5, 0);
  const dot = iso.vectorDir.reduce((s, v, i) => s + v * iso.vectorUp[i]!, 0);
  near(dot, 0, 1e-5);
  assert.ok(iso.vectorUp[2] > 0);
  const front = cameraFor('front', [0, 0, 0], 5, 0);
  assert.ok(front.pos[1] > 0, '앞(북쪽)에 선다');
  assert.ok(front.vectorDir[1] < 0, '남쪽을 본다');
  const floored = cameraFor('front', [0, 0, 0], 5, 0, 40, 30);
  assert.equal(floored.pos[2], 30);
});

test('mapRow: geom 문자열을 숫자로 되읽고 모양이 틀리면 null', () => {
  const m = mapRow([12, 'vehicle', 'B_MRAP_01_F', 'car1', 'Layer 1', '12345.67,2345.12,10.50,90.00,1.20,2.50,1.10,9.40,0.01,0.03,0.50,0.00', 6]);
  assert.ok(m);
  assert.deepEqual(m.box.center, [12345.67, 2345.12, 10.5]);
  assert.equal(m.box.hasBox, true);
  assert.equal(m.flags.selected, true);
  assert.equal(mapRow([12, 'vehicle', 'X', '', '', '1,2,3', 0]), null);
  assert.equal(mapRow([12, 'tank', 'X', '', '', '0,0,0,0,0,0,0,0,0,0,0,0', 0]), null);
});

test('solvePlacement: at, on, beside, face, ground 규칙', () => {
  const ref = box({ id: 7, center: [100, 100, 1], half: [1, 2, 1], dir: 0 });
  const refs = new Map([[7, ref]]);
  const h = [0.5, 0.5, 0.5];

  assert.deepEqual(solvePlacement({ at: [1, 2] }, refs, h), { ok: true, pos: [1, 2], dir: null, z: { kind: 'ground' }, how: 'at' });
  const at3 = solvePlacement({ at: [1, 2, 33] }, refs, h);
  assert.ok(at3.ok && at3.z.kind === 'asl' && at3.z.z === 33);

  const on = solvePlacement({ on: 7, offset: [0, 1] }, refs, h);
  assert.ok(on.ok);
  assert.deepEqual(on.pos, [100, 101]);
  assert.deepEqual(on.z, { kind: 'on', ref: 7 });

  // beside 는 방향을 주지 않으면 ref 방향을 따른다.
  const bes = solvePlacement({ beside: { id: 7, side: 'front', gap: 1 } }, refs, h);
  assert.ok(bes.ok);
  assert.deepEqual(bes.pos, [100, 103.5]);
  assert.equal(bes.dir, 0);

  const faced = solvePlacement({ at: [0, 0], face: 7 }, refs, h);
  assert.ok(faced.ok);
  assert.equal(faced.dir, 45);

  const keep = solvePlacement({ at: [0, 0], ground: false }, refs, h);
  assert.ok(keep.ok && keep.z.kind === 'keep');

  const both = solvePlacement({ at: [0, 0], on: 7 }, refs, h);
  assert.equal(both.ok, false);
  const missing = solvePlacement({ on: 99 }, refs, h);
  assert.ok(!missing.ok && /99/.test(missing.error));
});

test('solvePlacement: edit 의 by 와 turn 은 지금 자리와 방향에서 센다', () => {
  const self = box({ id: 3, center: [10, 10, 1], dir: 350, bottom: 0.5 });
  const s = solvePlacement({ by: [1, -1, 2], turn: 20 }, new Map(), self.half, self);
  assert.ok(s.ok);
  assert.deepEqual(s.pos, [11, 9]);
  assert.equal(s.dir, 10);
  assert.deepEqual(s.z, { kind: 'asl', z: 2.5 });
  const only = solvePlacement({ dir: 90 }, new Map(), self.half, self);
  assert.ok(only.ok && only.pos === null && only.z.kind === 'keep');
  const drop = solvePlacement({ ground: true }, new Map(), self.half, self);
  assert.ok(drop.ok && drop.z.kind === 'ground');
});
