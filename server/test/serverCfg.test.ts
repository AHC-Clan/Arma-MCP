import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildServerCfg,
  writeServerCfg,
  deployMissionToMpMissions,
} from '../src/launch/serverCfg.js';
import { battlEyeExeProblem, splitBattlEyeLines } from '../src/launch/battlEye.js';

function baseOpts() {
  return {
    hostname: 'arma-mcp test server',
    password: '',
    adminPassword: 'armamcp',
    maxPlayers: 8,
    template: 'mcp_test.VR',
    autoInit: false,
  };
}

test('buildServerCfg: template/hostname/기본 안전 설정 포함', () => {
  const cfg = buildServerCfg(baseOpts());
  assert.match(cfg, /hostname = "arma-mcp test server";/);
  assert.match(cfg, /template = "mcp_test\.VR";/);
  assert.match(cfg, /verifySignatures = 0;/);
  assert.match(cfg, /BattlEye = 0;/);
  assert.match(cfg, /persistent = 0;/);
  assert.match(cfg, /maxPlayers = 8;/);
});

test('buildServerCfg: password 빈 값이면 라인 생략, 있으면 포함', () => {
  const noPw = buildServerCfg(baseOpts());
  assert.doesNotMatch(noPw, /^password = /m);
  assert.match(noPw, /passwordAdmin = "armamcp";/);

  const withPw = buildServerCfg({ ...baseOpts(), password: 'secret' });
  assert.match(withPw, /password = "secret";/);
});

test('buildServerCfg: autoInit=true 면 persistent=1', () => {
  const cfg = buildServerCfg({ ...baseOpts(), autoInit: true });
  assert.match(cfg, /persistent = 1;/);
});

test('buildServerCfg: extraCfgLines 는 그대로 덧붙는다', () => {
  const cfg = buildServerCfg({ ...baseOpts(), extraCfgLines: ['motd[] = {"hi"};'] });
  assert.match(cfg, /motd\[\] = \{"hi"\};/);
});

test('buildServerCfg: extraCfgLines 의 BattlEye 줄은 넣지 않아 BattlEye = 0 하나만 남는다', () => {
  const cfg = buildServerCfg({
    ...baseOpts(),
    extraCfgLines: ['BattlEye = 1;', '  battleye=1;', 'motd[] = {"a"}; BattlEye = 1;', 'maxPing = 200;'],
  });
  assert.deepEqual(cfg.match(/battleye\s*=/gi), ['BattlEye =']);
  assert.match(cfg, /BattlEye = 0;/);
  assert.match(cfg, /maxPing = 200;/);
});

test('buildServerCfg: loopback 은 줄 때만 넣는다', () => {
  assert.doesNotMatch(buildServerCfg(baseOpts()), /loopback/);
  assert.match(buildServerCfg({ ...baseOpts(), loopback: true }), /^loopback = true;$/m);
});

test('splitBattlEyeLines 와 battlEyeExeProblem', () => {
  assert.deepEqual(splitBattlEyeLines(['a = 1;', 'BattlEye = 0;']), { kept: ['a = 1;'], dropped: ['BattlEye = 0;'] });
  assert.equal(battlEyeExeProblem('G:\\Steam\\Arma 3\\Arma3_x64.exe'), null);
  assert.equal(battlEyeExeProblem(''), null);
  assert.match(battlEyeExeProblem('G:\\Steam\\Arma 3\\arma3battleye.exe') ?? '', /arma3battleye\.exe/);
});

test('buildServerCfg: 따옴표는 "" 로 이스케이프', () => {
  const cfg = buildServerCfg({ ...baseOpts(), hostname: 'my "cool" server' });
  assert.match(cfg, /hostname = "my ""cool"" server";/);
});

test('writeServerCfg: 지정 폴더에 server.cfg 기록·재생성', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-svrcfg-'));
  const p = writeServerCfg('first\n', dir);
  assert.equal(path.basename(p), 'server.cfg');
  assert.equal(readFileSync(p, 'utf8'), 'first\n');
  // 매 런치 재생성(덮어쓰기).
  writeServerCfg('second\n', dir);
  assert.equal(readFileSync(p, 'utf8'), 'second\n');
});

test('deployMissionToMpMissions: 미션 폴더를 template 이름으로 복사', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-deploy-'));
  const mission = path.join(base, 'src', 'mcp_test.VR');
  mkdirSync(mission, { recursive: true });
  writeFileSync(path.join(mission, 'mission.sqm'), 'sqm', 'utf8');
  const mpDir = path.join(base, 'MPMissions');

  const r = deployMissionToMpMissions(mission, mpDir);
  assert.equal(r.ok, true);
  assert.equal(r.template, 'mcp_test.VR');
  assert.equal(r.method, 'copy');
  assert.ok(existsSync(path.join(mpDir, 'mcp_test.VR', 'mission.sqm')));
});

test('deployMissionToMpMissions: 기존 배치는 덮어쓴다', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-deploy-'));
  const mission = path.join(base, 'src', 't.VR');
  mkdirSync(mission, { recursive: true });
  writeFileSync(path.join(mission, 'mission.sqm'), 'v1', 'utf8');
  writeFileSync(path.join(mission, 'removed.sqf'), 'stale', 'utf8');
  const mpDir = path.join(base, 'MPMissions');

  deployMissionToMpMissions(mission, mpDir);
  writeFileSync(path.join(mission, 'mission.sqm'), 'v2', 'utf8');
  rmSync(path.join(mission, 'removed.sqf'));
  const r = deployMissionToMpMissions(mission, mpDir);
  assert.equal(r.ok, true);
  assert.equal(readFileSync(path.join(mpDir, 't.VR', 'mission.sqm'), 'utf8'), 'v2');
  assert.equal(existsSync(path.join(mpDir, 't.VR', 'removed.sqf')), false);
});

test('deployMissionToMpMissions: 소스가 이미 최종 MPMissions 위치면 no-op', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-deploy-'));
  const mpDir = path.join(base, 'MPMissions');
  const mission = path.join(mpDir, 'already.VR');
  mkdirSync(mission, { recursive: true });
  writeFileSync(path.join(mission, 'mission.sqm'), 'same', 'utf8');

  const r = deployMissionToMpMissions(mission, mpDir);
  assert.equal(r.ok, true);
  assert.equal(r.method, 'in-place');
  assert.equal(readFileSync(path.join(mission, 'mission.sqm'), 'utf8'), 'same');
});

test('deployMissionToMpMissions: mpMissionsDir 미지정이면 명시 에러', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-deploy-'));
  const mission = path.join(base, 'x.VR');
  mkdirSync(mission, { recursive: true });
  const r = deployMissionToMpMissions(mission, '');
  assert.equal(r.ok, false);
  assert.match(r.error!, /mpMissionsDir/);
});
