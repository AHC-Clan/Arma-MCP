// stackLaunch.test.ts — 이름 있는 스택의 실행 인자, 미션 배치, 브리지 확인, 모드셋 정리.
//
// dryRun 과 순수 함수만 본다. 실제 게임은 docs/testing.md 의 다중 스택 시나리오가 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import {
  MpLauncher,
  waitClientInTelemetry,
  type MpLauncherBridgeDeps,
} from '../src/launch/mpLauncher.js';
import type { MissionSnapshot } from '../src/game/telemetry.js';
import { Launcher } from '../src/launch/launcher.js';
import {
  MIN_FITTED_WINDOW_WIDTH,
  WINDOW_FRAME,
  clientArmaCfgPath,
  clientStackArgs,
  clientWindowPositions,
  fitClientWindowSize,
  prepareClientProfile,
  stackOwnedIn,
  stripStackOwned,
  windowPositionArgs,
  withNoPause,
  withWindowSize,
  type LaunchStackOptions,
  type ScreenArea,
  type WindowPosition,
} from '../src/launch/stackArgs.js';
import { parseWorkArea } from '../src/launch/screenArea.js';
import { resolveModset, stripStackMods } from '../src/launch/mods.js';
import { deployMissionToMpMissions } from '../src/launch/serverCfg.js';
import { defaultStackContext, namedStackContext, stackCfg } from '../src/stack/stackContext.js';
import { stackBridgeProblem, versionInDll } from '../src/stack/bridgeGate.js';
import type { PlayResult } from '../src/launch/playOrchestrator.js';
import { scaffoldMission } from '../src/launch/scaffold.js';
import { mergeProfile, profileFromPlay } from '../src/launch/launchProfiles.js';

/** tiler 를 끄면 0.5.5 의 나란히 놓기를 본다. 기본은 설정 기본값(창 타일러 켬)이다. */
function setup(opts: { tiler?: boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-stacklaunch-'));
  const mission = path.join(base, 'missions', 'demo.VR');
  mkdirSync(mission, { recursive: true });
  writeFileSync(path.join(mission, 'mission.sqm'), 'sqm', 'utf8');
  const cfgPath = path.join(base, 'cfg.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      arma: {
        exePath: 'C:\\game\\arma3_x64.exe',
        baseArgs: ['-skipIntro', '-profiles=C:\\mine', '-name=Me', '-noSplash'],
        selfModPath: 'D:\\mods\\@arma_mcp',
      },
      mp: {
        port: 2402,
        profilesDir: path.join(base, 'profiles'),
        mpMissionsDir: path.join(base, 'MPMissions'),
        serverBaseArgs: ['-port=9999', '-loadMissionToMemory'],
      },
      stacks: { root: path.join(base, 'stacks') },
      ...(opts.tiler === false ? { windowTiler: { enabled: false } } : {}),
    }),
    'utf8',
  );
  const cfg = loadConfig(cfgPath, { quiet: true });
  const rptDir = path.join(base, 'rpt');
  mkdirSync(rptDir, { recursive: true });
  return { base, cfg, rptDir, mission };
}

/** 시험용 주 모니터 작업 영역. 1600x900 창이 가로 둘, 세로 둘 들어간다. */
const TEST_AREA: ScreenArea = { x: 0, y: 0, width: 3840, height: 2100 };

function stackOpts(cfg: Config, id: string, port: number, gate?: string): LaunchStackOptions {
  const ctx = id === 'default' ? defaultStackContext(cfg) : namedStackContext(cfg, id, port);
  return {
    ctx,
    modsetRptDir: path.join(cfg.stacks.root, '..', 'rpt'),
    stacksRoot: cfg.stacks.root,
    bridgeGate: async () => gate ?? null,
    workArea: async () => TEST_AREA,
  };
}

/** 인자 글에서 -noPause 개수. -noPauseAudio 는 세지 않는다. */
function noPauseCount(argString: string): number {
  return argString.match(/(?:^|\s)-noPause(?=\s|$)/gi)?.length ?? 0;
}

test('stackArgs: 스택이 정하는 인자를 빼고 찾는다', () => {
  assert.deepEqual(
    stripStackOwned(['-skipIntro', '-profiles=C:\\x', '"-name=Me"', '-PORT=1', '-config=a', '-window']),
    ['-skipIntro', '-window'],
  );
  assert.deepEqual(stackOwnedIn(['-noSound', '-profiles="C:\\y"']), ['-profiles="C:\\y"']);
  assert.deepEqual(stackOwnedIn(undefined), []);
});

test('clientStackArgs: default 클라 1 은 그대로, 그 밖은 profiles 와 이름과 창 모드', () => {
  const s = setup();
  assert.deepEqual(clientStackArgs(defaultStackContext(s.cfg), 1), []);
  const d2 = clientStackArgs(defaultStackContext(s.cfg), 2);
  assert.ok(d2.some((a) => a.startsWith('-profiles=') && a.includes(path.join('default', 'client2'))));
  assert.ok(d2.includes('-name=default_c2'));
  const b1 = clientStackArgs(namedStackContext(s.cfg, 'b', 2412), 1);
  assert.ok(b1.some((a) => a.includes(path.join('b', 'client1'))));
  assert.ok(b1.includes('-name=b_c1'));
  assert.ok(b1.includes('-window'));
});

test('withWindowSize: 창과 렌더 크기 줄만 바꾸고 없는 줄은 더한다', () => {
  const size = { width: 1600, height: 900 };
  const text = 'language="Korean";\r\ndisplayMode=2;\r\nwinWidth=1024;\r\nwinHeight=768;\r\nrenderWidth=2560;\r\n';
  const out = withWindowSize(text, size);
  assert.ok(out.startsWith('language="Korean";\r\ndisplayMode=2;\r\nwinWidth=1600;\r\nwinHeight=900;\r\nrenderWidth=1600;\r\n'));
  for (const line of ['winDefWidth=1600;', 'winDefHeight=900;', 'renderHeight=900;']) {
    assert.ok(out.includes(`\r\n${line}\r\n`), line);
  }
  assert.ok(!out.includes('\n\n') && !out.includes('\r\n\r\n'), '빈 줄을 만들지 않는다');
  assert.equal(withWindowSize(out, size), out, '두 번 적어도 같다');
  assert.equal(withWindowSize('', size).split('\n').length, 7);
});

test('withNoPause: 없으면 끝에 더하고, 대소문자나 따옴표가 달라도 있으면 겹치지 않는다', () => {
  assert.deepEqual(withNoPause(['-skipIntro']), ['-skipIntro', '-noPause']);
  assert.deepEqual(withNoPause(['-NOPAUSE', '-skipIntro']), ['-NOPAUSE', '-skipIntro']);
  assert.deepEqual(withNoPause(['"-noPause"']), ['"-noPause"']);
  assert.deepEqual(withNoPause(['-noPauseAudio']), ['-noPauseAudio', '-noPause'], '-noPauseAudio 는 다른 인자다');
  const args = ['-window'];
  withNoPause(args);
  assert.deepEqual(args, ['-window'], '받은 배열은 바꾸지 않는다');
});

/** 클라이언트 영역 자리 p 에 놓인 창의 바깥 사각형. */
function outer(p: WindowPosition, size: { width: number; height: number }): ScreenArea {
  return {
    x: p.x - WINDOW_FRAME.left,
    y: p.y - WINDOW_FRAME.top,
    width: size.width + WINDOW_FRAME.left + WINDOW_FRAME.right,
    height: size.height + WINDOW_FRAME.top + WINDOW_FRAME.bottom,
  };
}

/** 창 바깥 사각형이 서로 겹치는 쌍이 있는지. */
function overlaps(pos: WindowPosition[], size: { width: number; height: number }): boolean {
  const rects = pos.map((p) => outer(p, size));
  return rects.some((a, i) =>
    rects.slice(i + 1).some((b) => Math.abs(a.x - b.x) < a.width && Math.abs(a.y - b.y) < a.height),
  );
}

/** 모든 창 바깥 사각형이 area 안에 있는지. */
function inside(pos: WindowPosition[], size: { width: number; height: number }, area: ScreenArea): boolean {
  return pos
    .map((p) => outer(p, size))
    .every(
      (r) => r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height,
    );
}

test('clientWindowPositions: 다 들어가면 겹치지 않는 격자로, 안 들어가면 영역 안에 펼친다', () => {
  const size = { width: 1600, height: 900 };
  // 3840x2100 에는 둘씩 두 줄이 들어간다. 셋이면 2열 2행이 한 줄 셋보다 덜 가린다.
  // 값은 클라이언트 영역 자리라 바깥 창보다 왼쪽 8, 위 31 만큼 안쪽이다.
  assert.deepEqual(clientWindowPositions(2, size, TEST_AREA), [
    { x: 8, y: 31 },
    { x: 1624, y: 31 },
  ]);
  assert.deepEqual(clientWindowPositions(3, size, TEST_AREA), [
    { x: 8, y: 31 },
    { x: 1624, y: 31 },
    { x: 8, y: 970 },
  ]);
  for (const n of [2, 3, 4]) {
    const pos = clientWindowPositions(n, size, TEST_AREA);
    assert.equal(overlaps(pos, size), false, `${n}개는 겹치지 않는다`);
    assert.equal(inside(pos, size, TEST_AREA), true, `${n}개는 영역 안이다`);
  }

  // 2560x1392(작업 표시줄을 뺀 1440p)에는 1600x900 둘이 안 들어간다. 겹치되 화면 밖으로 나가지 않는다.
  const qhd: ScreenArea = { x: 0, y: 0, width: 2560, height: 1392 };
  assert.deepEqual(clientWindowPositions(2, size, qhd), [
    { x: 8, y: 31 },
    { x: 952, y: 31 },
  ]);
  for (const n of [2, 3, 4]) {
    assert.equal(inside(clientWindowPositions(n, size, qhd), size, qhd), true, `${n}개는 2560x1392 안이다`);
  }
  // 1260x709 는 2560x1392 에 가로 둘이 들어간다(실게임에서 바깥 창 1276x748 둘이 맞닿았다).
  const small = { width: 1260, height: 709 };
  const fit = clientWindowPositions(2, small, qhd);
  assert.deepEqual(fit, [
    { x: 8, y: 31 },
    { x: 1284, y: 31 },
  ]);
  assert.equal(overlaps(fit, small), false);
  assert.equal(inside(fit, small, qhd), true);

  // 작업 영역이 왼쪽 위에서 비켜 있으면 그만큼 민다(작업 표시줄이 위나 왼쪽).
  assert.deepEqual(clientWindowPositions(2, size, { ...TEST_AREA, x: 48, y: 30 })[1], { x: 1672, y: 61 });
  // 창이 영역보다 크면 모두 영역 왼쪽 위에 둔다.
  assert.deepEqual(clientWindowPositions(2, size, { x: 0, y: 0, width: 1024, height: 768 }), [
    { x: 8, y: 31 },
    { x: 8, y: 31 },
  ]);
  assert.deepEqual(clientWindowPositions(1, size, TEST_AREA), [{ x: 8, y: 31 }]);
});

/** 작업 표시줄을 뺀 2560x1440 과 1920x1080 작업 영역. */
const QHD_AREA: ScreenArea = { x: 0, y: 0, width: 2560, height: 1392 };
const FHD_AREA: ScreenArea = { x: 0, y: 0, width: 1920, height: 1040 };

test('fitClientWindowSize: 겹치지 않는 격자가 안 되면 16:9 를 지키며 들어갈 만큼 줄인다', () => {
  const size = { width: 1600, height: 900 };
  const cases: Array<[ScreenArea, number, { width: number; height: number }]> = [
    [QHD_AREA, 2, { width: 1264, height: 711 }], // 가로 둘
    [QHD_AREA, 3, { width: 1168, height: 657 }], // 2열 2행
    [QHD_AREA, 4, { width: 1168, height: 657 }],
    [FHD_AREA, 2, { width: 944, height: 531 }],
  ];
  for (const [area, n, want] of cases) {
    const fit = fitClientWindowSize(n, size, area);
    assert.equal(fit.mode, 'shrunk', `${area.width}x${area.height} 에 ${n}개`);
    assert.deepEqual(fit.size, want, `${area.width}x${area.height} 에 ${n}개`);
    assert.ok(Math.abs(fit.size.width / fit.size.height - 16 / 9) < 0.01, '16:9 를 지킨다');
    const pos = clientWindowPositions(n, fit.size, area);
    assert.equal(overlaps(pos, fit.size), false, `${n}개가 겹치지 않는다`);
    assert.equal(inside(pos, fit.size, area), true, `${n}개가 영역 안이다`);
  }
  // 줄인 둘은 바깥 창 1280x750 이 맞닿는다.
  assert.deepEqual(clientWindowPositions(2, { width: 1264, height: 711 }, QHD_AREA), [
    { x: 8, y: 31 },
    { x: 1288, y: 31 },
  ]);
});

test('fitClientWindowSize: 다 들어가면 설정 크기를 쓰고, 하한에 걸리면 줄이지 않는다', () => {
  const size = { width: 1600, height: 900 };
  assert.deepEqual(fitClientWindowSize(2, size, TEST_AREA), { size, mode: 'configured' });
  assert.deepEqual(fitClientWindowSize(4, size, TEST_AREA), { size, mode: 'configured' }, '3840x2100 에 2열 2행이 들어간다');
  assert.deepEqual(fitClientWindowSize(1, size, QHD_AREA), { size, mode: 'configured' }, '하나는 줄이지 않는다');
  const small = { width: 1260, height: 709 };
  assert.deepEqual(fitClientWindowSize(2, small, QHD_AREA), { size: small, mode: 'configured' });
  // 1280x720 영역에 넷은 폭 570 이 되어 하한 640 아래다.
  const floor = fitClientWindowSize(4, size, { x: 0, y: 0, width: 1280, height: 720 });
  assert.equal(MIN_FITTED_WINDOW_WIDTH, 640);
  assert.deepEqual(floor, { size, mode: 'floor' });
  // 16:10 설정은 16:10 으로 줄인다.
  const wide = fitClientWindowSize(2, { width: 1600, height: 1000 }, QHD_AREA);
  assert.deepEqual(wide, { size: { width: 1264, height: 790 }, mode: 'shrunk' });
});

test('windowPositionArgs: 인자에 -posX 나 -posY 가 있으면 그것을 따른다', () => {
  assert.deepEqual(windowPositionArgs({ x: 10, y: 20 }, ['-window']), ['-posX=10', '-posY=20']);
  assert.deepEqual(windowPositionArgs({ x: 10, y: 20 }, ['-posX=5']), []);
  assert.deepEqual(windowPositionArgs({ x: 10, y: 20 }, ['-POSY=5']), []);
  assert.deepEqual(windowPositionArgs(undefined, []), []);
});

test('parseWorkArea: "x y 폭 높이" 한 줄만 받는다', () => {
  assert.deepEqual(parseWorkArea('0 0 2560 1392\r\n'), { x: 0, y: 0, width: 2560, height: 1392 });
  assert.deepEqual(parseWorkArea('-1920 40 1920 1040'), { x: -1920, y: 40, width: 1920, height: 1040 });
  assert.equal(parseWorkArea(''), null);
  assert.equal(parseWorkArea('0 0 0 1392'), null);
  assert.equal(parseWorkArea('Add-Type : error'), null);
});

test('prepareClientProfile: Users\\<사용자>\\Arma3.cfg 에 사용자 화면 설정을 실행마다 가져오고 창 크기를 맞춘다', async () => {
  const s = setup();
  const user = path.join(s.base, 'user-Arma3.cfg');
  writeFileSync(user, 'language="Korean";\r\nwinWidth=1024;\r\nwinHeight=1024;\r\n', 'latin1');
  const dir = path.join(s.base, 'stacks', 'b', 'client1');
  const window = { width: 1600, height: 900 };
  const target = clientArmaCfgPath(dir, 'me');
  assert.equal(target, path.join(dir, 'Users', 'me', 'Arma3.cfg'));
  await prepareClientProfile(dir, { window, userCfg: user, user: 'me' });
  let text = readFileSync(target, 'latin1');
  assert.match(text, /language="Korean";/);
  assert.match(text, /winWidth=1600;\r\nwinHeight=900;/);
  writeFileSync(user, 'language="English";\r\n', 'latin1');
  await prepareClientProfile(dir, { window, userCfg: user, user: 'me' });
  assert.match(readFileSync(target, 'latin1'), /language="English";/, '사용자 설정이 바뀌면 따라간다');

  // 사용자 파일이 없으면 클라가 쓰던 파일에 크기만 다시 적는다.
  writeFileSync(target, 'ppSharpen=1;\r\nwinWidth=1024;\r\n', 'latin1');
  await prepareClientProfile(dir, { window, userCfg: null, user: 'me' });
  text = readFileSync(target, 'latin1');
  assert.match(text, /ppSharpen=1;/);
  assert.match(text, /winWidth=1600;/);
  await prepareClientProfile(null, { window, userCfg: user, user: 'me' });
});

test('launchMp dryRun: 스택 b 는 제 포트, profiles, cfg, 접미사 미션, 클라 이름을 쓴다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'b', 2412);
  const cfg = stackCfg(s.cfg, opts.ctx);
  const mp = new MpLauncher(cfg, opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp.launchMp({ mission: s.mission, modset: 'explicit', mods: ['D:\\mods\\@cba'], dryRun: true });
  assert.equal(res.ok, true, res.error);
  const root = path.join(s.cfg.stacks.root, 'b');
  assert.equal(res.server.port, 2412);
  assert.ok(res.server.argString.includes(`-profiles="${path.join(root, 'server', 'profiles')}"`));
  assert.ok(res.server.argString.includes(`-config="${path.join(root, 'server', 'server.cfg')}"`));
  assert.ok(!res.server.argString.includes('-port=9999'), 'serverBaseArgs 의 -port 는 뺀다');
  assert.ok(res.server.argString.includes('-loadMissionToMemory'));
  assert.equal(res.mission.template, 'demo__b.VR');
  assert.match(res.serverCfgText ?? '', /template = "demo__b\.VR";/);
  assert.match(res.serverCfgText ?? '', /hostname = ".* \[b\]";/);
  const client = res.client?.argString ?? '';
  assert.ok(client.includes(`-profiles="${path.join(root, 'client1')}"`));
  assert.ok(client.includes('-name=b_c1'));
  assert.ok(client.includes('-window'));
  assert.ok(!client.includes('C:\\mine'), 'baseArgs 의 -profiles 는 뺀다');
  assert.ok(!client.includes('-name=Me'));
  assert.ok(client.includes('-port=2412'));
});

test('launchMp: 스택 b 는 다른 port 와 스택이 정하는 추가 인자를 거절한다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'b', 2412);
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const port = await mp.launchMp({ mission: s.mission, modset: 'none', port: 2302, dryRun: true });
  assert.equal(port.ok, false);
  assert.match(port.error ?? '', /2412/);
  const owned = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    clientExtraArgs: ['-profiles=C:\\x'],
    dryRun: true,
  });
  assert.equal(owned.ok, false);
  assert.match(owned.error ?? '', /-profiles/);
  const same = await mp.launchMp({ mission: s.mission, modset: 'none', port: 2412, dryRun: true });
  assert.equal(same.ok, true, '스택 포트와 같으면 받는다');
});

test('launchMp dryRun: default 스택은 0.4 인자 그대로다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'default', 0);
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, {}, opts);
  const res = await mp.launchMp({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.mission.template, 'demo.VR');
  assert.ok(res.server.argString.includes('-port=9999'), 'default 는 serverBaseArgs 를 건드리지 않는다');
  const client = res.client?.argString ?? '';
  assert.ok(client.includes('-profiles=C:\\mine'));
  assert.ok(!client.includes('-window'));
});

test('launch dryRun: 스택 b 의 SP 클라는 제 profiles 와 이름을 쓴다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'b', 2412);
  const launcher = new Launcher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), {}, opts);
  const res = await launcher.launch({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(noPauseCount(res.argString), 1, 'SP 클라도 -noPause 를 받는다');
  assert.doesNotMatch(res.argString, /-posX=/, '클라 하나는 자리를 정하지 않는다');
  assert.ok(res.argString.includes(path.join('b', 'client1')));
  assert.ok(res.argString.includes('-name=b_c1'));
  assert.ok(!res.argString.includes('C:\\mine'));
  const owned = await launcher.launch({ modset: 'none', extraArgs: ['-name=x'], dryRun: true });
  assert.equal(owned.ok, false);
});

test('launch, launchMp dryRun: 설정에 -noPause 가 있으면 한 번만 넣고 -noPauseAudio 는 그대로 둔다', async () => {
  const s = setup();
  s.cfg.arma = { ...s.cfg.arma, baseArgs: [...s.cfg.arma.baseArgs, '-noPause', '-noPauseAudio'] };
  const opts = stackOpts(s.cfg, 'default', 0);
  const sp = await new Launcher(s.cfg, s.rptDir, {}, opts).launch({ modset: 'none', dryRun: true });
  assert.equal(sp.ok, true, sp.error);
  assert.equal(noPauseCount(sp.argString), 1, sp.argString);
  assert.match(sp.argString, /-noPauseAudio/);
  const mp = await new MpLauncher(s.cfg, s.rptDir, undefined, {}, opts).launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 2,
    dryRun: true,
  });
  assert.equal(mp.ok, true, mp.error);
  for (const c of mp.clients!) assert.equal(noPauseCount(c.argString), 1, c.argString);
  // 기본 설정(-noPauseAudio 없음)에는 -noPauseAudio 를 넣지 않는다.
  const plain = await new Launcher(setup().cfg, s.rptDir, {}, opts).launch({ modset: 'none', dryRun: true });
  assert.doesNotMatch(plain.argString, /-noPauseAudio/);
});

test('deployMissionToMpMissions: 다른 template 이름이면 다른 스택의 미션 폴더를 남긴다', () => {
  const s = setup();
  const mpDir = path.join(s.base, 'MPMissions');
  const a = deployMissionToMpMissions(s.mission, mpDir);
  const b = deployMissionToMpMissions(s.mission, mpDir, 'demo__b.VR');
  assert.ok(a.ok && b.ok);
  assert.equal(a.template, 'demo.VR');
  assert.equal(b.template, 'demo__b.VR');
  assert.ok(existsSync(path.join(mpDir, 'demo.VR', 'mission.sqm')));
  assert.ok(existsSync(path.join(mpDir, 'demo__b.VR', 'mission.sqm')));
  const unsafe = deployMissionToMpMissions(s.mission, mpDir, '..\\escape.VR');
  assert.equal(unsafe.ok, false);
});

test('stripStackMods: 스택 폴더 안의 모드만 뺀다', () => {
  const root = 'C:\\Users\\me\\.arma-mcp\\stacks';
  const res = stripStackMods(
    `D:\\mods\\@cba;${root}\\b\\@arma_mcp_test;${root}\\default\\overlay\\@big;C:\\Users\\me\\.arma-mcp\\stacksx\\@y`,
    root,
  );
  assert.equal(res.modString, 'D:\\mods\\@cba;C:\\Users\\me\\.arma-mcp\\stacksx\\@y');
  assert.equal(res.removed.length, 2);
});

test('resolveModset: RPT 헤더에서 읽은 스택 모드를 싣지 않고 알린다', () => {
  const s = setup();
  const root = s.cfg.stacks.root;
  writeFileSync(
    path.join(s.rptDir, 'Arma3_x64_2026-09-28_10-00-00.rpt'),
    `== header\n-mod="D:\\mods\\@cba;${root}\\default\\@arma_mcp_test"\n`,
    'utf8',
  );
  const res = resolveModset(s.cfg, s.rptDir, { modset: 'rpt' }, { stacksRoot: root });
  assert.ok(res.modString.startsWith('D:\\mods\\@cba'));
  assert.ok(!res.modString.includes('@arma_mcp_test'));
  assert.match(res.warning ?? '', /스택 폴더 안의 모드/);
});

test('bridgeGate: 0.5.0 미만 DLL 만 막고 DLL 이 없으면 막지 않는다', async () => {
  assert.equal(versionInDll(Buffer.from('xx ArmaMCP 0.4.4 yy ArmaMCP 0.4.10', 'latin1')), '0.4.10');
  assert.equal(versionInDll(Buffer.from('nothing', 'latin1')), null);

  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-gate-'));
  const oldDir = path.join(base, 'old');
  const newDir = path.join(base, 'new');
  mkdirSync(oldDir);
  mkdirSync(newDir);
  writeFileSync(path.join(oldDir, 'arma_mcp_x64.dll'), Buffer.from('\0MZ ArmaMCP 0.4.4\0', 'latin1'));
  writeFileSync(path.join(newDir, 'arma_mcp_x64.dll'), Buffer.from('\0MZ ArmaMCP 0.5.0\0', 'latin1'));
  assert.match((await stackBridgeProblem(oldDir)) ?? '', /0\.4\.4/);
  assert.equal(await stackBridgeProblem(newDir), null);
  assert.equal(await stackBridgeProblem(path.join(base, 'missing')), null);
  assert.equal(await stackBridgeProblem(''), null);
});

test('launchMp: 브리지 확인이 거절하면 실행하지 않는다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'b', 2412, '브리지를 다시 배포하라');
  // 실행 파일 검사가 먼저 실패하지 않게 빈 exe 파일을 만들어 둔다.
  const serverExe = path.join(s.base, 'arma3server_x64.exe');
  writeFileSync(serverExe, '');
  const exe = path.join(s.base, 'arma3_x64.exe');
  writeFileSync(exe, '');
  const cfg = stackCfg(s.cfg, opts.ctx);
  cfg.arma = { ...cfg.arma, exePath: exe, serverExePath: serverExe, selfModPath: '' };
  const mp2 = new MpLauncher(cfg, opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp2.launchMp({ mission: s.mission, modset: 'none', serverOnly: true });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /다시 배포/);
  assert.equal(res.server.launched, false);
});

// ── 다중 클라와 테스트 애드온 ──

test('launchMp dryRun: clients:3 은 클라마다 제 profiles, 이름을 받고 서버 훅이 그 이름으로 역할을 찾는다', async () => {
  const s = setup({ tiler: false });
  const opts = stackOpts(s.cfg, 'b', 2412);
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 3,
    autoInit: true,
    autoSlotRoles: ['Squad Leader', 2, null],
    dryRun: true,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.clients?.length, 3);
  const root = path.join(s.cfg.stacks.root, 'b');
  res.clients!.forEach((c, i) => {
    const n = i + 1;
    assert.equal(c.index, n);
    assert.equal(c.name, `b_c${n}`);
    assert.ok(c.argString.includes(`-profiles="${path.join(root, `client${n}`)}"`), c.argString);
    assert.ok(c.argString.includes(`-name=b_c${n}`));
    assert.doesNotMatch(c.argString, /-init=/);
    assert.equal(noPauseCount(c.argString), 1, c.argString);
  });
  // 작업 영역 3840x2100 에 1600x900 셋은 2열 2행이다.
  assert.deepEqual(
    res.clients!.map((c) => /-posX=(\d+) -posY=(\d+)/.exec(c.argString)?.slice(1).map(Number)),
    [
      [8, 31],
      [1624, 31],
      [8, 970],
    ],
  );
  // 지정이 없는 클라 3 은 항목이 없어 서버 기본 배정이다.
  assert.deepEqual(res.autoSlot, {
    entries: [
      { name: 'b_c1', role: 'Squad Leader' },
      { name: 'b_c2', role: 2 },
    ],
    cfgLines: true,
  });
  assert.match(res.serverCfgText ?? '', /^skipLobby = 1;$/m);
  assert.match(res.serverCfgText ?? '', /private _want = \[\['b_c1', 'Squad Leader'\], \['b_c2', 2\]\];/);
  assert.equal(res.client, res.clients![0]);
  assert.match(res.serverCfgText ?? '', /kickDuplicate = 0;/);
});

test('launchMp: clients 상한과 스택 없는 다중 클라를 거절한다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'b', 2412);
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const over = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 5, dryRun: true });
  assert.equal(over.ok, false);
  assert.match(over.error ?? '', /maxClients/);
  const bare = new MpLauncher(s.cfg, s.rptDir);
  const two = await bare.launchMp({ mission: s.mission, modset: 'none', clients: 2, dryRun: true });
  assert.equal(two.ok, false);
  const one = await bare.launchMp({ mission: s.mission, modset: 'none', clients: 1, dryRun: true });
  assert.equal(one.ok, true, '스택 없이도 클라 1 은 된다');
  assert.equal(one.clients, undefined);
});

test('launchMp dryRun: default 스택 clients:2 는 클라마다 프로필이 다르고 서버를 LAN 모드로 연다', async () => {
  const s = setup({ tiler: false });
  const opts = stackOpts(s.cfg, 'default', 0);
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, {}, opts);
  const res = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 2, dryRun: true });
  assert.equal(res.ok, true, res.error);
  const [c1, c2] = res.clients!.map((c) => c.argString);
  assert.ok(c1!.includes('-profiles=C:\\mine') && c1!.includes('-name=Me'), '클라 1 은 사용자 프로필 그대로');
  assert.ok(c2!.includes(`-profiles="${path.join(s.cfg.stacks.root, 'default', 'client2')}"`), c2);
  assert.ok(c2!.includes('-name=default_c2'));
  assert.ok(!c2!.includes('C:\\mine') && !c2!.includes('-name=Me'), '클라 2 는 설정의 프로필 인자를 받지 않는다');
  assert.doesNotMatch(c1!, /-posX=/, '창 모드가 아닌 클라 1 은 자리를 받지 않는다');
  assert.match(c2!, /-posX=1624 -posY=31/, '클라 2 는 격자의 두 번째 칸이다');
  assert.equal(noPauseCount(c1!), 1);
  assert.equal(noPauseCount(c2!), 1);
  assert.match(res.serverCfgText ?? '', /^loopback = true;$/m);
  assert.match(res.serverCfgText ?? '', /^BattlEye = 0;$/m);

  const one = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 1, dryRun: true });
  assert.doesNotMatch(one.serverCfgText ?? '', /loopback/, '클라 하나면 LAN 모드로 열지 않는다');
});

test('launchMp dryRun: 2560x1392 에 1600x900 둘이 안 들어가면 1264x711 로 줄이고 결과에 적는다', async () => {
  const s = setup({ tiler: false });
  const opts = { ...stackOpts(s.cfg, 'b', 2412), workArea: async () => QHD_AREA };
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 2, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.windowLayout, {
    area: QHD_AREA,
    configured: { width: 1600, height: 900 },
    size: { width: 1264, height: 711 },
    mode: 'shrunk',
  });
  assert.deepEqual(
    res.clients!.map((c) => c.window),
    [
      { width: 1264, height: 711, x: 8, y: 31 },
      { width: 1264, height: 711, x: 1288, y: 31 },
    ],
  );
  assert.match(res.clients![1]!.argString, /-posX=1288 -posY=31/);
  assert.doesNotMatch(res.warning ?? '', /폭 640/);

  // 클라 하나면 창 크기는 설정 그대로이고 배치도 없다.
  const one = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 1, dryRun: true });
  assert.equal(one.windowLayout, undefined);
  assert.deepEqual(one.client?.window, { width: 1600, height: 900 });
});

test('launchMp dryRun: 사용자가 -x, -y, -posX, -posY 를 주면 창 크기를 줄이지 않는다', async () => {
  const s = setup({ tiler: false });
  const opts = { ...stackOpts(s.cfg, 'b', 2412), workArea: async () => QHD_AREA };
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const sized = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 2,
    clientExtraArgs: ['-x=1000', '-y=562'],
    dryRun: true,
  });
  assert.equal(sized.ok, true, sized.error);
  assert.equal(sized.windowLayout?.mode, 'userArgs');
  assert.deepEqual(sized.windowLayout?.userArgs, ['-x=1000', '-y=562']);
  assert.deepEqual(sized.windowLayout?.size, { width: 1600, height: 900 });

  const placedCfg = stackCfg(s.cfg, opts.ctx);
  placedCfg.arma = { ...placedCfg.arma, baseArgs: [...placedCfg.arma.baseArgs, '-posX=0'] };
  const placed = await new MpLauncher(placedCfg, opts.ctx.clientRptDir(1), undefined, {}, opts).launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 2,
    dryRun: true,
  });
  assert.equal(placed.windowLayout?.mode, 'userArgs');
  for (const c of placed.clients!) {
    assert.equal(c.argString.match(/-posX=/g)?.length, 1, '사용자의 -posX 하나만 있다');
    assert.deepEqual(c.window, { width: 1600, height: 900 }, '데몬이 자리를 정하지 않았다');
  }
});

test('launchMp dryRun: 하한에 걸리면 설정 크기로 겹쳐 놓고 warning 에 적는다', async () => {
  const s = setup({ tiler: false });
  const opts = { ...stackOpts(s.cfg, 'b', 2412), workArea: async () => ({ x: 0, y: 0, width: 1280, height: 720 }) };
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 4, dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.windowLayout?.mode, 'floor');
  assert.deepEqual(res.windowLayout?.size, { width: 1600, height: 900 });
  assert.match(res.warning ?? '', /폭 640 아래로 줄여야 겹치지 않아 줄이지 않았다/);
  for (const c of res.clients!) assert.equal(c.window?.width, 1600);
});

test('launchMp dryRun: 창 타일러가 켜져 있으면 클라 둘에서 넷까지 칸 크기로 띄우고 자리는 정하지 않는다', async () => {
  const s = setup();
  const opts = { ...stackOpts(s.cfg, 'b', 2412), workArea: async () => QHD_AREA };
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  for (const clients of [2, 4]) {
    const res = await mp.launchMp({ mission: s.mission, modset: 'none', clients, dryRun: true });
    assert.equal(res.ok, true, res.error);
    // 2560x1392 의 칸은 1280x696 이고 테두리 16x39 를 뺀 1264x657 에 들어가는 16:9 는 1168x657 이다.
    assert.deepEqual(res.windowLayout, {
      area: QHD_AREA,
      configured: { width: 1600, height: 900 },
      size: { width: 1168, height: 657 },
      mode: 'tiled',
    });
    for (const c of res.clients!) {
      assert.deepEqual(c.window, { width: 1168, height: 657 });
      assert.doesNotMatch(c.argString, /-posX=/, c.argString);
    }
  }

  // 칸보다 많으면 0.5.5 처럼 나란히 놓는다. 타일러는 다섯째부터 칸 없이 둔다.
  const many = new MpLauncher(
    { ...stackCfg(s.cfg, opts.ctx), stacks: { ...s.cfg.stacks, maxClients: 6 } },
    opts.ctx.clientRptDir(1),
    undefined,
    {},
    opts,
  );
  const five = await many.launchMp({ mission: s.mission, modset: 'none', clients: 5, dryRun: true });
  assert.equal(five.ok, true, five.error);
  assert.notEqual(five.windowLayout?.mode, 'tiled');
  assert.match(five.clients![1]!.argString, /-posX=/);

  // windowTiler.stacks 가 이 스택을 빼면 타일러가 안 놓으니 0.5.5 처럼 나란히 놓는다.
  const filtered = new MpLauncher(
    { ...stackCfg(s.cfg, opts.ctx), windowTiler: { enabled: true, stacks: ['llm*'] } },
    opts.ctx.clientRptDir(1),
    undefined,
    {},
    opts,
  );
  const outside = await filtered.launchMp({ mission: s.mission, modset: 'none', clients: 2, dryRun: true });
  assert.equal(outside.windowLayout?.mode, 'shrunk');
  assert.match(outside.clients![1]!.argString, /-posX=/);

  // 사용자가 창 크기를 주면 크기는 그대로 두고 자리는 여전히 타일러에 맡긴다.
  const sized = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 2,
    clientExtraArgs: ['-x=1000', '-y=562'],
    dryRun: true,
  });
  assert.equal(sized.windowLayout?.mode, 'userArgs');
  for (const c of sized.clients!) assert.doesNotMatch(c.argString, /-posX=/);
});

test('launchMp dryRun: 타일러가 칸을 알려 주면 클라마다 그 칸 크기로 띄우고, 다른 게임 창이 있으면 클라 하나도 칸 크기다', async () => {
  const s = setup();
  const asked: [string, number][] = [];
  let plan: ({ width: number; height: number } | null)[] | null = null;
  const opts = {
    ...stackOpts(s.cfg, 'b', 2412),
    workArea: async () => QHD_AREA,
    tilePlan: (stack: string, count: number) => {
      asked.push([stack, count]);
      return plan;
    },
  };
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);

  // 다른 게임 창이 없으면 타일러가 놓지 않으니 설정 크기다.
  const alone = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 1, dryRun: true });
  assert.equal(alone.ok, true, alone.error);
  assert.deepEqual(alone.client!.window, { width: 1600, height: 900 });

  // 다른 게임 창이 왼쪽 위에 있으면 새 클라는 오른쪽 위 칸 크기로 뜬다.
  plan = [{ width: 1168, height: 657 }];
  const one = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 1, dryRun: true });
  assert.deepEqual(one.client!.window, { width: 1168, height: 657 });

  // 주 모니터가 차서 둘째 클라가 왼쪽 모니터 칸을 받으면 그 칸 크기다.
  plan = [
    { width: 1168, height: 657 },
    { width: 1008, height: 567 },
  ];
  const two = await mp.launchMp({ mission: s.mission, modset: 'none', clients: 2, dryRun: true });
  assert.equal(two.windowLayout?.mode, 'tiled');
  assert.deepEqual(
    two.clients!.map((c) => c.window),
    [
      { width: 1168, height: 657 },
      { width: 1008, height: 567 },
    ],
  );
  assert.deepEqual(asked, [
    ['b', 1],
    ['b', 1],
    ['b', 2],
  ]);

  // 사용자가 창 크기를 주면 묻지 않는다.
  await mp.launchMp({ mission: s.mission, modset: 'none', clients: 1, clientExtraArgs: ['-x=1000', '-y=562'], dryRun: true });
  assert.equal(asked.length, 3);
});

test('launchMp: 클라가 여럿이면 모든 클라에 붙는 -profiles 와 -name 을 거절한다', async () => {
  const s = setup();
  const opts = stackOpts(s.cfg, 'default', 0);
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, {}, opts);
  const two = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    clients: 2,
    clientExtraArgs: ['-name=x'],
    dryRun: true,
  });
  assert.equal(two.ok, false);
  assert.match(two.error ?? '', /-name=x/);
  const one = await mp.launchMp({ mission: s.mission, modset: 'none', clientExtraArgs: ['-name=x'], dryRun: true });
  assert.equal(one.ok, true, '클라 하나면 받는다');
});

test('launchMp: 서버는 MCP 가 만든 server.cfg 만 읽고 BattlEye 줄을 덧붙이지 않는다', async () => {
  const s = setup();
  s.cfg.mp = {
    ...s.cfg.mp,
    serverBaseArgs: [...s.cfg.mp.serverBaseArgs, '-config=C:\\own.cfg'],
    extraCfgLines: ['BattlEye = 1;', 'maxPing = 200;'],
  };
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, {}, stackOpts(s.cfg, 'default', 0));
  const res = await mp.launchMp({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(res.ok, true, res.error);
  assert.ok(!res.server.argString.includes('C:\\own.cfg'), 'serverBaseArgs 의 -config 는 뺀다');
  assert.equal(res.server.argString.match(/-config=/g)?.length, 1);
  assert.doesNotMatch(res.serverCfgText ?? '', /BattlEye = 1;/);
  assert.match(res.serverCfgText ?? '', /maxPing = 200;/);
  assert.match(res.warning ?? '', /BattlEye = 1;/);
  assert.match(res.warning ?? '', /C:\\own\.cfg/);

  const extra = await mp.launchMp({
    mission: s.mission,
    modset: 'none',
    serverExtraArgs: ['-config=C:\\own.cfg'],
    dryRun: true,
  });
  assert.equal(extra.ok, false);
  assert.match(extra.error ?? '', /-config/);
});

test('launch, launchMp: BattlEye 실행기로는 클라를 띄우지 않는다', async () => {
  const s = setup();
  s.cfg.arma = { ...s.cfg.arma, exePath: 'C:\\game\\arma3battleye.exe' };
  const opts = stackOpts(s.cfg, 'default', 0);
  const mp = new MpLauncher(s.cfg, s.rptDir, undefined, {}, opts);
  const withClient = await mp.launchMp({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(withClient.ok, false);
  assert.match(withClient.error ?? '', /arma3battleye\.exe/);
  const serverOnly = await mp.launchServer({ mission: s.mission, modset: 'none', dryRun: true });
  assert.equal(serverOnly.ok, true, '서버만 띄우면 클라 exe 를 보지 않는다');
  const sp = await new Launcher(s.cfg, s.rptDir, {}, opts).launch({ modset: 'none', dryRun: true });
  assert.equal(sp.ok, false);
  assert.match(sp.error ?? '', /arma3battleye\.exe/);
});

test('launchMp dryRun: testMods 는 계획을 싣고 -mod 끝에 스택 테스트 애드온을 붙인다', async () => {
  const s = setup();
  const pbo = path.join(s.base, 'build', 'addons', 'thing.pbo');
  mkdirSync(path.dirname(pbo), { recursive: true });
  writeFileSync(pbo, 'x');
  const opts = stackOpts(s.cfg, 'b', 2412);
  const mp = new MpLauncher(stackCfg(s.cfg, opts.ctx), opts.ctx.clientRptDir(1), undefined, {}, opts);
  const res = await mp.launchMp({
    mission: s.mission,
    modset: 'explicit',
    mods: [path.join(s.base, 'mods', '@cba')],
    testMods: [pbo],
    dryRun: true,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.testMods?.files[0]?.name, 'thing.pbo');
  assert.equal(res.mods.at(-1), opts.ctx.testModDir);
  assert.ok(res.server.argString.includes(opts.ctx.testModDir));
  assert.equal(existsSync(opts.ctx.testModDir), false, 'dryRun 은 복사하지 않는다');
  const bare = new MpLauncher(s.cfg, s.rptDir);
  const refused = await bare.launchMp({ mission: s.mission, modset: 'none', testMods: [pbo], dryRun: true });
  assert.equal(refused.ok, false);
});


test('scaffoldMission: slots 만큼 플레이 가능한 유닛을 id 와 이름을 달리해 만든다', () => {
  const s = setup();
  const res = scaffoldMission({ world: 'VR', name: 'multi', slots: 3, targetDir: path.join(s.base, 'scaffold') });
  const sqm = readFileSync(path.join(res.missionPath, 'mission.sqm'), 'utf8');
  assert.equal((sqm.match(/isPlayable=1;/g) ?? []).length, 3);
  assert.equal((sqm.match(/isPlayer=1;/g) ?? []).length, 1);
  for (const n of [0, 1, 2]) assert.ok(sqm.includes(`name="mcp_slot_${n}";`));
  assert.ok(sqm.includes('id=2;') && sqm.includes('id=3;'));
  assert.ok(sqm.includes('items=3;'));
  const init = readFileSync(path.join(res.missionPath, 'init.sqf'), 'utf8');
  assert.ok(init.includes('mcp_slot_'), '슬롯이 여럿이면 옮긴 자리를 슬롯마다 벌린다');
  const single = scaffoldMission({ world: 'VR', name: 'single', targetDir: path.join(s.base, 'scaffold') });
  assert.ok(!readFileSync(path.join(single.missionPath, 'init.sqf'), 'utf8').includes('mcp_slot_'));
});

test('profileFromPlay: 오버레이는 원래 모드로, 스냅샷은 빼고, testMods 와 clients 를 적는다', () => {
  const s = setup();
  const root = s.cfg.stacks.root;
  const overlay = path.join(root, 'b', 'overlay', '@big');
  mkdirSync(overlay, { recursive: true });
  writeFileSync(path.join(overlay, 'arma-mcp-overlay.json'), JSON.stringify({ source: 'D:\mods\@big' }));
  const result = {
    mode: 'mp',
    mission: { origin: 'given', ref: s.mission, world: 'VR' },
    launch: {
      mods: [overlay, 'D:\mods\@cba', s.cfg.arma.selfModPath, path.join(root, 'b', '@arma_mcp_test')],
      mission: { source: s.mission },
    },
  } as unknown as PlayResult;
  const profile = profileFromPlay(
    s.cfg,
    { mode: 'mp', clients: 3, testMods: ['build\thing.pbo'] },
    result,
    new Date(0),
  );
  assert.deepEqual(profile.mods, ['D:\mods\@big', 'D:\mods\@cba']);
  assert.equal(profile.clients, 3);
  assert.deepEqual(profile.testMods, [path.resolve('build\thing.pbo')]);
  const merged = mergeProfile({ mode: 'mp' }, profile);
  assert.equal(merged.clients, 3);
  assert.deepEqual(merged.testMods, profile.testMods);
});

// ── 클라 접속 판정(텔레메트리) ──

function fakeBridge(snaps: Array<Partial<MissionSnapshot>>) {
  let i = 0;
  const sent: unknown[] = [];
  const base = { players: [], clients: [] } as unknown as MissionSnapshot;
  return {
    sent,
    deps: {
      gateway: { isConnected: () => true, send: (f: unknown) => (sent.push(f), true) },
      telemetry: { current: () => ({ ...base, ...snaps[Math.min(i++, snaps.length - 1)] }) },
    } as unknown as MpLauncherBridgeDeps,
  };
}

test('waitClientInTelemetry: 이름을 아는 클라는 그 이름이 clients 나 players 에 보이면 접속으로 본다', async () => {
  const lobbyClient = { name: 'a_c2', state: 6, stateName: '', isHC: false, hasUnit: false };
  const { deps } = fakeBridge([{}, {}, { clients: [lobbyClient] }]);
  const ac = new AbortController();
  const res = await waitClientInTelemetry(deps, 'a_c2', new Set(), 5000, ac.signal);
  assert.equal(res.found, true);
  assert.match(res.line ?? '', /a_c2/);
});

test('waitClientInTelemetry: 이름을 모르면 baseline 에 없던 새 이름을 찾고, HC 는 세지 않는다', async () => {
  const me = { name: 'Me', side: 'WEST', uid: '1', isPlayer: true };
  const hc = { name: 'HC', state: 10, stateName: '', isHC: true, hasUnit: false };
  const { deps } = fakeBridge([
    { players: [me], clients: [hc] },
    { players: [me, { name: 'Other', side: 'WEST', uid: '2', isPlayer: true }], clients: [hc] },
  ]);
  const res = await waitClientInTelemetry(deps, null, new Set(['Me']), 5000, new AbortController().signal);
  assert.equal(res.found, true);
  assert.match(res.line ?? '', /Other/);
});

test('waitClientInTelemetry: 시간 안에 안 보이면 found:false, 멈추면 aborted', async () => {
  const { deps, sent } = fakeBridge([{}]);
  const res = await waitClientInTelemetry(deps, 'x', new Set(), 1200, new AbortController().signal);
  assert.equal(res.found, false);
  assert.equal(res.aborted, undefined);
  assert.ok(sent.length >= 1, '텔레메트리를 당겨 달라고 요청한다');
  const ac = new AbortController();
  const pending = waitClientInTelemetry(deps, 'x', new Set(), 60000, ac.signal);
  ac.abort();
  assert.equal((await pending).aborted, true);
});
