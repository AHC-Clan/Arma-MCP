// processScope.test.ts — 명령줄의 -profiles 로 Arma 프로세스를 스택별로 가르고,
// 한 스택의 종료가 다른 스택의 게임을 건드리지 않는지 본다. 실제 프로세스는 띄우지 않는다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import {
  clientIndexOf,
  profilesArg,
  stackOfProfiles,
  type ArmaProcessInfo,
} from '../src/stack/processIndex.js';
import { createScopedProcs } from '../src/stack/processScope.js';
import { captureForTool } from '../src/mcp/tools/capture.js';
import type { HelperRunner } from '../src/capture/capture.js';

const ROOT = 'C:\\Users\\me\\.arma-mcp\\stacks';
const EXE = 'G:\\Steam\\Arma 3\\Arma3_x64.exe';
const SRV = 'G:\\Steam\\Arma 3\\arma3server_x64.exe';

function cfg(): Config {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-scope-'));
  const file = path.join(dir, 'cfg.json');
  writeFileSync(
    file,
    JSON.stringify({
      stacks: { root: ROOT },
      arma: { exePath: EXE },
      capture: { dir: path.join(dir, 'captures') },
    }),
    'utf8',
  );
  return loadConfig(file, { quiet: true });
}

test('profilesArg: 따옴표 모양과 대소문자를 가리지 않는다', () => {
  assert.equal(profilesArg(`"${EXE}" -skipIntro -profiles="C:\\a b\\c" -mod="x"`), 'C:\\a b\\c');
  assert.equal(profilesArg(`${SRV} -PROFILES=C:\\x -port=2302`), 'C:\\x');
  assert.equal(profilesArg(`${SRV} "-profiles=C:\\q r" -port=2302`), 'C:\\q r');
  assert.equal(profilesArg(`${EXE} -connect=127.0.0.1`), null);
  assert.equal(profilesArg(`${EXE} -profiles=`), null);
  assert.equal(profilesArg(''), null);
});

test('stackOfProfiles: 스택 폴더 아래만 그 스택이고 나머지는 default', () => {
  assert.equal(stackOfProfiles(`${ROOT}\\b\\client1`, ROOT), 'b');
  assert.equal(stackOfProfiles(`${ROOT.toUpperCase()}\\B2\\server\\profiles`, ROOT), 'b2');
  assert.equal(stackOfProfiles(`${ROOT}\\default\\client2`, ROOT), 'default');
  assert.equal(stackOfProfiles('C:\\Users\\me\\.arma-mcp\\server\\profiles', ROOT), 'default');
  assert.equal(stackOfProfiles(`${ROOT}x\\b\\client1`, ROOT), 'default');
  assert.equal(stackOfProfiles(`${ROOT}\\Bad-Name\\client1`, ROOT), 'default');
  assert.equal(stackOfProfiles(null, ROOT), 'default');
});

test('clientIndexOf: ...\\client<N> 의 N, 그 밖은 1', () => {
  assert.equal(clientIndexOf(`${ROOT}\\b\\client3`), 3);
  assert.equal(clientIndexOf(`${ROOT}\\b\\client12\\`), 12);
  assert.equal(clientIndexOf(null), 1);
  assert.equal(clientIndexOf('C:\\profiles'), 1);
});

// default: 사람이 띄운 클라(101), default 서버(102), default 클라 2(103)
// b: 서버(201), 클라 1(202), 클라 2(203)
const PROCESSES: ArmaProcessInfo[] = [
  { pid: 101, image: 'arma3_x64.exe', commandLine: `"${EXE}" -skipIntro` },
  { pid: 102, image: 'arma3server_x64.exe', commandLine: `"${SRV}" -profiles="C:\\Users\\me\\.arma-mcp\\server\\profiles"` },
  { pid: 103, image: 'arma3_x64.exe', commandLine: `"${EXE}" -profiles="${ROOT}\\default\\client2"` },
  { pid: 201, image: 'arma3server_x64.exe', commandLine: `"${SRV}" -profiles="${ROOT}\\b\\server\\profiles"` },
  { pid: 202, image: 'arma3_x64.exe', commandLine: `"${EXE}" -profiles="${ROOT}\\b\\client1"` },
  { pid: 203, image: 'arma3_x64.exe', commandLine: `"${EXE}" -profiles="${ROOT}\\b\\client2"` },
];

function scoped(stackId: string, opts: { failList?: boolean; othersActive?: boolean } = {}) {
  let alive = new Set(PROCESSES.map((p) => p.pid));
  const killed: number[][] = [];
  const procs = createScopedProcs({
    cfg: cfg(),
    stackId,
    stacksRoot: ROOT,
    othersActive: () => opts.othersActive ?? false,
    lister: async () =>
      opts.failList ? null : PROCESSES.filter((p) => alive.has(p.pid)),
    killer: async (pids) => {
      killed.push([...pids]);
      alive = new Set([...alive].filter((p) => !pids.includes(p)));
      return { ok: true, detail: `killed ${pids.join(',')}` };
    },
    alive: (pid) => alive.has(pid),
  });
  return { procs, killed };
}

test('list: 스택마다 제 프로세스만 역할과 순번을 붙여 돌려준다', async () => {
  const d = await scoped('default').procs.list(true);
  assert.deepEqual(
    d?.map((p) => [p.pid, p.role, p.index]),
    [
      [101, 'client', 1],
      [102, 'server', 0],
      [103, 'client', 2],
    ],
  );
  const b = await scoped('b').procs.list(true);
  assert.deepEqual(
    b?.map((p) => [p.pid, p.role, p.index]),
    [
      [201, 'server', 0],
      [202, 'client', 1],
      [203, 'client', 2],
    ],
  );
});

test('killProcAsync: default 스택 종료는 default pid 만 끈다', async () => {
  const { procs, killed } = scoped('default');
  const client = await procs.killProcAsync('arma3_x64.exe');
  assert.equal(client.killed, true);
  assert.deepEqual(killed, [[101, 103]]);
  assert.equal(await procs.waitProcGone('arma3_x64.exe', 1000, 10), true);
  assert.equal(await procs.isProcRunningAsync('arma3_x64.exe', true), false);
  const server = await procs.findRunningServerImage('arma3server_x64.exe', true);
  assert.equal(server, 'arma3server_x64.exe');
});

test('killProcAsync: 스택 b 종료는 b 의 서버와 클라만 끄고 default 는 남긴다', async () => {
  const { procs, killed } = scoped('b');
  await procs.killProcAsync('arma3server_x64.exe');
  await procs.killProcAsync('arma3_x64.exe');
  assert.deepEqual(killed, [[201], [202, 203]]);
});

test('조회 실패: 다른 스택이 돌면 default 도 이미지 이름으로 물러서지 않는다', async () => {
  const { procs, killed } = scoped('default', { failList: true, othersActive: true });
  const res = await procs.killProcAsync('arma3_x64.exe');
  assert.equal(res.killed, false);
  assert.match(res.detail, /목록을 읽지 못해/);
  assert.equal(await procs.isProcRunningAsync('arma3_x64.exe', true), false);
  assert.equal(await procs.waitProcGone('arma3_x64.exe', 50, 10), false);
  assert.deepEqual(killed, []);
});

test('조회 실패: 이름 있는 스택은 이미지 이름으로 물러서지 않는다', async () => {
  const { procs } = scoped('b', { failList: true, othersActive: false });
  const res = await procs.killProcAsync('arma3_x64.exe');
  assert.equal(res.killed, false);
  assert.equal(await procs.findRunningServerImage('arma3server_x64.exe', true), null);
});

test('captureForTool: 스택 프로세스 목록이 있으면 고른 클라 pid 를 헬퍼에 넘긴다', async () => {
  const { procs } = scoped('b');
  const envs: Record<string, string>[] = [];
  const runner: HelperRunner = async (_exe, env) => {
    envs.push(env);
    return { code: 1, stdout: '', stderr: 'stop here' };
  };
  const c = cfg();
  await captureForTool({ cfg: c, procs, stack: { id: 'b' } as never }, { client: 2 }, { runner });
  assert.equal(envs[0]?.ARMA_CAP_PID, '203');
  assert.equal(envs[0]?.ARMA_CAP_PROC, 'arma3_x64.exe');

  await captureForTool({ cfg: c, procs }, { target: 'server' }, { runner });
  assert.equal(envs[1]?.ARMA_CAP_PID, '201');

  const missing = await captureForTool({ cfg: c, procs, stack: { id: 'b' } as never }, { client: 4 }, { runner });
  assert.equal(missing.meta.ok, false);
  assert.match(String(missing.meta.error), /스택 b 의 클라 4/);
  assert.equal(envs.length, 2, '없는 클라는 헬퍼를 부르지 않는다');
});
