import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scaffoldMission } from '../src/launch/scaffold.js';

function tmpBase(): string {
  return mkdtempSync(path.join(tmpdir(), 'arma-mcp-scaffold-'));
}

test('scaffolds mission dir with three files on the given world', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'VR', name: 't', targetDir: base });
  assert.equal(path.basename(r.missionPath), 't.VR');
  assert.ok(existsSync(path.join(r.missionPath, 'mission.sqm')));
  assert.ok(existsSync(path.join(r.missionPath, 'description.ext')));
  assert.ok(existsSync(path.join(r.missionPath, 'init.sqf')));
  assert.deepEqual(r.files.sort(), ['description.ext', 'init.sqf', 'mission.sqm']);
});

test('mission.sqm carries sourceName, player type, position', () => {
  const base = tmpBase();
  const r = scaffoldMission({
    world: 'Altis',
    name: 'demo',
    playerType: 'B_Soldier_TL_F',
    // 입력은 SQF getPos 순서 [동, 북, 높이] 다. sqm 은 [동, 고도, 북] 로 바뀐다.
    position: [1000, 2000, 5],
    targetDir: base,
  });
  const sqm = readFileSync(path.join(r.missionPath, 'mission.sqm'), 'utf8');
  assert.match(sqm, /sourceName="demo"/);
  assert.match(sqm, /type="B_Soldier_TL_F"/);
  assert.match(sqm, /position\[\]=\{1000,5,2000\}/);
  assert.match(sqm, /isPlayer=1/);
  assert.match(sqm, /isPlayable=1/);
  const description = readFileSync(path.join(r.missionPath, 'description.ext'), 'utf8');
  assert.match(description, /respawn = 2;/);
  assert.match(description, /respawnDelay = 3;/);
  assert.match(description, /respawnOnStart = -1;/);
});

test('world is arbitrary (folder extension), VR is only a default', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'Enoch', name: 'x', targetDir: base });
  assert.equal(path.basename(r.missionPath), 'x.Enoch');
  const rDefault = scaffoldMission({ name: 'y', targetDir: base });
  assert.equal(rDefault.world, 'VR'); // 기본값일 뿐
});

test('init.sqf uses provided SQF, else a neutral marker (no AHC branding)', () => {
  const base = tmpBase();
  // safeSpawn='off' 만이 사용자 코드와 바이트 동일을 보장한다.
  const r = scaffoldMission({
    name: 'a',
    initSqf: 'player setDamage 0;',
    safeSpawn: 'off',
    targetDir: base,
  });
  assert.equal(readFileSync(path.join(r.missionPath, 'init.sqf'), 'utf8'), 'player setDamage 0;');

  const r2 = scaffoldMission({ name: 'b', targetDir: base });
  const init2 = readFileSync(path.join(r2.missionPath, 'init.sqf'), 'utf8');
  assert.match(init2, /arma-mcp/);
  assert.doesNotMatch(init2, /AHC/);
});

test('scaffolded content carries no AHC branding', () => {
  const base = tmpBase();
  const r = scaffoldMission({ name: 'c', targetDir: base });
  const sqm = readFileSync(path.join(r.missionPath, 'mission.sqm'), 'utf8');
  const desc = readFileSync(path.join(r.missionPath, 'description.ext'), 'utf8');
  const init = readFileSync(path.join(r.missionPath, 'init.sqf'), 'utf8');
  assert.doesNotMatch(sqm, /AHC/);
  assert.doesNotMatch(desc, /AHC/);
  assert.doesNotMatch(init, /AHC/);
  // 프렐류드는 애드온 함수를 부르지 않는다. 생성 미션은 바닐라에서 자립해야 한다.
  assert.doesNotMatch(init, /AHC_ArmaMCP_fnc_/);
});

test('name is sanitized to a safe folder name', () => {
  const base = tmpBase();
  const r = scaffoldMission({ name: 'my test/scene!', world: 'VR', targetDir: base });
  // 공백·구분자·특수문자는 언더스코어로.
  assert.match(path.basename(r.missionPath), /^my_test_scene_?\.VR$/);
});

test('overwrite=false throws when the dir already exists', () => {
  const base = tmpBase();
  scaffoldMission({ name: 'dup', world: 'VR', targetDir: base });
  assert.throws(
    () => scaffoldMission({ name: 'dup', world: 'VR', targetDir: base, overwrite: false }),
    /already exists/,
  );
});

// --- 좌표 순서: position 은 SQF getPos 순서 [동, 북, 높이] 다 ---

function sqmOf(r: { missionPath: string }): string {
  return readFileSync(path.join(r.missionPath, 'mission.sqm'), 'utf8');
}

function initOf(r: { missionPath: string }): string {
  return readFileSync(path.join(r.missionPath, 'init.sqf'), 'utf8');
}

test('position [east, north, height] is written to sqm as [east, height, north]', () => {
  const base = tmpBase();
  const r = scaffoldMission({
    world: 'Altis',
    name: 'order',
    position: [3000, 4000, 0],
    targetDir: base,
  });
  // 옛 규약으로 읽으면 고도 4000m 였다. 이것이 공중 스폰의 직접 원인이었다.
  assert.match(sqmOf(r), /position\[\]=\{3000,0,4000\}/);
  assert.deepEqual(r.position.requested, [3000, 4000, 0]);
  assert.deepEqual(r.position.sqm, [3000, 0, 4000]);
});

test('position accepts two elements and defaults the height to ground', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'Altis', name: 'two', position: [3000, 4000], targetDir: base });
  assert.match(sqmOf(r), /position\[\]=\{3000,0,4000\}/);
  assert.deepEqual(r.position.requested, [3000, 4000, 0]);
});

test('an explicit height lands in the middle sqm slot', () => {
  const base = tmpBase();
  const r = scaffoldMission({
    world: 'Altis',
    name: 'high',
    position: [3000, 4000, 120],
    targetDir: base,
  });
  assert.match(sqmOf(r), /position\[\]=\{3000,120,4000\}/);
});

test('sqm coordinates are printed as fixed decimals', () => {
  const base = tmpBase();
  const r = scaffoldMission({
    world: 'Altis',
    name: 'float',
    position: [0.1 + 0.2, 1, 0],
    targetDir: base,
  });
  const sqm = sqmOf(r);
  assert.match(sqm, /position\[\]=\{0\.3,0,1\}/);
  assert.doesNotMatch(sqm, /0\.30000000000000004/);
});

// --- 프렐류드 생성 ---

test('safeSpawn defaults to land and injects the correction prelude', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'Altis', name: 'pre', targetDir: base });
  assert.equal(r.safeSpawn, 'land');
  assert.equal(r.files.length, 3);
  const init = initOf(r);
  assert.match(init, /\[arma-mcp\]\[safeSpawn\]/);
  assert.match(init, /hasInterface/);
  assert.match(init, /isServer/);
  assert.match(init, /surfaceIsWater/);
  assert.match(init, /getTerrainHeightASL/);
  assert.match(init, /worldSize/);
});

test('safeSpawn=off leaves init.sqf byte-identical when no user code is given', () => {
  const base = tmpBase();
  const r = scaffoldMission({ name: 'nopre', safeSpawn: 'off', targetDir: base });
  assert.equal(initOf(r), 'diag_log "arma-mcp: scaffold init";\n');
});

test('safeSpawn=ground corrects only vertically (no horizontal search)', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'Altis', name: 'gnd', safeSpawn: 'ground', targetDir: base });
  const init = initOf(r);
  assert.match(init, /private _mode = "ground";/);
  assert.doesNotMatch(init, /BIS_fnc_findSafePos/);
});

test('safeSpawn=land searches for land', () => {
  const base = tmpBase();
  const r = scaffoldMission({ world: 'Altis', name: 'lnd', safeSpawn: 'land', targetDir: base });
  const init = initOf(r);
  assert.match(init, /private _mode = "land";/);
  assert.match(init, /BIS_fnc_findSafePos/);
});

test('the prelude comes first and keeps user preprocessor directives at column 0', () => {
  const base = tmpBase();
  const user = '#define FOO 1\nplayer setDamage 0;';
  const r = scaffoldMission({ world: 'Altis', name: 'ord2', initSqf: user, targetDir: base });
  const init = initOf(r);
  assert.ok(init.includes(user));
  assert.ok(init.indexOf('[arma-mcp][safeSpawn]') < init.indexOf('#define FOO 1'));
  assert.match(init, /\n#define FOO 1/);
});

test('the requested position seeds the runtime land search', () => {
  const base = tmpBase();
  const withPos = scaffoldMission({
    world: 'Altis',
    name: 'seed',
    position: [3000, 4000],
    targetDir: base,
  });
  assert.match(initOf(withPos), /private _want = \[3000,4000\];/);

  const withoutPos = scaffoldMission({ world: 'Altis', name: 'noseed', targetDir: base });
  assert.match(initOf(withoutPos), /private _want = \[\];/);
});

// --- 정적 가드 ---

test('impossible coordinates are rejected outright', () => {
  const base = tmpBase();
  assert.throws(() => scaffoldMission({ name: 'e1', position: [-1, 100], targetDir: base }), /음수/);
  assert.throws(() => scaffoldMission({ name: 'e2', position: [100, -1], targetDir: base }), /음수/);
  assert.throws(
    () => scaffoldMission({ name: 'e3', position: [Number.NaN, 100], targetDir: base }),
    /유한한 수/,
  );
  assert.throws(
    () => scaffoldMission({ name: 'e4', position: [60000, 100], targetDir: base }),
    /51200/,
  );
  assert.throws(
    () => scaffoldMission({ name: 'e5', position: [100, 60000], targetDir: base }),
    /51200/,
  );
});

test('a rejected position leaves no staging directory behind', () => {
  const base = tmpBase();
  assert.throws(() => scaffoldMission({ name: 'clean', position: [-1, 0], targetDir: base }));
  assert.deepEqual(readdirSync(base), []);
});

test('suspicious input is warned about, not silently rewritten', () => {
  const base = tmpBase();
  // 옛 sqm 순서([동, 고도, 북])로 부른 호출의 지문이다.
  const old = scaffoldMission({
    world: 'Altis',
    name: 'w1',
    position: [3000, 500, 4000],
    targetDir: base,
  });
  assert.match(sqmOf(old), /position\[\]=\{3000,4000,500\}/);
  assert.ok(old.warnings.some((w) => w.includes('[동, 북, 높이]')));

  const negative = scaffoldMission({
    world: 'Altis',
    name: 'w2',
    position: [3000, 4000, -5],
    targetDir: base,
  });
  assert.match(sqmOf(negative), /position\[\]=\{3000,0,4000\}/);
  assert.ok(negative.warnings.some((w) => w.includes('음수')));

  const grounded = scaffoldMission({
    world: 'Altis',
    name: 'w3',
    position: [3000, 4000, 4000],
    targetDir: base,
  });
  assert.ok(grounded.warnings.some((w) => w.includes('지면으로 내려간다')));
});

test('the map corner warns on real terrain but not on VR', () => {
  const base = tmpBase();
  const altis = scaffoldMission({ world: 'Altis', name: 'c1', position: [0, 0], targetDir: base });
  assert.ok(altis.warnings.some((w) => w.includes('남서쪽 모서리')));

  const vr = scaffoldMission({ world: 'VR', name: 'c2', position: [0, 0], targetDir: base });
  assert.deepEqual(vr.warnings, []);
});

test('safeSpawn=off says plainly that nothing will be corrected', () => {
  const base = tmpBase();
  const r = scaffoldMission({
    world: 'Altis',
    name: 'off1',
    position: [0, 0],
    safeSpawn: 'off',
    targetDir: base,
  });
  assert.ok(r.warnings.some((w) => w.includes('자동 보정이 없다')));
});
