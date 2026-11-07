// hosts.ts — self-update 의 host adapter 계층.
//
// AGENTS.md 의 host-neutral 규약에서 호스트 이름과 설치 레이아웃이 등장해도 되는 유일한
// 공유 소스다. 나머지 self-update 코드는 HostAdapter 를 통해서만 호스트를 안다.
//
// 파일 I/O 와 CLI 실행은 전부 HostIo 로 주입받는다 — 어댑터 판별 로직을 디스크 없이
// 테스트하기 위해서다.

import { homedir } from 'node:os';
import path from 'node:path';
import { isSafeCliName, isSafeScope } from './plan.js';

export interface CommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  errorCode?: string;
}

export interface HostIo {
  readJson<T>(file: string): T | null;
  readText(file: string): string | null;
  exists(file: string): boolean;
  hostCli(cli: string, args: string[]): CommandResult;
}

export interface MarketplaceOwner {
  marketplace: string;
  pluginName: string;
  /** 설치본 버전. 캐시 폴더 이름이 아니라 매니페스트를 우선한다. */
  installedVersion: string;
  /** 플러그인이 명시한 저장소. 등록 URL 과 다를 때 안내에만 쓰고 자동 재등록은 하지 않는다. */
  manifestUrl: string | null;
  /** marketplace.json 이 있는 루트. null 이면 버전을 판정할 수 없다. */
  snapshotRoot: string | null;
  /** 등록된 마켓플레이스 원격. local 소스면 null. */
  sourceUrl: string | null;
  scope: string | null;
}

export interface HostAdapter {
  name: string;
  cli: string;
  configDir(env: NodeJS.ProcessEnv): string;
  cacheRoot(env: NodeJS.ProcessEnv): string;
  owns(pluginRoot: string, env: NodeJS.ProcessEnv): boolean;
  resolveOwner(pluginRoot: string, env: NodeJS.ProcessEnv, io: HostIo): MarketplaceOwner | null;
  /** null 이면 갱신 단계를 건너뛴다(로컬 소스는 항상 라이브라 받을 것이 없다). */
  syncArgs(owner: MarketplaceOwner): string[] | null;
  installArgs(owner: MarketplaceOwner): string[];
  recoveryCommands(marketplace: string, url: string, pluginName: string): string[];
}

interface PluginManifest {
  name?: string;
  version?: string;
  repository?: string;
}

interface MarketplaceManifest {
  plugins?: Array<{ name?: string; version?: string }>;
}

/** 비교 가능한 형태로 정규화. Windows 는 대소문자를 구분하지 않고 구분자도 섞여 온다. */
export function normalizePath(value: string): string {
  return path
    .resolve(value)
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/**
 * 경로 경계를 지키는 접두사 판정.
 * '.../ahc' 가 '.../ahc-two' 를 삼키지 않아야 한다.
 */
export function isUnderPath(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(`${p}/`);
}

/** `<cacheRoot>/<marketplace>/<plugin>/<version>` 을 분해한다. 형태가 다르면 null. */
export function parseCachePath(
  pluginRoot: string,
  cacheRoot: string,
): { marketplace: string; plugin: string; version: string } | null {
  if (!isUnderPath(pluginRoot, cacheRoot)) return null;
  const rest = normalizePath(pluginRoot).slice(normalizePath(cacheRoot).length + 1);
  if (!rest) return null;
  const parts = rest.split('/').filter(Boolean);
  if (parts.length !== 3) return null;
  const marketplace = parts[0] ?? '';
  const plugin = parts[1] ?? '';
  const version = parts[2] ?? '';
  if (!isSafeCliName(marketplace) || !isSafeCliName(plugin)) return null;
  return { marketplace, plugin, version };
}

/** 캐시 폴더는 소문자 정규화된 값이므로 원래 표기를 원본 경로에서 되살린다. */
function segmentsOf(pluginRoot: string): string[] {
  return pluginRoot.replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean);
}

function readPluginManifest(
  pluginRoot: string,
  manifestDirs: string[],
  io: HostIo,
): PluginManifest | null {
  for (const dir of manifestDirs) {
    const manifest = io.readJson<PluginManifest>(path.join(pluginRoot, dir, 'plugin.json'));
    if (manifest && typeof manifest.name === 'string') return manifest;
  }
  return null;
}

/** 스냅샷 루트에서 이 플러그인의 마켓플레이스 버전을 읽는다. */
export function readSnapshotVersion(
  snapshotRoot: string,
  pluginName: string,
  io: HostIo,
): string | null {
  const candidates = [
    path.join(snapshotRoot, '.claude-plugin', 'marketplace.json'),
    path.join(snapshotRoot, '.agents', 'plugins', 'marketplace.json'),
  ];
  for (const file of candidates) {
    const manifest = io.readJson<MarketplaceManifest>(file);
    const entry = manifest?.plugins?.find((p) => p?.name === pluginName);
    if (typeof entry?.version === 'string' && entry.version) return entry.version;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

interface KnownMarketplaces {
  [name: string]: { source?: { url?: string }; installLocation?: string } | undefined;
}

interface InstalledPlugins {
  plugins?: Record<string, Array<{ scope?: string; version?: string }> | undefined>;
}

const claudeAdapter: HostAdapter = {
  name: 'claude',
  cli: 'claude',

  configDir(env) {
    return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  },

  cacheRoot(env) {
    return path.join(this.configDir(env), 'plugins', 'cache');
  },

  owns(pluginRoot, env) {
    return parseCachePath(pluginRoot, this.cacheRoot(env)) !== null;
  },

  resolveOwner(pluginRoot, env, io) {
    const parsed = parseCachePath(pluginRoot, this.cacheRoot(env));
    if (!parsed) return null;
    const segments = segmentsOf(pluginRoot);
    const marketplace = segments[segments.length - 3] ?? parsed.marketplace;
    const pluginName = segments[segments.length - 2] ?? parsed.plugin;

    const manifest = readPluginManifest(pluginRoot, ['.claude-plugin', '.codex-plugin'], io);
    const installedVersion = manifest?.version || parsed.version;

    const pluginsDir = path.join(this.configDir(env), 'plugins');
    const known = io.readJson<KnownMarketplaces>(path.join(pluginsDir, 'known_marketplaces.json'));
    const entry = known?.[marketplace];
    const snapshotRoot =
      entry?.installLocation || path.join(pluginsDir, 'marketplaces', marketplace);

    const installed = io.readJson<InstalledPlugins>(path.join(pluginsDir, 'installed_plugins.json'));
    const scopeRaw = installed?.plugins?.[`${pluginName}@${marketplace}`]?.[0]?.scope ?? null;

    return {
      marketplace,
      pluginName,
      installedVersion,
      manifestUrl: typeof manifest?.repository === 'string' ? manifest.repository : null,
      snapshotRoot: io.exists(snapshotRoot) ? snapshotRoot : null,
      sourceUrl: typeof entry?.source?.url === 'string' ? entry.source.url : null,
      scope: isSafeScope(scopeRaw) ? scopeRaw : null,
    };
  },

  syncArgs(owner) {
    return ['plugin', 'marketplace', 'update', owner.marketplace];
  },

  installArgs(owner) {
    const args = ['plugin', 'update', `${owner.pluginName}@${owner.marketplace}`, '--yes'];
    if (owner.scope) args.push('--scope', owner.scope);
    return args;
  },

  // 마켓플레이스를 지우면 그 플러그인도 지워지므로 다시 설치까지 적는다.
  recoveryCommands(marketplace, url, pluginName) {
    return [
      `claude plugin marketplace remove ${marketplace}`,
      `claude plugin marketplace add ${url}`,
      `claude plugin install ${pluginName}@${marketplace}`,
    ];
  },
};

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/**
 * config.toml 의 `[marketplaces.<name>]` 블록에서 source/source_type 만 뽑는다.
 * TOML 파서를 새로 들이지 않는 이유는 이 두 키 외에는 볼 것이 없기 때문이다.
 */
export function parseCodexMarketplace(
  text: string,
  name: string,
): { sourceType: string | null; source: string | null } | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 공백 클래스에 개행을 넣으면 앞 빈 줄부터 매치돼 블록 경계가 어긋난다. 줄 안쪽 공백만 허용한다.
  const header = new RegExp(
    `^[ \\t]*\\[marketplaces\\.(?:"${escaped}"|${escaped})\\][ \\t\\r]*$`,
    'm',
  );
  const start = text.search(header);
  if (start < 0) return null;
  const after = text.slice(start);
  const bodyStart = after.indexOf('\n');
  if (bodyStart < 0) return { sourceType: null, source: null };
  const body = after.slice(bodyStart + 1);
  const nextSection = body.search(/^[ \t]*\[/m);
  const block = nextSection >= 0 ? body.slice(0, nextSection) : body;

  const value = (key: string): string | null => {
    const match = block.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.+)$`, 'm'));
    if (!match?.[1]) return null;
    const raw = match[1].trim();
    if (raw.startsWith("'")) return raw.slice(1, raw.lastIndexOf("'"));
    if (raw.startsWith('"')) {
      return raw.slice(1, raw.lastIndexOf('"')).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }
    return raw;
  };

  return { sourceType: value('source_type'), source: value('source') };
}

/** Windows 확장 길이 경로 접두사는 다른 API 로 넘길 때 방해가 된다. */
function stripExtendedPrefix(value: string): string {
  return value.replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
}

/** `codex plugin marketplace list` 의 `MARKETPLACE  ROOT` 표에서 루트를 읽는다. */
export function parseCodexMarketplaceList(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\S+)\s{2,}(\S.*?)\s*$/);
    if (!match) continue;
    if (match[1] !== name) continue;
    return match[2] ?? null;
  }
  return null;
}

const codexAdapter: HostAdapter = {
  name: 'codex',
  cli: 'codex',

  configDir(env) {
    return env.CODEX_HOME || path.join(homedir(), '.codex');
  },

  cacheRoot(env) {
    return path.join(this.configDir(env), 'plugins', 'cache');
  },

  owns(pluginRoot, env) {
    return parseCachePath(pluginRoot, this.cacheRoot(env)) !== null;
  },

  resolveOwner(pluginRoot, env, io) {
    const parsed = parseCachePath(pluginRoot, this.cacheRoot(env));
    if (!parsed) return null;
    const segments = segmentsOf(pluginRoot);
    const marketplace = segments[segments.length - 3] ?? parsed.marketplace;
    const pluginName = segments[segments.length - 2] ?? parsed.plugin;

    const manifest = readPluginManifest(pluginRoot, ['.codex-plugin', '.claude-plugin'], io);
    const installedVersion = manifest?.version || parsed.version;

    const toml = io.readText(path.join(this.configDir(env), 'config.toml'));
    const entry = toml ? parseCodexMarketplace(toml, marketplace) : null;
    const source = entry?.source ? stripExtendedPrefix(entry.source) : null;
    const isRemote = /^(?:https?|ssh|git):\/\//i.test(source ?? '');

    // 로컬 소스면 그 경로가 곧 스냅샷이다. 원격이거나 못 찾으면 CLI 에게 루트를 묻는다.
    let snapshotRoot: string | null = null;
    if (source && !isRemote && io.exists(source)) {
      snapshotRoot = source;
    } else {
      const listed = io.hostCli(this.cli, ['plugin', 'marketplace', 'list']);
      const root = listed.ok ? parseCodexMarketplaceList(listed.stdout, marketplace) : null;
      if (root && io.exists(root)) snapshotRoot = root;
    }

    return {
      marketplace,
      pluginName,
      installedVersion,
      manifestUrl: typeof manifest?.repository === 'string' ? manifest.repository : null,
      snapshotRoot,
      sourceUrl: isRemote ? source : null,
      scope: null,
    };
  },

  syncArgs(owner) {
    // 로컬 소스는 항상 라이브라 갱신할 스냅샷이 없다.
    if (!owner.sourceUrl) return null;
    return ['plugin', 'marketplace', 'upgrade', owner.marketplace];
  },

  installArgs(owner) {
    // Codex 에는 plugin update 가 없다 — add 가 업그레이드를 겸한다.
    return ['plugin', 'add', `${owner.pluginName}@${owner.marketplace}`, '--json'];
  },

  recoveryCommands(marketplace, url, pluginName) {
    return [
      `codex plugin marketplace remove ${marketplace}`,
      `codex plugin marketplace add ${url}`,
      `codex plugin add ${pluginName}@${marketplace}`,
    ];
  },
};

export const HOST_ADAPTERS: HostAdapter[] = [claudeAdapter, codexAdapter];

/**
 * 플러그인 루트가 어느 호스트의 설치 캐시에 있는지 판별한다.
 * 어댑터 이름 힌트(호스트 어댑터가 넘긴 --cli)를 먼저 보되, 실제 경로로 교차 확인한다.
 */
export function detectHost(
  pluginRoot: string,
  env: NodeJS.ProcessEnv,
  cliHint?: string | null,
): HostAdapter | null {
  const ordered = cliHint
    ? [...HOST_ADAPTERS].sort((a, b) => {
        const aHit = a.name === cliHint || a.cli === cliHint ? 0 : 1;
        const bHit = b.name === cliHint || b.cli === cliHint ? 0 : 1;
        return aHit - bHit;
      })
    : HOST_ADAPTERS;
  return ordered.find((adapter) => adapter.owns(pluginRoot, env)) ?? null;
}
