// selfupdate.test.ts — 세션 시작 자동 업데이트의 계약.
//
// 판정은 순수 함수로 분리돼 있고 파일·git·호스트 CLI 는 전부 주입되므로,
// 이 파일은 네트워크를 한 번도 쓰지 않고 실제 실행될 명령 시퀀스까지 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearNotice,
  cooldownMs,
  isSafeCliName,
  isSafeRemoteUrl,
  isSafeScope,
  pendingNotice,
  planInstallStage,
  planRemoteStage,
  selfUpdateSuppressed,
  shouldCheckRemote,
  urlMismatchNotice,
  type SelfUpdateCache,
} from '../src/selfupdate/plan.js';
import {
  detectHost,
  isUnderPath,
  parseCachePath,
  parseCodexMarketplace,
  parseCodexMarketplaceList,
} from '../src/selfupdate/hosts.js';
import { performSelfUpdate, type SelfUpdateIo } from '../src/selfupdate/run.js';
import { runSelfUpdateHook, parseSelfUpdateArgs, resolvePluginRoot } from '../src/selfupdate/cli.js';
import { pendingUpdateHint } from '../src/mcp/tools/status.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcIndex = path.join(here, '..', 'src', 'index.ts');

// ---------------------------------------------------------------------------
// 순수 결정 계층
// ---------------------------------------------------------------------------

test('selfUpdateSuppressed: 명시 플래그와 원격 토큰 신호', () => {
  assert.equal(selfUpdateSuppressed({}), false);
  assert.equal(selfUpdateSuppressed({ ARMA_MCP_NO_AUTOUPDATE: '1' }), true);
  assert.equal(selfUpdateSuppressed({ ARMA_MCP_NO_AUTOUPDATE: 'yes' }), true);
  assert.equal(selfUpdateSuppressed({ ARMA_MCP_NO_AUTOUPDATE: '0' }), false);
  assert.equal(selfUpdateSuppressed({ ARMA_MCP_NO_AUTOUPDATE: 'false' }), false);
  // 원격 터널 세션이 서버 컴퓨터의 플러그인을 갈아치우면 안 된다.
  assert.equal(selfUpdateSuppressed({ ARMA_MCP_TOKEN: 'x'.repeat(32) }), true);
});

test('cooldownMs: 기본 6시간, [1,24] 로 클램프', () => {
  const hour = 60 * 60 * 1000;
  assert.equal(cooldownMs({}), 6 * hour);
  assert.equal(cooldownMs({ ARMA_MCP_AUTOUPDATE_COOLDOWN_H: '2' }), 2 * hour);
  assert.equal(cooldownMs({ ARMA_MCP_AUTOUPDATE_COOLDOWN_H: '0.1' }), 1 * hour);
  assert.equal(cooldownMs({ ARMA_MCP_AUTOUPDATE_COOLDOWN_H: '999' }), 24 * hour);
  assert.equal(cooldownMs({ ARMA_MCP_AUTOUPDATE_COOLDOWN_H: 'nope' }), 6 * hour);
});

test('shouldCheckRemote: 쿨다운·최초 실행·버전 변동·시계 역행', () => {
  const cooldown = 1000;
  const base = { cooldownMs: cooldown, installedVersion: '0.3.6' };
  assert.equal(shouldCheckRemote({ ...base, cache: null, now: 5000 }), true);
  assert.equal(shouldCheckRemote({ ...base, cache: {}, now: 5000 }), true);
  assert.equal(
    shouldCheckRemote({ ...base, cache: { lastCheck: 4500, installedVersion: '0.3.6' }, now: 5000 }),
    false,
  );
  assert.equal(
    shouldCheckRemote({ ...base, cache: { lastCheck: 3000, installedVersion: '0.3.6' }, now: 5000 }),
    true,
  );
  // 방금 업데이트가 적용됐으면 직전 판단이 낡았다.
  assert.equal(
    shouldCheckRemote({ ...base, cache: { lastCheck: 4900, installedVersion: '0.3.5' }, now: 5000 }),
    true,
  );
  // 시계가 뒤로 가도 영원히 잠기지 않는다.
  assert.equal(
    shouldCheckRemote({ ...base, cache: { lastCheck: 9000, installedVersion: '0.3.6' }, now: 5000 }),
    true,
  );
});

test('planRemoteStage: 원격 HEAD 가 스냅샷과 같으면 받을 것이 없다', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(planRemoteStage({ remoteSha: sha, snapshotSha: sha, force: false }), {
    kind: 'skip',
    result: 'remote-unchanged',
  });
  assert.deepEqual(planRemoteStage({ remoteSha: sha, snapshotSha: 'b'.repeat(40), force: false }), {
    kind: 'sync',
  });
  assert.deepEqual(planRemoteStage({ remoteSha: null, snapshotSha: sha, force: false }), {
    kind: 'skip',
    result: 'no-remote',
  });
  // 스냅샷이 git 이 아니면 CLI 가 맞추게 둔다.
  assert.deepEqual(planRemoteStage({ remoteSha: sha, snapshotSha: null, force: false }), {
    kind: 'sync',
  });
  assert.deepEqual(planRemoteStage({ remoteSha: sha, snapshotSha: sha, force: true }), {
    kind: 'sync',
  });
});

test('planInstallStage: 마켓플레이스 version 이 설치본보다 높을 때만 설치한다', () => {
  assert.deepEqual(planInstallStage({ installedVersion: '0.3.6', snapshotVersion: '0.3.7' }), {
    kind: 'install',
    toVersion: '0.3.7',
  });
  assert.deepEqual(planInstallStage({ installedVersion: '0.3.6', snapshotVersion: '0.3.6' }), {
    kind: 'skip',
    result: 'up-to-date',
  });
  // 로컬이 더 앞선 경우(개발 중 버전) 다운그레이드하지 않는다.
  assert.deepEqual(planInstallStage({ installedVersion: '0.4.0', snapshotVersion: '0.3.9' }), {
    kind: 'skip',
    result: 'up-to-date',
  });
  assert.deepEqual(planInstallStage({ installedVersion: '0.3.6', snapshotVersion: null }), {
    kind: 'skip',
    result: 'no-marketplace-version',
  });
});

test('화이트리스트: 셸이 없어도 이름·스코프·URL 을 한 겹 더 거른다', () => {
  assert.equal(isSafeCliName('arma-mcp'), true);
  assert.equal(isSafeCliName('ahc'), true);
  assert.equal(isSafeCliName('ahc; rm -rf /'), false);
  assert.equal(isSafeCliName('a b'), false);
  assert.equal(isSafeCliName(''), false);
  assert.equal(isSafeCliName(null), false);

  assert.equal(isSafeScope('user'), true);
  assert.equal(isSafeScope('managed'), true);
  assert.equal(isSafeScope('root'), false);

  assert.equal(isSafeRemoteUrl('http://example.invalid/x.git'), true);
  assert.equal(isSafeRemoteUrl('https://example.invalid/x.git'), true);
  assert.equal(isSafeRemoteUrl('ssh://git@example.invalid/x.git'), true);
  // git 인자로 해석될 수 있는 값과 낯선 스킴은 거부한다.
  assert.equal(isSafeRemoteUrl('--upload-pack=evil'), false);
  assert.equal(isSafeRemoteUrl('-x'), false);
  assert.equal(isSafeRemoteUrl('file:///C:/x'), false);
  assert.equal(isSafeRemoteUrl(''), false);
});

test('pendingNotice/clearNotice: 1회성 알림을 만들고 소비한다', () => {
  const cache: SelfUpdateCache = {
    lastCheck: 1,
    notify: { fromVersion: '0.3.6', toVersion: '0.3.7' },
  };
  const applied = pendingNotice(cache, '0.3.7');
  assert.match(applied, /0\.3\.6 에서 0\.3\.7 로 업데이트/);
  // 재시작 파급을 반드시 알려야 한다.
  assert.match(applied, /reload-plugins/);

  const notYet = pendingNotice(cache, '0.3.6');
  assert.match(notYet, /아직 0\.3\.6/);

  assert.equal(pendingNotice({ lastCheck: 1 }, '0.3.6'), '');
  assert.equal(pendingNotice(null, null), '');

  // message 는 notify 와 함께 실려 나가고 둘 다 소비된다.
  const withMessage = pendingNotice({ ...cache, message: '안내' }, '0.3.7');
  assert.match(withMessage, /안내/);
  const cleared = clearNotice({ ...cache, message: '안내', failStreak: 2 });
  assert.equal(cleared.notify, undefined);
  assert.equal(cleared.message, undefined);
  assert.equal(cleared.failStreak, 2, '나머지 필드는 보존한다');
});

test('urlMismatchNotice: 연속 실패 + 주소 불일치일 때만, 한 번만 알린다', () => {
  const args = {
    knownUrl: 'http://old.invalid/x.git',
    manifestUrl: 'http://new.invalid/x.git',
    marketplace: 'ahc',
    cache: null as SelfUpdateCache | null,
    failStreak: 3,
    recoveryCommands: ['claude plugin marketplace remove ahc'],
  };
  const notice = urlMismatchNotice(args);
  assert.match(notice, /등록됨: http:\/\/old\.invalid/);
  assert.match(notice, /플러그인 명시: http:\/\/new\.invalid/);
  assert.match(notice, /marketplace remove ahc/);

  // 아직 실패가 쌓이지 않았으면 미러·fork 오탐일 수 있다.
  assert.equal(urlMismatchNotice({ ...args, failStreak: 2 }), '');
  // 주소가 같으면 알릴 것이 없다.
  assert.equal(urlMismatchNotice({ ...args, manifestUrl: args.knownUrl }), '');
  // 같은 쌍으로는 반복하지 않는다.
  assert.equal(
    urlMismatchNotice({
      ...args,
      cache: { urlNotice: { known: args.knownUrl, manifest: args.manifestUrl } },
    }),
    '',
  );
});

test('pendingUpdateHint: 받아둔 버전이 실행 중 버전보다 높을 때만 안내한다', () => {
  assert.match(
    pendingUpdateHint({ lastResult: 'updated', lastAttemptVersion: '0.3.7' }, '0.3.6'),
    /0\.3\.7 을 설치해 뒀습니다/,
  );
  // 적용되고 나면 조건이 저절로 거짓이 된다.
  assert.equal(pendingUpdateHint({ lastResult: 'updated', lastAttemptVersion: '0.3.7' }, '0.3.7'), '');
  assert.equal(pendingUpdateHint({ lastResult: 'up-to-date', lastAttemptVersion: '0.3.7' }, '0.3.6'), '');
  assert.equal(pendingUpdateHint(null, '0.3.6'), '');
});

// ---------------------------------------------------------------------------
// host adapter 판별
// ---------------------------------------------------------------------------

test('isUnderPath: 경로 경계를 지킨다', () => {
  assert.equal(isUnderPath('C:/a/b/c', 'C:/a/b'), true);
  assert.equal(isUnderPath('C:/a/b', 'C:/a/b'), true);
  // '.../ahc' 가 '.../ahc-two' 를 삼키면 안 된다.
  assert.equal(isUnderPath('C:/a/ahc-two', 'C:/a/ahc'), false);
  // Windows 는 대소문자와 구분자가 섞여 온다.
  assert.equal(isUnderPath('C:\\A\\B\\c', 'c:/a/b'), true);
});

test('parseCachePath: <cacheRoot>/<marketplace>/<plugin>/<version> 만 인정한다', () => {
  const root = 'C:/u/.claude/plugins/cache';
  assert.deepEqual(parseCachePath(`${root}/ahc/arma-mcp/0.3.6`, root), {
    marketplace: 'ahc',
    plugin: 'arma-mcp',
    version: '0.3.6',
  });
  assert.equal(parseCachePath(`${root}/ahc/arma-mcp`, root), null);
  assert.equal(parseCachePath(`${root}/ahc/arma-mcp/0.3.6/server`, root), null);
  assert.equal(parseCachePath('C:/repo/Arma-MCP', root), null);
});

test('detectHost: 설치 캐시 안이 아니면 어떤 어댑터도 소유를 주장하지 않는다', () => {
  const claudeHome = 'C:/u/.claude';
  const codexHome = 'C:/u/.codex';
  const env = { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };

  assert.equal(detectHost(`${claudeHome}/plugins/cache/ahc/arma-mcp/0.3.6`, env)?.name, 'claude');
  assert.equal(detectHost(`${codexHome}/plugins/cache/ahc/arma-mcp/0.3.5`, env)?.name, 'codex');
  // 개발 체크아웃은 어느 쪽도 아니다.
  assert.equal(detectHost('E:/src/Arma-MCP', env), null);
});

test('parseCodexMarketplace: 필요한 두 키만 뽑는다', () => {
  const toml = [
    '[marketplaces.other]',
    'source = "http://example.invalid/other.git"',
    '',
    '[marketplaces.ahc]',
    'last_updated = "2026-07-26T11:26:42Z"',
    'source_type = "local"',
    "source = '\\\\?\\E:\\src\\Arma-MCP'",
    '',
    '[plugins."arma-mcp@ahc"]',
    'enabled = true',
  ].join('\n');

  const entry = parseCodexMarketplace(toml, 'ahc');
  assert.equal(entry?.sourceType, 'local');
  assert.equal(entry?.source, '\\\\?\\E:\\src\\Arma-MCP');
  // 다음 섹션의 값을 넘겨받지 않는다.
  assert.equal(parseCodexMarketplace(toml, 'other')?.sourceType, null);
  assert.equal(parseCodexMarketplace(toml, 'missing'), null);
});

test('parseCodexMarketplaceList: MARKETPLACE/ROOT 표에서 루트를 읽는다', () => {
  const stdout = [
    'MARKETPLACE             ROOT',
    'openai-bundled          C:\\Users\\x\\.codex\\.tmp\\bundled',
    'ahc                     E:\\src\\Arma-MCP',
  ].join('\n');
  assert.equal(parseCodexMarketplaceList(stdout, 'ahc'), 'E:\\src\\Arma-MCP');
  assert.equal(parseCodexMarketplaceList(stdout, 'nope'), null);
});

// ---------------------------------------------------------------------------
// performSelfUpdate — io 주입으로 명령 시퀀스까지 검증
// ---------------------------------------------------------------------------

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

interface FakeWorld {
  json: Map<string, unknown>;
  text: Map<string, string>;
  paths: Set<string>;
  cache: SelfUpdateCache | null;
  gitCalls: string[][];
  cliCalls: Array<{ cli: string; args: string[] }>;
}

function key(file: string): string {
  return path.resolve(file).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function makeWorld(): FakeWorld {
  return {
    json: new Map(),
    text: new Map(),
    paths: new Set(),
    cache: null,
    gitCalls: [],
    cliCalls: [],
  };
}

function putJson(world: FakeWorld, file: string, value: unknown): void {
  world.json.set(key(file), value);
  world.paths.add(key(file));
}

interface FakeIoOptions {
  git?: (args: string[]) => { ok: boolean; stdout: string };
  cli?: (cli: string, args: string[], world: FakeWorld) => { ok: boolean; status: number | null };
  lock?: boolean;
  now?: number;
}

function makeIo(world: FakeWorld, opts: FakeIoOptions = {}): SelfUpdateIo {
  return {
    now: () => opts.now ?? 10_000,
    readJson: <T,>(file: string): T | null => (world.json.get(key(file)) as T | undefined) ?? null,
    readText: (file) => world.text.get(key(file)) ?? null,
    exists: (file) => world.paths.has(key(file)),
    hostCli: (cli, args) => {
      world.cliCalls.push({ cli, args });
      const res = opts.cli?.(cli, args, world) ?? { ok: true, status: 0 };
      return { ok: res.ok, status: res.status, stdout: '' };
    },
    git: (args) => {
      world.gitCalls.push(args);
      const res = opts.git?.(args) ?? { ok: false, stdout: '' };
      return { ok: res.ok, status: res.ok ? 0 : 1, stdout: res.stdout };
    },
    readCache: () => world.cache,
    writeCache: (value) => {
      world.cache = value;
      return true;
    },
    acquireLock: () => (opts.lock === false ? null : () => undefined),
  };
}

const CLAUDE_HOME = 'C:/u/.claude';
const CLAUDE_ENV = { CLAUDE_CONFIG_DIR: CLAUDE_HOME };
const CLAUDE_ROOT = `${CLAUDE_HOME}/plugins/cache/ahc/arma-mcp/0.3.6`;
const SNAPSHOT = `${CLAUDE_HOME}/plugins/marketplaces/ahc`;

function seedClaude(
  world: FakeWorld,
  opts: { installed?: string; snapshot?: string | null; sourceUrl?: string | null; repository?: string } = {},
): void {
  const installed = opts.installed ?? '0.3.6';
  putJson(world, `${CLAUDE_ROOT}/.claude-plugin/plugin.json`, {
    name: 'arma-mcp',
    version: installed,
    repository: opts.repository ?? 'http://repo.invalid/Arma-MCP.git',
  });
  putJson(world, `${CLAUDE_HOME}/plugins/known_marketplaces.json`, {
    ahc: {
      source: opts.sourceUrl === null ? {} : { url: opts.sourceUrl ?? 'http://repo.invalid/Arma-MCP.git' },
      installLocation: SNAPSHOT.replace(/\//g, '\\'),
    },
  });
  putJson(world, `${CLAUDE_HOME}/plugins/installed_plugins.json`, {
    plugins: { 'arma-mcp@ahc': [{ scope: 'user', version: installed }] },
  });
  world.paths.add(key(SNAPSHOT));
  if (opts.snapshot !== null) {
    putJson(world, `${SNAPSHOT}/.claude-plugin/marketplace.json`, {
      plugins: [{ name: 'arma-mcp', version: opts.snapshot ?? '0.3.6' }],
    });
  }
}

test('원격 HEAD 가 스냅샷과 같으면 CLI 를 한 번도 부르지 않는다', () => {
  const world = makeWorld();
  seedClaude(world);
  const io = makeIo(world, { git: () => ({ ok: true, stdout: `${SHA_A}\tHEAD` }) });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'remote-unchanged');
  assert.deepEqual(outcome.ran, []);
  assert.equal(world.cliCalls.length, 0);
  assert.equal(world.cache?.lastResult, 'remote-unchanged');
});

test('원격에 새 커밋이 있어도 버전이 그대로면 갱신만 하고 설치하지 않는다', () => {
  const world = makeWorld();
  seedClaude(world);
  const io = makeIo(world, {
    git: (args) => ({ ok: true, stdout: args[0] === 'ls-remote' ? SHA_B : SHA_A }),
  });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'up-to-date');
  assert.deepEqual(outcome.ran, [['plugin', 'marketplace', 'update', 'ahc']]);
  assert.equal(world.cache?.notify, undefined);
});

test('버전이 오르면 갱신 후 설치하고 다음 세션용 알림을 남긴다', () => {
  const world = makeWorld();
  seedClaude(world);
  const io = makeIo(world, {
    git: (args) => ({ ok: true, stdout: args[0] === 'ls-remote' ? SHA_B : SHA_A }),
    cli: (_cli, args, w) => {
      // 갱신이 끝나면 스냅샷 버전이 올라간다.
      if (args[1] === 'marketplace') {
        putJson(w, `${SNAPSHOT}/.claude-plugin/marketplace.json`, {
          plugins: [{ name: 'arma-mcp', version: '0.3.7' }],
        });
      }
      return { ok: true, status: 0 };
    },
  });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'updated');
  assert.equal(outcome.latestVersion, '0.3.7');
  assert.deepEqual(outcome.ran, [
    ['plugin', 'marketplace', 'update', 'ahc'],
    ['plugin', 'update', 'arma-mcp@ahc', '--yes', '--scope', 'user'],
  ]);
  assert.deepEqual(world.cache?.notify, { fromVersion: '0.3.6', toVersion: '0.3.7' });
});

test('스냅샷이 이미 앞서 있으면 git 없이 곧바로 설치한다(자력 복구)', () => {
  const world = makeWorld();
  seedClaude(world, { snapshot: '0.3.7' });
  const io = makeIo(world);

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'updated');
  assert.equal(world.gitCalls.length, 0, '네트워크를 볼 이유가 없다');
  assert.deepEqual(outcome.ran, [['plugin', 'update', 'arma-mcp@ahc', '--yes', '--scope', 'user']]);
});

test('원격에 닿지 못하면 failStreak 만 늘고 CLI 는 돌지 않는다', () => {
  const world = makeWorld();
  world.cache = { failStreak: 1 };
  seedClaude(world);
  const io = makeIo(world, { git: () => ({ ok: false, stdout: '' }) });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'no-remote');
  assert.equal(world.cliCalls.length, 0);
  assert.equal(world.cache?.failStreak, 2);
});

test('연속 실패가 쌓이고 등록 주소가 매니페스트와 다르면 복구 명령을 안내한다', () => {
  const world = makeWorld();
  world.cache = { failStreak: 2 };
  seedClaude(world, {
    sourceUrl: 'http://dead.invalid/Arma-MCP.git',
    repository: 'http://live.invalid/Arma-MCP.git',
  });
  const io = makeIo(world, { git: () => ({ ok: false, stdout: '' }) });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'no-remote');
  assert.match(outcome.notice, /marketplace remove ahc/);
  // 마켓플레이스를 지우면 플러그인도 지워지므로 안내는 다시 설치까지 적어야 한다.
  assert.match(outcome.notice, /plugin (install|add) arma-mcp@ahc/);
  assert.match(outcome.notice, /live\.invalid/);
  // 자동으로 재등록하지 않는다 — 안내만 남긴다.
  assert.equal(world.cliCalls.length, 0);
  assert.equal(world.cache?.message, outcome.notice);
  assert.deepEqual(world.cache?.urlNotice, {
    known: 'http://dead.invalid/Arma-MCP.git',
    manifest: 'http://live.invalid/Arma-MCP.git',
  });
});

test('설치 명령이 실패하면 알림을 남기지 않는다', () => {
  const world = makeWorld();
  seedClaude(world, { snapshot: '0.3.7' });
  const io = makeIo(world, { cli: () => ({ ok: false, status: null }) });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'install-failed');
  assert.equal(world.cache?.notify, undefined);
  // 다음 세션이 Stage 0 에서 다시 시도할 수 있도록 시도 버전은 남긴다.
  assert.equal(world.cache?.lastAttemptVersion, '0.3.7');
});

test('위험한 원격 URL 은 git 을 실행하지 않고 거부한다', () => {
  const world = makeWorld();
  seedClaude(world, { sourceUrl: '--upload-pack=evil' });
  const io = makeIo(world);

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'unsafe-name');
  assert.equal(world.gitCalls.length, 0);
  assert.equal(world.cliCalls.length, 0);
});

test('다른 프로세스가 확인 중이면 아무 것도 하지 않는다', () => {
  const world = makeWorld();
  seedClaude(world, { snapshot: '0.3.7' });
  const io = makeIo(world, { lock: false });

  const outcome = performSelfUpdate({ pluginRoot: CLAUDE_ROOT, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'busy');
  assert.equal(world.cliCalls.length, 0);
});

test('개발 체크아웃은 작업 트리를 건드리지 않도록 건너뛴다', () => {
  const world = makeWorld();
  const repo = 'E:/src/Arma-MCP';
  world.paths.add(key(`${repo}/.git`));
  const io = makeIo(world);

  const outcome = performSelfUpdate({ pluginRoot: repo, env: CLAUDE_ENV, io });

  assert.equal(outcome.result, 'dev-checkout');
  assert.equal(world.cliCalls.length, 0);
  assert.equal(world.gitCalls.length, 0);
});

test('억제 신호가 있으면 상태 파일조차 만들지 않는다', () => {
  const world = makeWorld();
  seedClaude(world, { snapshot: '0.3.7' });
  const io = makeIo(world);

  const outcome = performSelfUpdate({
    pluginRoot: CLAUDE_ROOT,
    env: { ...CLAUDE_ENV, ARMA_MCP_NO_AUTOUPDATE: '1' },
    io,
  });

  assert.equal(outcome.result, 'disabled');
  assert.equal(world.cache, null);
});

test('Codex 로컬 마켓플레이스는 갱신 없이 add 로 업그레이드한다', () => {
  const world = makeWorld();
  const codexHome = 'C:/u/.codex';
  const root = `${codexHome}/plugins/cache/ahc/arma-mcp/0.3.5`;
  const source = 'E:/src/Arma-MCP';
  putJson(world, `${root}/.codex-plugin/plugin.json`, { name: 'arma-mcp', version: '0.3.5' });
  world.text.set(
    key(`${codexHome}/config.toml`),
    ['[marketplaces.ahc]', 'source_type = "local"', `source = '${source}'`].join('\n'),
  );
  world.paths.add(key(source));
  putJson(world, `${source}/.claude-plugin/marketplace.json`, {
    plugins: [{ name: 'arma-mcp', version: '0.3.6' }],
  });
  const io = makeIo(world);

  const outcome = performSelfUpdate({
    pluginRoot: root,
    env: { CODEX_HOME: codexHome },
    io,
    cliHint: 'codex',
  });

  assert.equal(outcome.host, 'codex');
  assert.equal(outcome.result, 'updated');
  // Codex 에는 plugin update 가 없다 — add 가 업그레이드를 겸한다.
  assert.deepEqual(outcome.ran, [['plugin', 'add', 'arma-mcp@ahc', '--json']]);
  assert.equal(world.gitCalls.length, 0, '로컬 소스는 원격을 볼 것이 없다');
});

// ---------------------------------------------------------------------------
// 훅 단계
// ---------------------------------------------------------------------------

function hookHarness(cache: SelfUpdateCache | null) {
  const spawned: string[][] = [];
  let stored = cache;
  return {
    spawned,
    get cache() {
      return stored;
    },
    args: {
      readCache: () => stored,
      writeCache: (value: SelfUpdateCache) => {
        stored = value;
        return true;
      },
      spawnChild: (_exe: string, childArgs: string[]) => {
        spawned.push(childArgs);
      },
    },
  };
}

test('훅은 쿨다운 안에서 자식을 겹쳐 띄우지 않는다', async () => {
  const h = hookHarness(null);
  const common = {
    pluginRoot: 'C:/nonexistent-root',
    cliHint: 'claude',
    env: {} as NodeJS.ProcessEnv,
    entry: 'C:/bundle/index.mjs',
    ...h.args,
  };

  await runSelfUpdateHook({ ...common, now: 1000 });
  await runSelfUpdateHook({ ...common, now: 1500 });

  assert.equal(h.spawned.length, 1, '두 번째 세션은 쿨다운에 걸린다');
  assert.deepEqual(h.spawned[0], [
    'C:/bundle/index.mjs',
    'selfupdate',
    'run',
    '--root',
    'C:/nonexistent-root',
    '--cli',
    'claude',
  ]);
  // spawn 전에 기록해야 동시에 시작한 세션이 겹치지 않는다.
  assert.equal(h.cache?.lastCheck, 1000);
});

test('훅은 지난 세션의 알림을 한 번만 전달한다', async () => {
  const h = hookHarness({
    lastCheck: 1000,
    notify: { fromVersion: '0.3.5', toVersion: '0.3.6' },
  });
  const common = {
    pluginRoot: 'C:/nonexistent-root',
    cliHint: 'claude',
    env: {} as NodeJS.ProcessEnv,
    entry: 'C:/bundle/index.mjs',
    now: 1100,
    ...h.args,
  };

  const first = await runSelfUpdateHook(common);
  assert.match(first?.systemMessage ?? '', /0\.3\.5 에서 0\.3\.6/);

  const second = await runSelfUpdateHook(common);
  assert.equal(second, null);
});

test('훅은 루트를 모르거나 억제되면 아무 것도 하지 않는다', async () => {
  const h = hookHarness(null);
  const noRoot = await runSelfUpdateHook({
    pluginRoot: null,
    cliHint: 'claude',
    env: {},
    entry: 'C:/bundle/index.mjs',
    ...h.args,
  });
  assert.equal(noRoot, null);

  const suppressed = await runSelfUpdateHook({
    pluginRoot: 'C:/nonexistent-root',
    cliHint: 'claude',
    env: { ARMA_MCP_NO_AUTOUPDATE: '1' },
    entry: 'C:/bundle/index.mjs',
    ...h.args,
  });
  assert.equal(suppressed, null);
  assert.equal(h.spawned.length, 0);
});

test('parseSelfUpdateArgs/resolvePluginRoot: 어댑터가 넘긴 인자를 먼저 본다', () => {
  assert.deepEqual(
    parseSelfUpdateArgs(['hook', '--root', 'C:/r', '--cli', 'claude']),
    { sub: 'hook', root: 'C:/r', cli: 'claude', json: false, force: false },
  );
  assert.deepEqual(parseSelfUpdateArgs(['check', '--json', '--force']), {
    sub: 'check',
    root: null,
    cli: null,
    json: true,
    force: true,
  });

  assert.equal(resolvePluginRoot('C:/explicit', { CLAUDE_PLUGIN_ROOT: 'C:/env' }, undefined), 'C:/explicit');
  assert.equal(resolvePluginRoot(null, { CLAUDE_PLUGIN_ROOT: 'C:/env' }, undefined), 'C:/env');
  // 번들 경로에서 역산한다.
  assert.equal(resolvePluginRoot(null, {}, 'C:/root/server/bundle/index.mjs'), 'C:/root');
  assert.equal(resolvePluginRoot(null, {}, 'C:/root/server/dist/index.js'), 'C:/root');
  assert.equal(resolvePluginRoot(null, {}, 'C:/somewhere/else.js'), null);
});

// ---------------------------------------------------------------------------
// 프로세스 수준 stdout 계약
// ---------------------------------------------------------------------------

function runHookProcess(env: Record<string, string>, root: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', srcIndex, 'selfupdate', 'hook', '--root', root, '--cli', 'claude'],
    {
      encoding: 'utf8',
      cwd: path.join(here, '..'),
      env: { ...process.env, ...env },
      timeout: 60_000,
    },
  );
}

test('selfupdate hook: 알릴 것이 없으면 stdout 에 한 바이트도 쓰지 않는다', () => {
  // 상태 폴더를 격리한다 — 그러지 않으면 테스트가 사용자의 실제 상태를 건드린다.
  const state = mkdtempSync(path.join(tmpdir(), 'arma-selfupdate-'));
  const res = runHookProcess(
    {
      ARMA_MCP_NO_AUTOUPDATE: '1',
      ARMA_MCP_TOKEN_FILE: path.join(state, 'daemon.token'),
      CLAUDE_CONFIG_DIR: path.join(state, 'claude'),
    },
    path.join(state, 'root'),
  );

  assert.equal(res.status, 0, '자동 업데이트는 어떤 경우에도 세션을 막지 않는다');
  assert.equal(res.stdout, '');
  assert.equal(existsSync(path.join(state, 'selfupdate.json')), false);
});

test('selfupdate hook: 알릴 것이 있으면 정확히 한 줄의 JSON 을 쓴다', () => {
  const state = mkdtempSync(path.join(tmpdir(), 'arma-selfupdate-'));
  const root = path.join(state, 'root');
  mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'arma-mcp', version: '0.3.6' }),
    'utf8',
  );
  // lastCheck 와 installedVersion 을 맞춰 쿨다운에 걸리게 한다 — 자식을 띄우지 않는다.
  writeFileSync(
    path.join(state, 'selfupdate.json'),
    JSON.stringify({
      lastCheck: Date.now(),
      installedVersion: '0.3.6',
      notify: { fromVersion: '0.3.5', toVersion: '0.3.6' },
    }),
    'utf8',
  );

  const res = runHookProcess(
    {
      ARMA_MCP_TOKEN_FILE: path.join(state, 'daemon.token'),
      CLAUDE_CONFIG_DIR: path.join(state, 'claude'),
      ARMA_MCP_NO_AUTOSTART: '1',
    },
    root,
  );

  assert.equal(res.status, 0);
  const lines = res.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0] ?? '') as { systemMessage?: string };
  assert.match(parsed.systemMessage ?? '', /0\.3\.5 에서 0\.3\.6/);

  // 소비했으므로 캐시에서 사라진다.
  const cache = JSON.parse(readFileSync(path.join(state, 'selfupdate.json'), 'utf8')) as {
    notify?: unknown;
  };
  assert.equal(cache.notify, undefined);
});
