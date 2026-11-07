import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AUTO_SELECT_LOG,
  autoSlotCfgLines,
  autoSlotEntries,
  buildAutoSelectRoleHook,
  missionSkipLobby,
  parseAutoSelectLines,
  parseServerPlayers,
  parseSqfArray,
  roleProblem,
  roleSpecText,
  rolesProblem,
  userAutoSlotLines,
} from '../src/launch/autoSlot.js';
import { judgeAutoSlot } from '../src/launch/playOrchestrator.js';
import { buildServerCfg } from '../src/launch/serverCfg.js';

// 훅은 서버 전용 GameState 에서 돈다. 그 GameState 에 없는 명령을 쓰면 훅이 컴파일되지 않는다(엔진 분석).
const MISSING_IN_HOOK_STATE = ['params', 'format', 'isEqualTo'];

test('buildAutoSelectRoleHook: 이름으로 지정을 찾고 숫자, 변수 이름, 설명 순으로 고른다', () => {
  const hook = buildAutoSelectRoleHook([
    { name: 'lobby_c1', role: 'OPFOR Rifleman' },
    { name: 'lobby_c2', role: 3 },
    { name: '', role: "O'Neil" },
  ]);
  assert.match(hook, /private _want = \[\['lobby_c1', 'OPFOR Rifleman'\], \['lobby_c2', 3\], \['', 'O''Neil'\]\];/);
  // server.cfg 의 큰따옴표 문자열 안에 들어가므로 큰따옴표가 없다.
  assert.doesNotMatch(hook, /"/);
  for (const cmd of MISSING_IN_HOOK_STATE) assert.doesNotMatch(hook, new RegExp(`\\b${cmd}\\b`));
  // 이름은 getUserInfo 의 3번, 변수 이름은 getRoles 의 7번, 설명은 6번, 빈 슬롯은 5번이 "" 다(2.22 실측).
  assert.match(hook, /getUserInfo \(_this select 1\)/);
  assert.match(hook, /\(_x select 7\) == _spec/);
  assert.match(hook, /toLower \(_x select 6\)/);
  assert.match(hook, /\(_x select 5\) == ''/);
  // 못 찾으면 -1 을 돌려주지 않는다. 숫자가 아닌 값(아무것도 아님)이면 기본 배정이다.
  assert.match(hook, /if \(_pick >= 0\) then \{ _pick \}$/);
  assert.ok(hook.includes(`diag_log ('${AUTO_SELECT_LOG}|pick=`));
});

test('autoSlotCfgLines 와 buildServerCfg: skipLobby 와 훅이 server.cfg 에 한 줄씩 들어간다', () => {
  const lines = autoSlotCfgLines([{ name: 'a', role: 1 }]);
  assert.equal(lines[0], 'skipLobby = 1;');
  assert.match(lines[1]!, /^OnAutoSelectRole = "private _want = \[\['a', 1\]\];.*";$/);

  const cfg = buildServerCfg({
    hostname: 'h',
    password: '',
    adminPassword: 'x',
    maxPlayers: 4,
    template: 't.VR',
    autoInit: true,
    autoSlot: [],
    extraCfgLines: ['motd[] = {};'],
  });
  assert.match(cfg, /^skipLobby = 1;$/m);
  assert.match(cfg, /^OnAutoSelectRole = "private _want = \[\];/m);
  // 사용자의 extraCfgLines 는 그 뒤에 온다.
  assert.ok(cfg.indexOf('OnAutoSelectRole') < cfg.indexOf('motd[]'));

  const off = buildServerCfg({ hostname: 'h', password: '', adminPassword: 'x', maxPlayers: 4, template: 't.VR', autoInit: true });
  assert.doesNotMatch(off, /skipLobby|OnAutoSelectRole/);
});

test('userAutoSlotLines: 설정이 이미 정한 자동 배정 줄을 찾는다', () => {
  assert.deepEqual(userAutoSlotLines(['skipLobby = 0;', 'motd[] = {};', ' onautoselectrole = "1";']), [
    'skipLobby = 0;',
    ' onautoselectrole = "1";',
  ]);
  assert.deepEqual(userAutoSlotLines(undefined), []);
});

test('autoSlotEntries: 지정이 있는 클라만, 이름을 모르는 클라는 이름 "" 로', () => {
  const names = (i: number): string | null => (i === 1 ? null : `default_c${i}`);
  assert.deepEqual(autoSlotEntries(['  Medic ', null, 4], 3, names), [
    { name: '', role: 'Medic' },
    { name: 'default_c3', role: 4 },
  ]);
  assert.deepEqual(autoSlotEntries([], 2, names), []);
});

test('parseAutoSelectLines: 훅 줄을 읽고 따옴표로 감싼 diag_log 모양도 받는다', () => {
  const lines = parseAutoSelectLines([
    '22:40:01 "[ArmaMCP] autoSelectRole|pick=4|match=desc|role=OPFOR Rifleman|who=lobby_c1|name=lobby_c1"',
    '22:40:09 [ArmaMCP] autoSelectRole|pick=-1|match=none|role=|who=lobby_c2|name=lobby_c2',
    '22:40:10 Error, OnSelectRole tried to select a role that is occupied',
  ]);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    { pick: lines[0]!.pick, match: lines[0]!.match, role: lines[0]!.role, who: lines[0]!.who, name: lines[0]!.name },
    { pick: 4, match: 'desc', role: 'OPFOR Rifleman', who: 'lobby_c1', name: 'lobby_c1' },
  );
  assert.equal(lines[1]!.pick, -1);
  assert.equal(lines[1]!.name, 'lobby_c2');
});

test('missionSkipLobby: description.ext 의 값만 읽고 주석은 건너뛴다', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-skiplobby-'));
  assert.equal(missionSkipLobby(dir), undefined);
  writeFileSync(path.join(dir, 'description.ext'), '// skipLobby = 1;\nrespawn = 2;\n', 'utf8');
  assert.equal(missionSkipLobby(dir), undefined);
  writeFileSync(path.join(dir, 'description.ext'), 'respawn = 2;\nskipLobby = 0;\n', 'utf8');
  assert.equal(missionSkipLobby(dir), 0);
  assert.equal(missionSkipLobby(undefined), undefined);
});

test('parseSqfArray, parseServerPlayers: SQF str 배열을 읽는다', () => {
  assert.deepEqual(parseSqfArray('[["a ""b""",1],[]]'), [['a "b"', 1], []]);
  assert.equal(parseSqfArray('[any]'), null);
  assert.deepEqual(
    parseServerPlayers('[["lobby_c1","OPFOR Rifleman","O_Soldier_F","EAST","opf_rifle"]]'),
    [{ name: 'lobby_c1', roleDescription: 'OPFOR Rifleman', type: 'O_Soldier_F', side: 'EAST', varName: 'opf_rifle' }],
  );
});

test('roleProblem, rolesProblem, roleSpecText', () => {
  assert.equal(roleProblem(null), null);
  assert.equal(roleProblem(0), null);
  assert.equal(roleProblem('Rifleman'), null);
  assert.match(roleProblem(1.5)!, /정수/);
  assert.match(roleProblem(1000)!, /999/);
  assert.match(roleProblem('   ')!, /비어/);
  assert.match(roleProblem('x'.repeat(65))!, /64/);
  assert.match(roleProblem('a\tb')!, /제어 문자/);
  assert.match(roleProblem('a"b')!, /큰따옴표/);
  assert.equal(rolesProblem(undefined, 1), null);
  assert.match(rolesProblem(['a', 'b', 'c'], 2)!, /clients 는 2/);
  assert.match(rolesProblem(['a', ''], 2)!, /roles\[1\]/);
  assert.equal(roleSpecText(null), 'auto');
  assert.equal(roleSpecText(3), '#3');
  assert.equal(roleSpecText(' Medic '), 'Medic');
});

test('judgeAutoSlot: 훅이 고른 역할과 서버의 실제 역할이 같으면 assigned, 다르면 fallback', () => {
  const players = [
    { name: 'lobby_c1', roleDescription: 'OPFOR Rifleman', type: 'O_Soldier_F', side: 'EAST', varName: 'opf_rifle' },
    { name: 'lobby_c2', roleDescription: 'Alpha Squad Leader', type: 'B_Soldier_SL_F', side: 'WEST', varName: '' },
  ];
  const hook = parseAutoSelectLines([
    '[ArmaMCP] autoSelectRole|pick=4|match=var|role=OPFOR Rifleman|who=lobby_c1|name=lobby_c1',
    '[ArmaMCP] autoSelectRole|pick=2|match=desc|role=Bravo Combat Medic|who=lobby_c2|name=lobby_c2',
  ]);
  const judged = judgeAutoSlot({
    requested: true,
    clients: [
      { index: 1, name: 'lobby_c1', role: 'opf_rifle' },
      { index: 2, name: 'lobby_c2', role: 'medic' },
    ],
    hook,
    players,
    inGame: true,
  });
  assert.equal(judged.clients[0]!.state, 'assigned');
  assert.equal(judged.clients[0]!.roleIndex, 4);
  assert.equal(judged.clients[0]!.match, 'var');
  assert.equal(judged.clients[0]!.role, 'OPFOR Rifleman');
  assert.equal(judged.clients[0]!.side, 'EAST');
  // 훅은 2번을 골랐지만 실제로는 다른 역할이다(찬 슬롯이라 엔진이 기본 배정으로 보냈다).
  assert.equal(judged.clients[1]!.state, 'fallback');
  assert.equal(judged.state, 'fallback');
  assert.equal(judged.humanNeeded, false);
});

test('judgeAutoSlot: 이름 없는 클라, 기본 배정, 증거 없음, 로비를 강제한 미션, 끈 실행', () => {
  const players = [
    { name: 'player1', roleDescription: 'Alpha Squad Leader', type: 'B_Soldier_SL_F', side: 'WEST', varName: '' },
    { name: 'default_c2', roleDescription: 'OPFOR Squad Leader', type: 'O_Soldier_SL_F', side: 'EAST', varName: '' },
  ];
  const clients = [
    { index: 1, role: null },
    { index: 2, name: 'default_c2', role: null },
  ];
  const auto = judgeAutoSlot({ requested: true, clients, hook: [], players, inGame: true });
  assert.equal(auto.state, 'assigned');
  // 이름을 모르는 클라는 다른 클라 이름에 없는 플레이어다.
  assert.equal(auto.clients[0]!.name, 'player1');
  assert.equal(auto.clients[0]!.requested, 'auto');

  const unread = judgeAutoSlot({ requested: true, clients, hook: [], players: null, inGame: true });
  assert.equal(unread.state, 'no-evidence');

  const forced = judgeAutoSlot({ requested: true, clients, hook: [], players, missionSkipLobby: 0, inGame: true });
  assert.equal(forced.state, 'mission-lobby');
  assert.equal(forced.humanNeeded, true);

  const off = judgeAutoSlot({ requested: false, clients, hook: [], players, inGame: true });
  assert.equal(off.state, 'disabled');
  assert.equal(off.clients[1]!.state, 'disabled');
  assert.equal(off.humanNeeded, true);

  const notIn = judgeAutoSlot({ requested: true, clients, hook: [], players: null, inGame: false });
  assert.equal(notIn.humanNeeded, true);
});
