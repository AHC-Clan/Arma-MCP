// killTool.test.ts — arma_kill 핸들러 유닛 (프로세스와 게임 불필요).
//
// mpLauncher.killMp 를 흉내 내어 핸들러가 인자를 그대로 넘기는지, ok 를 killSucceeded 로 내는지,
// 선점한 작업을 interruptedOperation 으로 싣는지 본다. 입력 범위는 SDK 왕복으로 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  OperationCoordinator,
  type OperationSnapshot,
} from '../src/launch/operationCoordinator.js';
import { killSucceeded, type KillMpOptions, type KillMpResult } from '../src/launch/mpLauncher.js';
import type { Deps, ToolHost } from '../src/mcp/deps.js';
import { createSessionContext } from '../src/mcp/session.js';
import { registerLaunchTools } from '../src/mcp/tools/launch.js';

type Block = { type: string; text?: string };
type Handler = (args: Record<string, unknown>, extra?: unknown) => Promise<{ content: Block[] }>;

/** 등록된 핸들러를 모아 두는 ToolHost. 스키마 검증 없이 핸들러를 바로 부른다. */
function fakeHost(): { host: ToolHost; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const host = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as ToolHost;
  return { host, handlers };
}

interface KillCall {
  target: string;
  opts: KillMpOptions;
  /** killMp 가 도는 동안의 lease 스냅샷. */
  during: OperationSnapshot | null;
}

function makeDeps(
  result: KillMpResult,
  coordinator = new OperationCoordinator(),
): { deps: Deps; calls: KillCall[]; coordinator: OperationCoordinator } {
  const calls: KillCall[] = [];
  const deps = {
    operationCoordinator: coordinator,
    session: createSessionContext('relay', 'abcd1234-0000-0000-0000-000000000000'),
    mpLauncher: {
      killMp: async (target: string, opts: KillMpOptions) => {
        calls.push({ target, opts, during: coordinator.snapshot() });
        return result;
      },
    },
  } as unknown as Deps;
  return { deps, calls, coordinator };
}

function killHandler(deps: Deps): Handler {
  const { host, handlers } = fakeHost();
  registerLaunchTools(host, deps);
  return handlers.get('arma_kill')!;
}

function json(res: { content: Block[] }): Record<string, unknown> {
  assert.equal(res.content.length, 1);
  return JSON.parse(String(res.content[0]?.text)) as Record<string, unknown>;
}

const GONE: KillMpResult = {
  client: { killed: true, gone: true, waitedMs: 420, detail: 'arma3_x64.exe 강제 종료' },
  server: { killed: false, gone: true, waitedMs: 0, detail: 'arma3server_x64.exe 미실행' },
  unlock: [{ path: 'D:\\mods\\@demo\\addons', ok: true, waitedMs: 610 }],
};

test('arma_kill: target, waitMs, unlockPaths 를 killMp 에 그대로 넘기고 ok 를 싣는다', async () => {
  const { deps, calls, coordinator } = makeDeps(GONE);
  const out = json(
    await killHandler(deps)({
      target: 'client',
      waitMs: 2500,
      unlockPaths: ['D:\\mods\\@demo\\addons'],
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.target, 'client');
  const { signal, ...opts } = calls[0]!.opts;
  assert.deepEqual(opts, { waitMs: 2500, unlockPaths: ['D:\\mods\\@demo\\addons'] });
  assert.ok(signal instanceof AbortSignal, '대기를 멈출 신호를 넘긴다');
  assert.equal(signal.aborted, false);
  // 종료하는 동안 lease 주인은 호출한 세션이다.
  assert.equal(calls[0]!.during?.operation, 'arma_kill');
  assert.deepEqual(calls[0]!.during?.owner, { session: 'abcd1234', transport: 'relay' });

  assert.equal(out.ok, true);
  assert.equal(out.ok, killSucceeded(GONE));
  assert.deepEqual(out.client, GONE.client);
  assert.deepEqual(out.server, GONE.server);
  assert.deepEqual(out.unlock, GONE.unlock);
  assert.equal(out.interruptedOperation, null);
  assert.equal(coordinator.snapshot(), null, '끝나면 lease 를 놓는다');
});

test('arma_kill: 인자를 생략하면 target all 이고 대기값은 killMp 의 기본값에 맡긴다', async () => {
  const { deps, calls } = makeDeps({});
  await killHandler(deps)({});
  assert.equal(calls[0]!.target, 'all');
  const { signal: _signal, ...opts } = calls[0]!.opts;
  assert.deepEqual(opts, { waitMs: undefined, unlockPaths: undefined });
});

/** 대기 신호가 걸릴 때까지 돌아오지 않는 killMp. 취소가 대기를 멈추는지 본다. */
function waitingDeps(coordinator = new OperationCoordinator()): {
  deps: Deps;
  started: Promise<AbortSignal>;
  coordinator: OperationCoordinator;
} {
  let seen: (signal: AbortSignal) => void = () => undefined;
  const started = new Promise<AbortSignal>((resolve) => {
    seen = resolve;
  });
  const deps = {
    operationCoordinator: coordinator,
    session: createSessionContext('cli', 'abcd1234-0000-0000-0000-000000000000'),
    mpLauncher: {
      killMp: (_target: string, opts: KillMpOptions) =>
        new Promise<KillMpResult>((resolve, reject) => {
          const signal = opts.signal;
          if (!signal) {
            reject(new Error('arma_kill must pass a signal to killMp'));
            return;
          }
          seen(signal);
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                client: { killed: true, gone: false, waitedMs: 50, detail: 'arma3_x64.exe 강제 종료' },
                unlock: [
                  { path: 'D:\\mods\\@demo', ok: false, waitedMs: 50, code: 'ABORTED', reason: '대기를 중단했다' },
                ],
              }),
            { once: true },
          );
        }),
    },
  } as unknown as Deps;
  return { deps, started, coordinator };
}

test('arma_kill: 호출을 취소하면 대기를 멈추고 lease 를 푼다', async () => {
  const { deps, started, coordinator } = waitingDeps();
  const request = new AbortController();
  const pending = killHandler(deps)({ waitMs: 60000, unlockPaths: ['D:\\mods\\@demo'] }, {
    signal: request.signal,
  });
  const signal = await started;
  assert.equal(coordinator.snapshot()?.operation, 'arma_kill');
  request.abort();
  const out = json(await pending);
  assert.equal(signal.aborted, true);
  assert.equal(out.ok, false, '확인하지 못한 종료와 잠금은 성공이 아니다');
  assert.equal(coordinator.snapshot(), null, '취소된 kill 은 lease 를 놓는다');
});

test('arma_kill: 세션이 닫혀도 대기를 멈추고 lease 를 푼다', async () => {
  const { deps, started, coordinator } = waitingDeps();
  const pending = killHandler(deps)({ waitMs: 60000 });
  await started;
  deps.session.abortController.abort(new Error('client session closed'));
  await pending;
  assert.equal(coordinator.snapshot(), null);
});

test('arma_kill: 남은 프로세스나 잠긴 경로가 있으면 ok 는 false 다', async () => {
  const cases: KillMpResult[] = [
    { client: { killed: true, gone: false, waitedMs: 15000, detail: 'arma3_x64.exe 강제 종료' } },
    {
      client: { killed: false, gone: false, waitedMs: 0, detail: 'taskkill 실패: 액세스가 거부되었습니다.' },
    },
    {
      client: { killed: true, gone: true, waitedMs: 300, detail: 'arma3_x64.exe 강제 종료' },
      unlock: [{ path: 'D:\\mods\\@demo', ok: false, waitedMs: 14700, code: 'EBUSY', reason: '잠김' }],
    },
  ];
  for (const res of cases) {
    const { deps } = makeDeps(res);
    const out = json(await killHandler(deps)({ target: 'client' }));
    assert.equal(out.ok, false);
    assert.equal(out.ok, killSucceeded(res));
  }
});

test('arma_kill: 다른 세션의 arma_play 를 선점하고 interruptedOperation 에 주인을 싣는다', async () => {
  const coordinator = new OperationCoordinator();
  const play = coordinator.tryAcquire('arma_play', { session: 'ffff0000', transport: 'relay' });
  assert.equal(play.acquired, true);
  if (!play.acquired) return;

  const { deps } = makeDeps(GONE, coordinator);
  const out = json(await killHandler(deps)({}));
  const interrupted = out.interruptedOperation as Record<string, unknown>;
  assert.equal(interrupted.operation, 'arma_play');
  assert.deepEqual(interrupted.owner, { session: 'ffff0000', transport: 'relay' });
  assert.equal(play.lease.signal.aborted, true);
  assert.equal(out.ok, true);
});

test('SDK 왕복: waitMs 와 unlockPaths 의 범위를 넘으면 종료하기 전에 거부된다', async () => {
  const { deps, calls } = makeDeps(GONE);
  const server = new McpServer({ name: 'test', version: '0' });
  registerLaunchTools(server, deps);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test-client', version: '0' });
  await client.connect(clientSide);
  try {
    const bad = [
      { waitMs: 60001 },
      { waitMs: -1 },
      { waitMs: 1.5 },
      { unlockPaths: Array.from({ length: 33 }, (_, i) => `D:\\mods\\@m${i}`) },
    ];
    for (const args of bad) {
      const res = (await client
        .callTool({ name: 'arma_kill', arguments: args })
        .catch(() => ({ isError: true, content: [] }))) as { isError?: boolean };
      assert.equal(res.isError, true, `거부해야 한다: ${JSON.stringify(args).slice(0, 40)}`);
    }
    assert.equal(calls.length, 0, '잘못된 인자로는 프로세스를 건드리지 않는다');

    const edge = (await client.callTool({
      name: 'arma_kill',
      arguments: {
        waitMs: 60000,
        unlockPaths: Array.from({ length: 32 }, (_, i) => `D:\\mods\\@m${i}`),
      },
    })) as { content: Block[]; isError?: boolean };
    assert.notEqual(edge.isError, true);
    assert.equal(json(edge).ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.opts.waitMs, 60000);
    assert.equal(calls[0]!.opts.unlockPaths?.length, 32);
  } finally {
    await client.close();
    await server.close();
  }
});

test('arma_kill preempt:false: 다른 세션의 작업이 돌면 종료하지 않고 busy 로 주인을 알린다', async () => {
  const coordinator = new OperationCoordinator();
  const play = coordinator.tryAcquire('arma_play', { session: 'ffff0000', transport: 'relay' });
  assert.equal(play.acquired, true);
  if (!play.acquired) return;

  const { deps, calls } = makeDeps(GONE, coordinator);
  const out = json(await killHandler(deps)({ preempt: false }));
  assert.equal(out.ok, false);
  const busy = out.busy as Record<string, unknown>;
  assert.equal(busy.operation, 'arma_play');
  assert.deepEqual(busy.owner, { session: 'ffff0000', transport: 'relay' });
  assert.equal(busy.mine, undefined, '다른 세션의 lease 다');
  assert.equal(calls.length, 0, '프로세스를 건드리지 않는다');
  assert.equal(play.lease.signal.aborted, false, '실행 중인 작업을 끊지 않는다');
  assert.equal(coordinator.snapshot()?.operation, 'arma_play');
});

test('arma_kill preempt:false: lease 가 비었거나 자기 세션의 것이면 평소처럼 종료한다', async () => {
  const idle = makeDeps(GONE);
  const idleOut = json(await killHandler(idle.deps)({ preempt: false }));
  assert.equal(idleOut.ok, true);
  assert.equal(idle.calls.length, 1);
  assert.equal(idleOut.interruptedOperation, null);

  const coordinator = new OperationCoordinator();
  const own = makeDeps(GONE, coordinator);
  const play = coordinator.tryAcquire('arma_play', {
    session: own.deps.session.shortId,
    transport: 'relay',
  });
  assert.equal(play.acquired, true);
  if (!play.acquired) return;
  const ownOut = json(await killHandler(own.deps)({ preempt: false }));
  assert.equal(ownOut.ok, true);
  assert.equal(own.calls.length, 1);
  assert.equal((ownOut.interruptedOperation as Record<string, unknown>).operation, 'arma_play');
  assert.equal(play.lease.signal.aborted, true);
});

test('arma_kill preempt:true: 기본값과 같이 다른 세션의 작업을 끊는다', async () => {
  const coordinator = new OperationCoordinator();
  const play = coordinator.tryAcquire('arma_play', { session: 'ffff0000', transport: 'cli' });
  assert.equal(play.acquired, true);
  if (!play.acquired) return;
  const { deps, calls } = makeDeps(GONE, coordinator);
  const out = json(await killHandler(deps)({ preempt: true }));
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(play.lease.signal.aborted, true);
});
