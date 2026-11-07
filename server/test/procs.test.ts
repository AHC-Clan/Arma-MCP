// procs.test.ts — waitPathsWritable 잠금 해제 대기 단위 테스트.
//
// 실제 잠금은 다른 프로세스가 있어야 재현되므로 open 을 가짜로 바꿔 끼워 오류 코드를 흉내 낸다.
// 디렉터리 펼치기와 기본 open 은 임시 폴더의 실제 파일로 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  KILL_WAIT_MS,
  waitPathsWritable,
  waitProcGone,
  type OpenForProbe,
} from '../src/procs.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'arma-mcp-unlock-'));
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: fake`), { code });
}

/** 파일별로 정해 둔 오류를 차례로 던지고, 다 쓰면 연다. 연 파일과 플래그를 기록한다. */
function scriptedOpen(script: Record<string, string[]>): {
  open: OpenForProbe;
  calls: { file: string; flags: string }[];
} {
  const calls: { file: string; flags: string }[] = [];
  const left = new Map(Object.entries(script).map(([k, v]) => [path.resolve(k), [...v]]));
  const open: OpenForProbe = async (file, flags) => {
    calls.push({ file, flags });
    const queue = left.get(path.resolve(file));
    const code = queue?.shift();
    if (code) throw errno(code);
    return { close: async () => {} };
  };
  return { open, calls };
}

test('KILL_WAIT_MS 는 15초다', () => {
  assert.equal(KILL_WAIT_MS, 15000);
});

test('waitPathsWritable: EBUSY 두 번 뒤 풀리면 ok 이고 r+ 로만 연다', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'demo.pbo');
  writeFileSync(file, 'pbo');
  const { open, calls } = scriptedOpen({ [file]: ['EBUSY', 'EBUSY'] });

  const [res] = await waitPathsWritable([file], { timeoutMs: 2000, pollMs: 20, open });
  assert.equal(res?.ok, true);
  assert.equal(res?.path, file);
  assert.equal(res?.code, undefined);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.flags === 'r+'));
  assert.ok(res!.waitedMs >= 30, `두 번 쉬어야 한다 (${res!.waitedMs}ms)`);
});

test('waitPathsWritable: 시간 안에 풀리지 않으면 EBUSY 실패', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'locked.pbo');
  writeFileSync(file, 'pbo');
  const { open } = scriptedOpen({ [file]: Array(1000).fill('EBUSY') });

  const [res] = await waitPathsWritable([file], { timeoutMs: 120, pollMs: 20, open });
  assert.equal(res?.ok, false);
  assert.equal(res?.code, 'EBUSY');
  assert.match(res!.reason!, /locked\.pbo/);
  assert.ok(res!.waitedMs >= 100, `상한까지 기다려야 한다 (${res!.waitedMs}ms)`);
});

test('waitPathsWritable: 준 경로가 없으면 ENOENT 실패이고 열지 않는다', async () => {
  const dir = tempDir();
  const { open, calls } = scriptedOpen({});
  const [res] = await waitPathsWritable([path.join(dir, 'missing', '@mod')], {
    timeoutMs: 1000,
    open,
  });
  assert.equal(res?.ok, false);
  assert.equal(res?.code, 'ENOENT');
  assert.equal(calls.length, 0);
});

test('waitPathsWritable: EPERM 은 기다리지 않고 바로 쓰기 불가로 실패', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'readonly.pbo');
  writeFileSync(file, 'pbo');
  const { open, calls } = scriptedOpen({ [file]: ['EPERM'] });
  const t0 = Date.now();
  const [res] = await waitPathsWritable([file], { timeoutMs: 5000, pollMs: 20, open });
  assert.deepEqual(
    { ok: res?.ok, code: res?.code, reason: res?.reason },
    { ok: false, code: 'EPERM', reason: '쓰기 불가' },
  );
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - t0 < 1000);
});

test('waitPathsWritable: EACCES 도 바로 쓰기 불가로 실패', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'denied.dll');
  writeFileSync(file, 'dll');
  const { open } = scriptedOpen({ [file]: ['EACCES'] });
  const [res] = await waitPathsWritable([file], { timeoutMs: 5000, pollMs: 20, open });
  assert.equal(res?.ok, false);
  assert.equal(res?.code, 'EACCES');
  assert.equal(res?.reason, '쓰기 불가');
});

test('waitPathsWritable: 디렉터리는 그 안과 addons 안의 pbo, dll 로 펼친다', async () => {
  const mod = tempDir();
  writeFileSync(path.join(mod, 'arma_mcp_x64.dll'), 'dll');
  writeFileSync(path.join(mod, 'mod.cpp'), 'cpp');
  mkdirSync(path.join(mod, 'addons'));
  writeFileSync(path.join(mod, 'addons', 'core.pbo'), 'pbo');
  writeFileSync(path.join(mod, 'addons', 'core.pbo.demo.bisign'), 'sig');
  writeFileSync(path.join(mod, 'addons', 'UPPER.PBO'), 'pbo');
  mkdirSync(path.join(mod, 'addons', 'nested'));
  writeFileSync(path.join(mod, 'addons', 'nested', 'deep.pbo'), 'pbo');
  const { open, calls } = scriptedOpen({ [path.join(mod, 'addons', 'core.pbo')]: ['EBUSY'] });

  const [res] = await waitPathsWritable([mod], { timeoutMs: 2000, pollMs: 20, open });
  assert.equal(res?.ok, true);
  assert.equal(res?.path, mod);
  const opened = [...new Set(calls.map((c) => path.relative(mod, c.file)))].sort();
  assert.deepEqual(opened, [
    path.join('addons', 'UPPER.PBO'),
    path.join('addons', 'core.pbo'),
    'arma_mcp_x64.dll',
  ]);
});

test('waitPathsWritable: 기다리는 사이 사라진 파일은 풀린 것으로 친다', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'gone.pbo');
  writeFileSync(file, 'pbo');
  const { open } = scriptedOpen({ [file]: ['EBUSY', 'ENOENT'] });
  const [res] = await waitPathsWritable([file], { timeoutMs: 2000, pollMs: 20, open });
  assert.equal(res?.ok, true);
});

test('waitPathsWritable: 경로마다 결과를 준 순서대로 돌려준다', async () => {
  const dir = tempDir();
  const free = path.join(dir, 'free.pbo');
  const denied = path.join(dir, 'denied.pbo');
  writeFileSync(free, 'pbo');
  writeFileSync(denied, 'pbo');
  const { open } = scriptedOpen({ [denied]: ['EPERM'] });
  const res = await waitPathsWritable([free, path.join(dir, 'nope.pbo'), denied], {
    timeoutMs: 500,
    pollMs: 20,
    open,
  });
  assert.deepEqual(
    res.map((r) => [path.basename(r.path), r.ok, r.code]),
    [
      ['free.pbo', true, undefined],
      ['nope.pbo', false, 'ENOENT'],
      ['denied.pbo', false, 'EPERM'],
    ],
  );
});

test('waitPathsWritable: 기본 open 은 파일 내용과 수정 시각을 바꾸지 않는다', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'real.pbo');
  writeFileSync(file, 'original bytes');
  const before = statSync(file).mtimeMs;
  const [res] = await waitPathsWritable([file], { timeoutMs: 1000 });
  assert.equal(res?.ok, true);
  assert.equal(readFileSync(file, 'utf8'), 'original bytes');
  assert.equal(statSync(file).mtimeMs, before);
});

test('waitPathsWritable: timeoutMs 0 이면 한 번만 확인한다', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'once.pbo');
  writeFileSync(file, 'pbo');
  const { open, calls } = scriptedOpen({ [file]: ['EBUSY', 'EBUSY'] });
  const [res] = await waitPathsWritable([file], { timeoutMs: 0, pollMs: 20, open });
  assert.equal(res?.ok, false);
  assert.equal(res?.code, 'EBUSY');
  assert.equal(calls.length, 1);
});

test('waitPathsWritable: signal 이 걸리면 상한을 기다리지 않고 ABORTED 로 돌려준다', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'held.pbo');
  const free = path.join(dir, 'free.pbo');
  writeFileSync(file, 'pbo');
  writeFileSync(free, 'pbo');
  const { open } = scriptedOpen({ [file]: Array(1000).fill('EBUSY') });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const startedAt = Date.now();
  const [held, released] = await waitPathsWritable([file, free], {
    timeoutMs: 30_000,
    pollMs: 200,
    open,
    signal: controller.signal,
  });
  assert.ok(Date.now() - startedAt < 2000, `상한 30초를 기다리면 안 된다 (${Date.now() - startedAt}ms)`);
  assert.equal(held?.ok, false);
  assert.equal(held?.code, 'ABORTED');
  assert.match(held!.reason!, /held\.pbo/);
  assert.equal(released?.ok, true, '이미 풀린 경로는 그대로 ok 다');
});

test('waitProcGone: 이미 걸린 signal 이면 프로세스를 조회하지 않고 false 다', async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  assert.equal(await waitProcGone('arma3_x64.exe', 30_000, 150, controller.signal), false);
  assert.ok(Date.now() - startedAt < 100, 'tasklist 를 부르지 않아야 한다');
});
