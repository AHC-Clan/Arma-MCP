// stack.test.ts — 테스트 스택의 이름, 경로, 설정 사본, 목록, 도구 쪽 해석.
//
// 게임 파이프는 열지 않는다. 목록 테스트는 가짜 번들과 가짜 포트 검사로 돈다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  resolveRptDir,
  resolveServerProfilesDir,
  type Config,
} from '../src/config.js';
import {
  DEFAULT_STACK_ID,
  defaultStackContext,
  namedStackContext,
  stackCfg,
  suffixTemplate,
  validateStackId,
  type StackContext,
} from '../src/stack/stackContext.js';
import { StackRegistry } from '../src/stack/stackRegistry.js';
import type { StackBundle } from '../src/stack/stackRuntime.js';
import { removeTreeNoFollow, isStrictlyInside } from '../src/stack/fsSafe.js';
import { resolveStackDeps } from '../src/mcp/stackDeps.js';
import type { Deps } from '../src/mcp/deps.js';
import { createSessionContext } from '../src/mcp/session.js';
import { OperationCoordinator } from '../src/launch/operationCoordinator.js';

function cfgWith(extra: Record<string, unknown> = {}): Config {
  const dir = mkdtempSync(path.join(tmpdir(), 'arma-mcp-stack-'));
  const file = path.join(dir, 'cfg.json');
  writeFileSync(
    file,
    JSON.stringify({ stacks: { root: path.join(dir, 'stacks') }, ...extra }),
    'utf8',
  );
  return loadConfig(file, { quiet: true });
}

test('validateStackId: 빈 값과 default 는 default, 규칙 밖과 장치명은 거절', () => {
  assert.deepEqual(validateStackId(undefined), { ok: true, id: DEFAULT_STACK_ID });
  assert.deepEqual(validateStackId(''), { ok: true, id: DEFAULT_STACK_ID });
  assert.deepEqual(validateStackId('default'), { ok: true, id: DEFAULT_STACK_ID });
  assert.deepEqual(validateStackId('a'), { ok: true, id: 'a' });
  assert.deepEqual(validateStackId('b_2'), { ok: true, id: 'b_2' });
  for (const bad of ['A', '_a', 'a-b', 'a.b', 'a b', 'x'.repeat(17), '../x', 'nul', 'com1', 'lpt9']) {
    assert.equal(validateStackId(bad).ok, false, bad);
  }
});

test('defaultStackContext: 0.4 경로와 포트와 파이프를 그대로 쓴다', () => {
  const cfg = cfgWith({ mp: { port: 2402 } });
  const ctx = defaultStackContext(cfg);
  assert.equal(ctx.isDefault, true);
  assert.equal(ctx.port, 2402);
  assert.equal(ctx.pipeName, cfg.pipeName);
  assert.equal(ctx.serverProfilesDir, resolveServerProfilesDir(cfg));
  assert.equal(ctx.clientRptDir(1), resolveRptDir(cfg));
  assert.equal(ctx.clientProfilesDir(1), null);
  assert.equal(ctx.clientName(1), null);
  assert.equal(ctx.clientProfilesDir(2), path.join(ctx.root, 'client2'));
  assert.equal(ctx.clientName(2), 'default_c2');
  assert.equal(ctx.templateFor('m.VR'), 'm.VR');
  assert.equal(stackCfg(cfg, ctx), cfg);
});

test('namedStackContext: 모든 경로가 스택 폴더 아래이고 설정 사본이 스택 값을 쓴다', () => {
  const cfg = cfgWith();
  const ctx = namedStackContext(cfg, 'b', 2312);
  assert.equal(ctx.pipeName, cfg.pipeName + '_s_b');
  assert.equal(ctx.clientProfilesDir(1), path.join(ctx.root, 'client1'));
  assert.equal(ctx.clientRptDir(2), path.join(ctx.root, 'client2'));
  assert.equal(ctx.clientName(1), 'b_c1');
  assert.equal(ctx.serverProfilesDir, path.join(ctx.root, 'server', 'profiles'));
  assert.equal(ctx.scaffoldDir, path.join(ctx.root, 'missions'));
  const sc = stackCfg(cfg, ctx);
  assert.notEqual(sc, cfg);
  assert.equal(sc.mp.port, 2312);
  assert.equal(sc.mp.profilesDir, ctx.serverProfilesDir);
  assert.equal(sc.rptDir, ctx.clientRptDir(1));
  assert.equal(sc.pipeName, ctx.pipeName);
  assert.equal(sc.tcp.enabled, false);
  // 원본은 그대로다.
  assert.equal(cfg.mp.port, 2302);
});

test('suffixTemplate: world 앞에 스택 이름을 넣는다', () => {
  assert.equal(suffixTemplate('mcp_play.VR', 'b'), 'mcp_play__b.VR');
  assert.equal(suffixTemplate('my.mission.Altis', 'b'), 'my.mission__b.Altis');
  assert.equal(suffixTemplate('mcp_play.VR.pbo', 'b'), 'mcp_play__b.VR.pbo');
  assert.equal(suffixTemplate('noworld', 'b'), 'noworld__b');
});

// ── 목록 ──

function fakeBundle(cfg: Config, ctx: StackContext, log: string[]): StackBundle {
  return {
    ctx,
    cfg: stackCfg(cfg, ctx),
    rptDir: ctx.clientRptDir(1),
    operationCoordinator: new OperationCoordinator(),
    async start() {
      log.push(`start ${ctx.id}`);
    },
    async stop() {
      log.push(`stop ${ctx.id}`);
    },
  } as unknown as StackBundle;
}

function registryFor(cfg: Config, opts: { busy?: number[] } = {}) {
  const log: string[] = [];
  const probed: number[] = [];
  const main = fakeBundle(cfg, defaultStackContext(cfg), log);
  const registry = new StackRegistry(cfg, main, {
    probePort: async (port) => {
      probed.push(port);
      return !(opts.busy ?? []).includes(port);
    },
    createBundle: (c, ctx) => fakeBundle(c, ctx, log),
  });
  return { registry, log, probed, main };
}

test('StackRegistry.ensure: 포트를 골라 한 번만 만들고 stack.json 을 쓴다', async () => {
  const cfg = cfgWith();
  const { registry, log } = registryFor(cfg, { busy: [2312] });
  const [a, b] = await Promise.all([registry.ensure('b'), registry.ensure('b')]);
  assert.ok(a.ok && b.ok);
  assert.equal(a.bundle, b.bundle);
  assert.equal([a.created, b.created].filter(Boolean).length, 1);
  assert.equal(a.bundle.ctx.port, 2322, '막힌 2312 를 건너뛴다');
  assert.deepEqual(log, ['start b']);
  const record = JSON.parse(readFileSync(path.join(a.bundle.ctx.root, 'stack.json'), 'utf8'));
  assert.equal(record.id, 'b');
  assert.equal(record.port, 2322);
  assert.deepEqual(
    registry.list().map((x) => x.ctx.id),
    ['default', 'b'],
  );
});

test('StackRegistry.ensure: 다른 스택이 쓰는 포트를 다시 고르지 않고 상한을 지킨다', async () => {
  const cfg = cfgWith({ stacks: { max: 2 } });
  // stacks.root 를 덮어썼으니 임시 폴더를 다시 준다.
  cfg.stacks.root = mkdtempSync(path.join(tmpdir(), 'arma-mcp-stacks-'));
  const { registry } = registryFor(cfg);
  const a = await registry.ensure('a');
  const b = await registry.ensure('b');
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.bundle.ctx.port, b.bundle.ctx.port);
  const c = await registry.ensure('c');
  assert.equal(c.ok, false);
  assert.match(!c.ok ? c.error : '', /stacks\.max=2/);
  const bad = await registry.ensure('Bad');
  assert.equal(bad.ok, false);
});

test('StackRegistry.loadPersisted: 적어 둔 스택을 같은 포트로 다시 연다', async () => {
  const cfg = cfgWith();
  const first = registryFor(cfg);
  const made = await first.registry.ensure('b');
  assert.ok(made.ok);
  const second = registryFor(cfg);
  const loaded = await second.registry.loadPersisted();
  assert.deepEqual(loaded, ['b']);
  assert.equal(second.registry.get('b')?.ctx.port, made.bundle.ctx.port);
  assert.deepEqual(second.log, ['start b']);
});

test('StackRegistry.forget: 파이프를 닫고 폴더를 지우며 default 는 거절한다', async () => {
  const cfg = cfgWith();
  const { registry, log } = registryFor(cfg);
  const made = await registry.ensure('b');
  assert.ok(made.ok);
  const root = made.bundle.ctx.root;
  assert.ok(existsSync(root));
  const res = await registry.forget('b');
  assert.equal(res.ok, true);
  assert.equal(existsSync(root), false);
  assert.equal(registry.get('b'), undefined);
  assert.deepEqual(log, ['start b', 'stop b']);
  assert.equal((await registry.forget('default')).ok, false);
});

test('removeTreeNoFollow: 하드링크를 지워도 원본은 남고, 상위 밖은 지우지 않는다', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'arma-mcp-fs-'));
  const original = path.join(base, 'mods', '@big', 'addons');
  mkdirSync(original, { recursive: true });
  writeFileSync(path.join(original, 'a.pbo'), 'A');
  const stacks = path.join(base, 'stacks');
  const overlay = path.join(stacks, 'b', 'overlay', '@big', 'addons');
  mkdirSync(overlay, { recursive: true });
  linkSync(path.join(original, 'a.pbo'), path.join(overlay, 'a.pbo'));

  await removeTreeNoFollow(path.join(stacks, 'b'), stacks);
  assert.equal(existsSync(path.join(stacks, 'b')), false);
  assert.equal(readFileSync(path.join(original, 'a.pbo'), 'utf8'), 'A');

  await assert.rejects(removeTreeNoFollow(path.join(base, 'mods'), stacks), /밖이다/);
  await assert.rejects(removeTreeNoFollow(stacks, stacks), /밖이다/);
  assert.ok(existsSync(original));
  assert.equal(isStrictlyInside(path.join(stacks, 'x'), stacks), true);
  assert.equal(isStrictlyInside(stacks + 'x', stacks), false);
});

// ── 도구 쪽 해석 ──

function depsWith(registry?: StackRegistry): Deps {
  return {
    session: createSessionContext('relay'),
    stacks: registry,
  } as unknown as Deps;
}

test('resolveStackDeps: 없음과 default 는 같은 객체, 모르는 스택은 오류', async () => {
  const cfg = cfgWith();
  const { registry } = registryFor(cfg);
  const deps = depsWith(registry);
  const a = await resolveStackDeps(deps, undefined);
  const b = await resolveStackDeps(deps, 'default');
  assert.ok(a.ok && b.ok);
  assert.equal(a.deps, deps);
  assert.equal(b.deps, deps);

  const unknown = await resolveStackDeps(deps, 'zzz');
  assert.equal(unknown.ok, false);
  assert.match(!unknown.ok ? unknown.result.content[0]!.text : '', /모르는 스택: zzz/);

  const bad = await resolveStackDeps(deps, 'A-B', { create: true });
  assert.equal(bad.ok, false);

  const none = await resolveStackDeps(depsWith(undefined), 'b', { create: true });
  assert.equal(none.ok, false);
});

test('resolveStackDeps: create 는 스택을 만들고 exec 커서를 스택별로 나눈다', async () => {
  const cfg = cfgWith();
  const { registry } = registryFor(cfg);
  const deps = depsWith(registry);
  const made = await resolveStackDeps(deps, 'b', { create: true });
  assert.ok(made.ok);
  assert.equal(made.created, true);
  assert.equal(made.deps.stack?.id, 'b');
  assert.equal(made.deps.cfg.mp.port, made.deps.stack?.port);

  const cursor = { file: 'b.rpt', offset: 10 };
  made.deps.session.lastExecCursor = cursor;
  assert.deepEqual(made.deps.session.lastExecCursor, cursor);
  assert.equal(deps.session.lastExecCursor, null, 'default 커서는 그대로');
  assert.equal(made.deps.session.id, deps.session.id);

  const again = await resolveStackDeps(deps, 'b');
  assert.ok(again.ok);
  assert.equal(again.created, false);
  assert.deepEqual(again.deps.session.lastExecCursor, cursor);
});
