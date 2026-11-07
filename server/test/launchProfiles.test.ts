// launchProfiles.test.ts — arma_play 실행 프로필의 저장, 병합, 파일 처리 (게임 불필요).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import {
  findProfile,
  isProfileName,
  listProfileNames,
  loadLaunchProfiles,
  mergeProfile,
  profileFromPlay,
  resolveLaunchProfilesFile,
  saveLaunchProfile,
  stripSelfMod,
  unknownProfileError,
  type LaunchProfile,
} from '../src/launch/launchProfiles.js';
import type { PlayResult } from '../src/launch/playOrchestrator.js';
import type { LaunchResult } from '../src/launch/launcher.js';
import type { MpLaunchResult } from '../src/launch/mpLauncher.js';

const SELF_MOD = 'D:\\mods\\@arma_mcp';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'arma-mcp-profiles-'));
}

function config(over: Record<string, unknown> = {}): Config {
  const dir = tmpDir();
  const file = path.join(dir, 'cfg.json');
  writeFileSync(
    file,
    JSON.stringify({
      arma: {
        selfModPath: SELF_MOD,
        missionsDir: path.join(dir, 'missions'),
        profilesFile: path.join(dir, 'launch-profiles.json'),
        ...over,
      },
    }),
    'utf8',
  );
  return loadConfig(file);
}

function spLaunch(over: Partial<LaunchResult> = {}): LaunchResult {
  return {
    ok: true,
    launched: true,
    dryRun: false,
    modSource: 'rpt (Arma3_x64_old.rpt)',
    modCount: 3,
    mods: ['D:\\mods\\@cba', 'D:\\mods\\@ace', SELF_MOD],
    argString: '',
    prevNewestRpt: '(none)',
    ...over,
  };
}

function givenResult(missionRef: string, over: Partial<PlayResult> = {}): PlayResult {
  return {
    ok: true,
    mode: 'sp',
    dryRun: false,
    phase: 'in-game',
    steps: [],
    mission: { origin: 'given', ref: missionRef, template: path.basename(missionRef), world: 'VR' },
    launch: spLaunch(),
    warnings: [],
    totalMs: 1,
    ...over,
  };
}

function profile(over: Partial<LaunchProfile> = {}): LaunchProfile {
  return { mode: 'sp', savedAt: '2026-09-23T00:00:00.000Z', ...over };
}

// --- 파일 위치 ---

test('profilesFile 이 비면 홈의 .arma-mcp/launch-profiles.json 을 쓴다', () => {
  const cfg = config({ profilesFile: '' });
  assert.match(resolveLaunchProfilesFile(cfg), /[\\/]\.arma-mcp[\\/]launch-profiles\.json$/);
  const custom = config();
  assert.equal(resolveLaunchProfilesFile(custom), custom.arma.profilesFile);
});

test('설정 기본값에 profilesFile 이 빈 문자열로 들어 있다', () => {
  const cfg = loadConfig(path.join(tmpdir(), 'does-not-exist-profiles.json'));
  assert.equal(cfg.arma.profilesFile, '');
});

// --- 읽기 ---

test('파일이 없으면 빈 목록이다', async () => {
  const file = path.join(tmpDir(), 'none.json');
  assert.deepEqual(await loadLaunchProfiles(file), { v: 1, profiles: {} });
  assert.deepEqual(await listProfileNames(file), []);
});

test('깨진 파일은 파일 경로를 담은 오류다', async () => {
  const file = path.join(tmpDir(), 'broken.json');
  writeFileSync(file, '{ not json', 'utf8');
  await assert.rejects(loadLaunchProfiles(file), (e: Error) => {
    assert.ok(e.message.includes(file));
    assert.match(e.message, /깨졌다/);
    return true;
  });
});

test('형식이 틀린 파일도 파일 경로를 담은 오류다', async () => {
  const file = path.join(tmpDir(), 'shape.json');
  writeFileSync(file, JSON.stringify({ v: 2, profiles: {} }), 'utf8');
  await assert.rejects(loadLaunchProfiles(file), (e: Error) => {
    assert.ok(e.message.includes(file));
    assert.match(e.message, /형식/);
    return true;
  });
});

test('깨진 파일에는 저장하지 않고 원래 내용을 남긴다', async () => {
  const file = path.join(tmpDir(), 'keep.json');
  writeFileSync(file, '{ broken', 'utf8');
  await assert.rejects(saveLaunchProfile(file, 'wc', profile()));
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});

test('BOM 이 붙은 파일도 읽는다', async () => {
  const file = path.join(tmpDir(), 'bom.json');
  writeFileSync(
    file,
    '\uFEFF' + JSON.stringify({ v: 1, profiles: { wc: profile() } }),
    'utf8',
  );
  assert.deepEqual(await listProfileNames(file), ['wc']);
});

test('상속된 속성 이름은 프로필이 아니다', async () => {
  const file = path.join(tmpDir(), 'proto.json');
  await saveLaunchProfile(file, 'wc', profile());
  const data = await loadLaunchProfiles(file);
  assert.ok(findProfile(data, 'wc'));
  assert.equal(findProfile(data, 'constructor'), undefined);
  assert.equal(findProfile(data, 'toString'), undefined);
});

// --- 이름 ---

test('프로필 이름은 영문, 숫자, 밑줄, 하이픈으로 1~40자다', async () => {
  assert.equal(isProfileName('wc_mp-2'), true);
  assert.equal(isProfileName('a'.repeat(40)), true);
  assert.equal(isProfileName('a'.repeat(41)), false);
  assert.equal(isProfileName(''), false);
  assert.equal(isProfileName('has space'), false);
  assert.equal(isProfileName('../evil'), false);
  assert.equal(isProfileName('__proto__'), false);

  const file = path.join(tmpDir(), 'names.json');
  await assert.rejects(saveLaunchProfile(file, 'bad name', profile()), /프로필 이름/);
  await assert.rejects(saveLaunchProfile(file, '__proto__', profile()), /프로필 이름/);
  assert.deepEqual(await listProfileNames(file), []);
});

test('모르는 이름의 오류는 있는 이름을 알려 준다', () => {
  assert.match(unknownProfileError('x', ['wc', 'mp']), /있는 프로필: mp, wc/);
  assert.match(unknownProfileError('x', []), /하나도 없다/);
});

// --- 저장 ---

test('저장은 임시 파일을 거쳐 원자적으로 바꾸고 임시 파일을 남기지 않는다', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'nested', 'launch-profiles.json');
  await saveLaunchProfile(file, 'one', profile());
  await saveLaunchProfile(file, 'two', profile({ mode: 'mp' }));
  assert.deepEqual(readdirSync(path.dirname(file)), ['launch-profiles.json']);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(data.v, 1);
  assert.deepEqual(Object.keys(data.profiles).sort(), ['one', 'two']);
});

test('rename 이 실패하면 원래 파일이 그대로이고 임시 파일도 지운다', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'launch-profiles.json');
  await saveLaunchProfile(file, 'one', profile());
  const before = readFileSync(file, 'utf8');
  const seen: string[] = [];
  await assert.rejects(
    saveLaunchProfile(file, 'two', profile(), {
      rename: async (from) => {
        seen.push(from);
        // 임시 파일에는 새 내용이 다 쓰여 있다.
        assert.match(readFileSync(from, 'utf8'), /"two"/);
        throw new Error('disk full');
      },
    }),
    /disk full/,
  );
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.startsWith(file + '.'));
  assert.deepEqual(readdirSync(dir), ['launch-profiles.json']);
});

test('저장은 모르는 필드를 버린다(killRunning, password, then)', async () => {
  const file = path.join(tmpDir(), 'strip.json');
  const dirty = {
    ...profile({ mission: 'C:\\m\\demo.VR' }),
    killRunning: true,
    password: 'secret',
    then: { code: 'hint "x"' },
  } as unknown as LaunchProfile;
  await saveLaunchProfile(file, 'wc', dirty);
  const text = readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /killRunning|password|secret|then/);
  assert.equal((await loadLaunchProfiles(file)).profiles.wc!.mission, 'C:\\m\\demo.VR');
});

// --- 성공한 실행에서 프로필 만들기 ---

test('주어진 미션은 절대경로와 해석된 모드로 저장하고 selfModPath 는 뺀다', () => {
  const cfg = config();
  const missionRef = path.join(cfg.arma.missionsDir, 'demo.VR');
  const p = profileFromPlay(
    cfg,
    {
      mission: missionRef,
      modset: 'rpt',
      clientExtraArgs: ['-showScriptErrors'],
      ready: { rpt: 'MYMOD ready', timeoutMs: 30000 },
    },
    givenResult(missionRef),
    new Date('2026-09-23T01:02:03.000Z'),
  );
  assert.deepEqual(p, {
    mode: 'sp',
    savedAt: '2026-09-23T01:02:03.000Z',
    mission: path.resolve(missionRef),
    mods: ['D:\\mods\\@cba', 'D:\\mods\\@ace'],
    clientExtraArgs: ['-showScriptErrors'],
    ready: { rpt: 'MYMOD ready', timeoutMs: 30000 },
  });
});

test('missionsDir 하위 이름으로 준 미션도 절대경로로 저장한다', () => {
  const cfg = config();
  const p = profileFromPlay(cfg, { mission: 'demo.VR' }, givenResult('demo.VR'));
  assert.equal(p.mission, path.resolve(cfg.arma.missionsDir, 'demo.VR'));
});

test('모드가 selfModPath 하나뿐이면 modset none 으로 저장한다', () => {
  const cfg = config();
  const p = profileFromPlay(
    cfg,
    { mission: 'C:\\m\\demo.VR' },
    givenResult('C:\\m\\demo.VR', { launch: spLaunch({ mods: [SELF_MOD + '\\'] }) }),
  );
  assert.equal(p.mods, undefined);
  assert.equal(p.modset, 'none');
});

test('즉석 생성 미션은 공유 폴더 경로 대신 스캐폴드 인자를 저장한다', () => {
  const cfg = config();
  const scaffolded: PlayResult = givenResult('C:\\shared\\mcp_play.Altis', {
    mission: {
      origin: 'scaffolded',
      ref: 'C:\\shared\\mcp_play.Altis',
      path: 'C:\\shared\\mcp_play.Altis',
      template: 'mcp_play.Altis',
      world: 'Altis',
      safeSpawn: 'land',
    },
  });
  const p = profileFromPlay(
    cfg,
    {
      world: 'altis',
      name: 'wc_test',
      playerType: 'B_Soldier_F',
      position: [1000, 2000],
      initSqf: 'player setDamage 0;',
    },
    scaffolded,
  );
  assert.equal(p.mission, undefined);
  assert.deepEqual(p.scaffold, {
    world: 'Altis',
    name: 'wc_test',
    playerType: 'B_Soldier_F',
    position: [1000, 2000],
    safeSpawn: 'land',
    initSqf: 'player setDamage 0;',
  });
});

test('mp 전용 값은 mp 프로필에만 저장하고 서버 경로의 미션을 쓴다', () => {
  const cfg = config();
  const mp = {
    ok: true,
    dryRun: false,
    mission: { source: 'C:\\resolved\\demo.VR', template: 'demo.VR', deployedPath: '' },
    modSource: 'explicit',
    modCount: 2,
    mods: ['D:\\mods\\@cba', SELF_MOD],
    server: {
      launched: true,
      exePath: '',
      port: 2402,
      argString: '',
      profilesDir: '',
      ready: true,
    },
    missionStarted: true,
    bridgeReady: true,
  } as MpLaunchResult;
  const opts = {
    mode: 'mp' as const,
    mission: 'demo.VR',
    serverExtraArgs: ['-loadMissionToMemory'],
    port: 2402,
    autoSlot: false,
    roles: ['Squad Leader', 2, null],
    password: 'secret',
    killRunning: true,
  };
  const p = profileFromPlay(
    cfg,
    opts,
    givenResult('demo.VR', { mode: 'mp', launch: mp }),
  );
  assert.equal(p.mode, 'mp');
  assert.equal(p.mission, path.resolve('C:\\resolved\\demo.VR'));
  assert.deepEqual(p.mods, ['D:\\mods\\@cba']);
  assert.deepEqual(p.serverExtraArgs, ['-loadMissionToMemory']);
  assert.equal(p.port, 2402);
  assert.equal(p.autoSlot, false);
  assert.deepEqual(p.roles, ['Squad Leader', 2, null]);
  assert.equal('password' in p, false);
  assert.equal('killRunning' in p, false);

  const sp = profileFromPlay(cfg, { ...opts, mode: 'sp' }, givenResult('C:\\m\\demo.VR'));
  assert.equal(sp.port, undefined);
  assert.equal(sp.serverExtraArgs, undefined);
  assert.equal(sp.autoSlot, undefined);
  assert.equal(sp.roles, undefined);
});

test('stripSelfMod 는 대소문자와 끝 구분자를 가리지 않는다', () => {
  const cfg = config();
  assert.deepEqual(stripSelfMod(cfg, ['d:\\MODS\\@arma_mcp\\', 'D:\\mods\\@cba']), [
    'D:\\mods\\@cba',
  ]);
});

// --- 병합 ---

test('명시 인자가 프로필보다, 프로필이 기본값보다 우선한다', () => {
  const p = profile({
    mode: 'mp',
    mission: 'C:\\m\\demo.VR',
    mods: ['D:\\mods\\@cba'],
    clientExtraArgs: ['-a'],
    serverExtraArgs: ['-b'],
    port: 2402,
    autoSlot: false,
    roles: ['Medic'],
    ready: { rpt: 'ready' },
  });
  const merged = mergeProfile({ port: 2502, dryRun: true }, p);
  assert.equal(merged.mode, 'mp');
  assert.equal(merged.mission, 'C:\\m\\demo.VR');
  assert.equal(merged.modset, 'explicit');
  assert.deepEqual(merged.mods, ['D:\\mods\\@cba']);
  assert.deepEqual(merged.clientExtraArgs, ['-a']);
  assert.deepEqual(merged.serverExtraArgs, ['-b']);
  assert.equal(merged.port, 2502);
  assert.equal(merged.autoSlot, false);
  assert.deepEqual(merged.roles, ['Medic']);
  assert.deepEqual(mergeProfile({ roles: [1] }, p).roles, [1]);
  assert.deepEqual(merged.ready, { rpt: 'ready' });
  assert.equal(merged.dryRun, true);

  const explicit = mergeProfile({ mode: 'sp' as const, modset: 'rpt' as const }, p);
  assert.equal(explicit.mode, 'sp');
  assert.equal(explicit.modset, 'rpt');

  // 병합 결과가 프로필 배열을 공유하지 않는다.
  merged.mods!.push('x');
  assert.deepEqual(p.mods, ['D:\\mods\\@cba']);
});

test('호출이 mods 를 주면 modset 은 explicit 이다', () => {
  const merged = mergeProfile({ mods: ['D:\\mods\\@x'] }, profile({ modset: 'none' }));
  assert.equal(merged.modset, 'explicit');
  assert.deepEqual(merged.mods, ['D:\\mods\\@x']);
  assert.equal(mergeProfile({}, profile({ modset: 'none' })).modset, 'none');
});

test('스캐폴드 인자를 주면 프로필의 미션 경로를 쓰지 않는다', () => {
  const byPath = profile({ mission: 'C:\\m\\demo.VR' });
  const merged = mergeProfile({ world: 'Stratis' }, byPath);
  assert.equal(merged.mission, undefined);
  assert.equal(merged.world, 'Stratis');

  const byScaffold = profile({
    scaffold: { world: 'Altis', name: 'wc', position: [1, 2], safeSpawn: 'ground' },
  });
  const filled = mergeProfile({ name: 'mine' }, byScaffold);
  assert.equal(filled.world, 'Altis');
  assert.equal(filled.name, 'mine');
  assert.deepEqual(filled.position, [1, 2]);
  assert.equal(filled.safeSpawn, 'ground');

  const given = mergeProfile({ mission: 'C:\\other.VR' }, byScaffold);
  assert.equal(given.mission, 'C:\\other.VR');
  assert.equal(given.world, undefined);
});

test('mp 프로필을 sp 로 부르면 mp 전용 값은 얹지 않는다', () => {
  const p = profile({
    mode: 'mp',
    mission: 'C:\m\demo.VR',
    serverExtraArgs: ['-b'],
    port: 2402,
    autoSlot: false,
    clientExtraArgs: ['-a'],
  });
  const merged = mergeProfile({ mode: 'sp' as const }, p);
  assert.equal(merged.port, undefined);
  assert.equal(merged.serverExtraArgs, undefined);
  assert.equal(merged.autoSlot, undefined);
  assert.deepEqual(merged.clientExtraArgs, ['-a']);
  assert.equal(merged.mission, 'C:\m\demo.VR');
});

test('서버 RPT 를 보는 프로필 ready 는 sp 로 부르면 얹지 않는다', () => {
  const serverReady = profile({ mode: 'mp', ready: { rpt: 'srv ready', source: 'server' } });
  assert.equal(mergeProfile({ mode: 'sp' as const }, serverReady).ready, undefined);
  assert.deepEqual(mergeProfile({}, serverReady).ready, { rpt: 'srv ready', source: 'server' });

  // 클라 RPT 를 보는 ready 는 sp 에서도 그대로 쓴다.
  const clientReady = profile({ mode: 'mp', ready: { rpt: 'cl ready' } });
  assert.deepEqual(mergeProfile({ mode: 'sp' as const }, clientReady).ready, { rpt: 'cl ready' });
});
