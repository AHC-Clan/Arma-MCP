// packaging.test.ts — Claude/Codex 플러그인 패키징과 릴리스 메타데이터 일관성.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/cli/errors.js';
import { COMMANDS } from '../src/cli/main.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

interface McpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
}

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  mcpServers: Record<string, McpServerConfig>;
  skills?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    longDescription?: string;
    developerName?: string;
    category?: string;
    capabilities?: string[];
    defaultPrompt?: string[];
  };
}

interface Marketplace {
  name: string;
  interface?: {
    displayName?: string;
  };
  plugins: Array<{
    name: string;
    // Claude Code 2.1.x 는 객체 형태 source 를 "지원하지 않는 소스 타입"으로 거부한다
    // (plugin update 실패). 문자열 상대 경로만 쓴다.
    source: string;
    policy: {
      installation: string;
      authentication: string;
    };
    category: string;
    description: string;
    version: string;
  }>;
}

interface PackageJson {
  version: string;
}

interface PackageLock {
  version: string;
  packages: Record<string, { version?: string }>;
}

test('Claude/Codex 플러그인 이름·버전·마켓 source가 일치한다', () => {
  const claude = readJson<PluginManifest>('.claude-plugin/plugin.json');
  const codex = readJson<PluginManifest>('.codex-plugin/plugin.json');
  const marketplace = readJson<Marketplace>('.claude-plugin/marketplace.json');
  const pkg = readJson<PackageJson>('server/package.json');
  const lock = readJson<PackageLock>('server/package-lock.json');
  const entry = marketplace.plugins.find((plugin) => plugin.name === 'arma-mcp');

  assert.ok(entry, 'marketplace에 arma-mcp 항목이 있어야 한다');
  assert.equal(claude.name, 'arma-mcp');
  assert.equal(codex.name, claude.name);
  assert.equal(pkg.version, '0.5.14');
  assert.equal(claude.version, pkg.version);
  assert.equal(codex.version, pkg.version);
  assert.equal(entry.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
  assert.equal(entry.source, './');
  assert.deepEqual(entry.policy, {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  });
  assert.equal(entry.category, 'Developer Tools');
  assert.equal(marketplace.name, 'ahc');
  assert.equal(marketplace.interface?.displayName, 'AHC');
  assert.doesNotMatch(claude.description, /툴\s*\d+개/);
  assert.doesNotMatch(codex.description, /툴\s*\d+개/);
  assert.doesNotMatch(entry.description, /툴\s*\d+개/);
});

test('두 호스트 어댑터가 같은 추적 번들을 상대 경로로 실행한다', () => {
  const claude = readJson<PluginManifest>('.claude-plugin/plugin.json');
  const codex = readJson<PluginManifest>('.codex-plugin/plugin.json');
  const claudeServer = claude.mcpServers.arma;
  const codexServer = codex.mcpServers.arma;

  assert.ok(claudeServer);
  assert.ok(codexServer);
  assert.equal(claudeServer.command, 'node');
  assert.deepEqual(claudeServer.args, [
    '${CLAUDE_PLUGIN_ROOT}/server/bundle/index.mjs',
    'relay',
  ]);
  assert.equal(codexServer.command, 'node');
  assert.deepEqual(codexServer.args, ['./server/bundle/index.mjs', 'relay']);
  assert.equal(codexServer.cwd, '.');
  assert.equal(path.isAbsolute(codexServer.args[0] ?? ''), false);
  assert.equal(existsSync(path.join(repoRoot, 'server', 'bundle', 'index.mjs')), true);
});

test('Codex 설치 UI 메타데이터가 완전하고 starter prompt 제한을 지킨다', () => {
  const codex = readJson<PluginManifest>('.codex-plugin/plugin.json');
  const ui = codex.interface;

  assert.ok(ui, 'Codex interface 메타데이터가 필요하다');
  for (const value of [
    ui.displayName,
    ui.shortDescription,
    ui.longDescription,
    ui.developerName,
    ui.category,
  ]) {
    assert.equal(typeof value, 'string');
    assert.ok((value ?? '').trim().length > 0);
  }
  assert.ok(Array.isArray(ui.capabilities) && ui.capabilities.length > 0);
  assert.ok(Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0);
  assert.ok((ui.defaultPrompt?.length ?? 0) <= 3);
  assert.ok(ui.defaultPrompt?.every((prompt) => prompt.length <= 128));

  assert.equal(codex.skills, './skills/');
  const runtimeSkillPath = path.join(codex.skills, 'arma-runtime', 'SKILL.md');
  assert.equal(existsSync(path.join(repoRoot, runtimeSkillPath)), true);
  const runtimeSkill = readText(runtimeSkillPath);
  assert.match(runtimeSkill, /^---\r?\nname: arma-runtime\r?\n/);
  assert.match(runtimeSkill, /Do not use for source-only/);
  assert.match(runtimeSkill, /\.\.\/\.\.\/docs\/testing\.md/);
  assert.match(runtimeSkill, /\.\.\/\.\.\/docs\/tacmap\.md/);
});

test('런타임 스킬이 0.4.2 단축 경로와 스키마 일괄 로드를 안내한다', () => {
  const runtimeSkill = readText('skills/arma-runtime/SKILL.md');

  // 재실행 사이클을 한 호출로 줄이는 옵션이 라우팅 목록에 있어야 에이전트가 쓴다.
  assert.match(runtimeSkill, /`arma_play` once with `saveProfile`/);
  assert.match(runtimeSkill, /only `profile`/);
  assert.match(runtimeSkill, /`ready`/);
  assert.match(runtimeSkill, /`then`/);
  assert.match(runtimeSkill, /`arma_kill` with `unlockPaths`/);
  assert.match(runtimeSkill, /pass `capture`/);
  assert.match(runtimeSkill, /`busy\.owner`/);
  assert.match(runtimeSkill, /in one batch rather than one at a time/);
  // Zeus 화면 이름으로 말한 대상은 exec 전에 찾는다. 모듈 실행은 요청이 있을 때만이다.
  assert.match(runtimeSkill, /call `arma_zeus_find` before `arma_exec`/);
  assert.match(runtimeSkill, /`arma_zeus_module` only when the user asks/);

  // 공유 문서는 호스트 중립이다. 호스트 제품명은 어댑터에만 둔다.
  assert.doesNotMatch(runtimeSkill, /Claude|Codex/);
  // 문체 규칙: en dash, em dash, 가운뎃점을 쓰지 않는다.
  assert.doesNotMatch(runtimeSkill, /[\u2013\u2014\u00b7]/);
});

test('런타임 스킬이 셸 CLI 를 PATH 에 있을 때만 쓰게 하고 docs/cli.md 를 링크한다', () => {
  const runtimeSkill = readText('skills/arma-runtime/SKILL.md');

  // 1단계는 그대로 arma_status 다. CLI 는 여러 단계를 묶을 때의 선택지일 뿐이다.
  assert.match(runtimeSkill, /^1\. Call `arma_status` first/m);
  assert.match(runtimeSkill, /^## Chain from the shell$/m);
  assert.match(runtimeSkill, /When an `arma-mcp` command is on the shell PATH/);
  assert.match(runtimeSkill, /Stay on the MCP tools for single calls/);
  assert.match(runtimeSkill, /screenshots you must see/);
  assert.match(runtimeSkill, /background mode/);
  // PATH 에 없으면 MCP 도구에 남는다. 번들 경로는 docs/cli.md 에만 둔다.
  // 에이전트가 플러그인 캐시 폴더를 짐작해 옛 버전 번들을 부르면 버전 차이로 종료 코드 3 이 난다.
  assert.match(runtimeSkill, /If `arma-mcp` is not on the PATH, stay on the MCP tools\./);
  // 종료 코드 3 은 명령 도중 멈춘 daemon 도 포함한다. 이미 돌았을 수 있는 명령을 MCP 도구로 다시 보내면 두 번 돈다.
  assert.match(runtimeSkill, /`this request was not run`/);
  assert.match(runtimeSkill, /`the tool may or may not have run`/);
  assert.match(runtimeSkill, /Check the game state .* before you redo it\./);
  assert.doesNotMatch(runtimeSkill, /on exit code 3 fall back to the MCP tools/);
  assert.doesNotMatch(runtimeSkill, /server\/bundle\/index\.mjs/);
  assert.doesNotMatch(runtimeSkill, /<plugin root>/);
  assert.match(runtimeSkill, /\(\.\.\/\.\.\/docs\/cli\.md\)/);
  assert.equal(existsSync(path.join(repoRoot, 'docs', 'cli.md')), true);
});

test('docs/cli.md 가 모든 명령과 종료 코드를 다루고 문체 규칙을 지킨다', () => {
  const doc = readText('docs/cli.md');

  for (const command of COMMANDS) {
    assert.match(
      doc,
      new RegExp(`^### .*\\b${command.name}\\b`, 'm'),
      `docs/cli.md 에 ${command.name} 절이 있어야 한다`,
    );
  }
  for (const code of new Set(Object.values(EXIT))) {
    assert.match(doc, new RegExp(`^\\| ${code} \\|`, 'm'), `종료 코드 ${code} 가 표에 있어야 한다`);
  }

  // PowerShell 5.1 에는 && 가 없다. PowerShell 예시는 $LASTEXITCODE 로 잇는다.
  const powershellBlocks = doc.match(/```powershell\n[\s\S]*?```/g) ?? [];
  assert.ok(powershellBlocks.length > 0, 'PowerShell 호출 예시가 있어야 한다');
  for (const block of powershellBlocks) assert.ok(!block.includes('&&'), block);
  assert.match(doc, /\$LASTEXITCODE -eq 0/);

  // 문체 규칙: en dash, em dash, 가운뎃점, '및' 을 쓰지 않는다.
  assert.doesNotMatch(doc, /[–—·]/);
  assert.doesNotMatch(doc, /및/);
});

test('0.5.14 릴리스 버전이 서버·DLL·애드온 메타데이터에 동기화된다', () => {
  const expected = '0.5.14';

  assert.match(
    readText('server/src/version.ts'),
    /ARMA_MCP_VERSION\s*=\s*'0\.5\.14'/,
  );
  assert.match(readText('extension/src/dllmain.cpp'), /ArmaMCP 0\.5\.14/);
  assert.match(readText('extension/src/Bridge.cpp'), /ArmaMCP 0\.5\.14/);
  assert.match(readText('addon/addons/arma_mcp/config.cpp'), /version\s*=\s*"0\.5\.14"/);
  assert.match(readText('docs/protocol.md'), /"ver":"ArmaMCP 0\.5\.14"/);

  const hemtt = readText('addon/.hemtt/project.toml');
  assert.match(hemtt, /\[version\][\s\S]*?major\s*=\s*0/);
  assert.match(hemtt, /\[version\][\s\S]*?minor\s*=\s*5/);
  assert.match(hemtt, /\[version\][\s\S]*?patch\s*=\s*14/);
  assert.equal(expected, readJson<PackageJson>('server/package.json').version);
});

test('메인 화면 연결이 받는 저장소와 매니페스트의 저장소가 같다', () => {
  const claude = readJson<PluginManifest & { repository: string }>('.claude-plugin/plugin.json');
  const codex = readJson<PluginManifest & { repository: string }>('.codex-plugin/plugin.json');
  const match = /kMarketplaceUrl\s*=\s*"([^"]+)"/.exec(readText('extension/src/HostConnect.hpp'));
  assert.ok(match, 'HostConnect.hpp 에 kMarketplaceUrl 이 있어야 한다');
  assert.equal(claude.repository, match[1]);
  assert.equal(codex.repository, match[1]);
  assert.match(match[1]!, /^https:\/\//);
});

interface HooksManifest {
  hooks: {
    SessionStart?: Array<{
      matcher?: string;
      hooks: Array<{
        type: string;
        command: string;
        commandWindows?: string;
        timeout?: number;
      }>;
    }>;
  };
}

test('SessionStart 훅이 MCP 서버와 같은 번들을 selfupdate 모드로 실행한다', () => {
  const hooks = readJson<HooksManifest>('hooks/hooks.json');
  const claude = readJson<PluginManifest>('.claude-plugin/plugin.json');
  const bundleArg = claude.mcpServers.arma?.args[0] ?? '';

  const group = hooks.hooks.SessionStart?.[0];
  assert.ok(group, 'SessionStart 훅 그룹이 있어야 한다');
  assert.equal(group.matcher, 'startup|resume');

  const entry = group.hooks[0];
  assert.ok(entry, 'SessionStart 훅 명령이 있어야 한다');
  assert.equal(entry.type, 'command');
  // 훅과 MCP 서버가 같은 파일을 실행해야 판정 로직과 실행 코드가 어긋나지 않는다.
  assert.ok(bundleArg.length > 0 && entry.command.includes(bundleArg));
  assert.match(entry.command, /selfupdate hook/);
  // 호스트 이름과 루트 변수는 이 어댑터에만 있고 공유 소스는 인자로만 받는다.
  assert.match(entry.command, /--root/);
  assert.match(entry.command, /--cli claude/);
  assert.equal(entry.commandWindows, entry.command);
  assert.ok(typeof entry.timeout === 'number' && entry.timeout > 0 && entry.timeout <= 30);
});

test('단일 legacy marketplace 정책을 유지한다', () => {
  assert.equal(
    existsSync(path.join(repoRoot, '.agents', 'plugins', 'marketplace.json')),
    false,
    '중복 .agents marketplace를 추가하지 않는다',
  );
});

test('bin/arma-mcp 심이 LF 셸 스크립트로 같은 번들을 cli 모드로 실행한다', () => {
  const shim = path.join(repoRoot, 'bin', 'arma-mcp');
  assert.equal(existsSync(shim), true, 'Bash PATH 에 오르는 bin/arma-mcp 가 있어야 한다');
  const text = readFileSync(shim, 'utf8');
  assert.ok(!text.includes('\r'), 'CRLF 면 sh 가 #!/bin/sh 줄을 읽지 못한다');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.ok(text.includes('index.mjs" cli'), '심은 늘 cli 모드를 넘긴다');
  assert.ok(text.includes('server/bundle/index.mjs'));
  // Git Bash 의 인자 변환은 SQF, 정규식, key=value 의 / 까지 바꾼다. 이 node 호출에서만 끈다.
  // 경로 플래그의 /d/... 는 CLI 가 드라이브 경로로 바꾼다(args.ts normalizePathFlag).
  assert.match(text, /^export MSYS2_ARG_CONV_EXCL='\*'$/m);
  assert.ok(
    text.indexOf('MSYS2_ARG_CONV_EXCL') < text.indexOf('exec node'),
    '변환은 node 를 부르기 전에 꺼야 한다',
  );

  // core.filemode=false 인 체크아웃에서도 실행 비트는 인덱스에 남아야 한다.
  const staged = execFileSync('git', ['ls-files', '-s', '--', 'bin/arma-mcp'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.match(staged, /^100755 /, `bin/arma-mcp 가 실행 파일로 추적돼야 한다: ${staged}`);
  assert.match(readText('.gitattributes'), /^bin\/arma-mcp\s+text\s+eol=lf\s*$/m);
});
