// cli.ts — self-update 서브커맨드 진입점과 훅 단계.
//
// hook  : 캐시만 보고 detached 자식을 던진 뒤 즉시 끝난다. 세션 시작을 절대 막지 않는다.
// run   : 그 자식. 실제 파이프라인을 수행한다.
// check : 사람이 터미널에서 쓰는 강제 진단.
//
// 이 모드는 MCP transport 를 열지 않는다. hook 만 stdout 에 훅 JSON 을 정확히 한 줄 쓰고,
// 알릴 것이 없으면 한 바이트도 쓰지 않는다. 진단은 다른 모드와 마찬가지로 stderr 로 간다.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../log.js';
import { spawnDetached } from '../launch/spawn.js';
import { clearNotice, pendingNotice, selfUpdateSuppressed } from './plan.js';
import { readSelfUpdateCache, writeSelfUpdateCache } from './state.js';
import {
  createDefaultIo,
  describeOutcome,
  dueForCheck,
  performSelfUpdate,
  type SelfUpdateOutcome,
} from './run.js';

export interface HookOutput {
  systemMessage: string;
}

interface ParsedArgs {
  sub: string;
  root: string | null;
  cli: string | null;
  json: boolean;
  force: boolean;
}

export function parseSelfUpdateArgs(argv: string[]): ParsedArgs {
  let sub = '';
  let root: string | null = null;
  let cli: string | null = null;
  let json = false;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--root') {
      root = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--cli') {
      cli = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--force') {
      force = true;
    } else if (!arg.startsWith('-') && !sub) {
      sub = arg;
    }
  }
  return { sub, root, cli, json, force };
}

/**
 * 플러그인 루트. host adapter 가 넘긴 --root 가 정답이고, 환경변수는 호환 폴백이다.
 * 마지막으로 번들 경로(`<root>/server/bundle/index.mjs`)에서 역산한다.
 */
export function resolvePluginRoot(
  explicit: string | null,
  env: NodeJS.ProcessEnv,
  entry: string | undefined,
): string | null {
  if (explicit) return explicit;
  if (env.CLAUDE_PLUGIN_ROOT) return env.CLAUDE_PLUGIN_ROOT;
  if (env.PLUGIN_ROOT) return env.PLUGIN_ROOT;
  if (!entry) return null;
  const match = entry.replace(/\\/g, '/').match(/^(.*)\/server\/(?:bundle|dist)\/[^/]+$/);
  return match?.[1] ?? null;
}

/** 설치본 버전. 매니페스트가 진실이고, 어느 호스트의 매니페스트든 값은 같다. */
export function readInstalledVersion(pluginRoot: string): string | null {
  for (const dir of ['.claude-plugin', '.codex-plugin']) {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(pluginRoot, dir, 'plugin.json'), 'utf8'),
      );
      const version = (parsed as { version?: unknown } | null)?.version;
      if (typeof version === 'string' && version) return version;
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
}

/**
 * SessionStart 단계. 지난 세션의 결과를 전달하고, 확인할 때가 됐으면 자식을 던진다.
 * 자식을 기다리지 않으며 어떤 실패도 밖으로 내보내지 않는다.
 */
export async function runSelfUpdateHook(input: {
  pluginRoot: string | null;
  cliHint: string | null;
  env: NodeJS.ProcessEnv;
  entry?: string;
  now?: number;
  readCache?: () => ReturnType<typeof readSelfUpdateCache>;
  writeCache?: (value: Parameters<typeof writeSelfUpdateCache>[1]) => boolean;
  spawnChild?: (executable: string, args: string[]) => void | Promise<void>;
}): Promise<HookOutput | null> {
  const { pluginRoot, cliHint, env, entry = process.argv[1] } = input;
  if (!pluginRoot) return null;
  if (selfUpdateSuppressed(env)) return null;

  const now = input.now ?? Date.now();
  const readCache = input.readCache ?? (() => readSelfUpdateCache(env));
  const writeCache = input.writeCache ?? ((value) => writeSelfUpdateCache(env, value));

  const cache = readCache();
  const installedVersion = readInstalledVersion(pluginRoot);
  const systemMessage = pendingNotice(cache, installedVersion);
  let next = systemMessage ? clearNotice(cache) : (cache ?? {});

  if (dueForCheck(env, cache, now, installedVersion)) {
    // spawn 전에 먼저 기록한다 — 동시에 시작한 다른 세션이 쿨다운에 걸려 자식을 겹쳐 띄우지 않게.
    next = { ...next, lastCheck: now, installedVersion: installedVersion ?? undefined };
    writeCache(next);
    if (entry) {
      const args = [entry, 'selfupdate', 'run', '--root', pluginRoot];
      if (cliHint) args.push('--cli', cliHint);
      const spawnChild =
        input.spawnChild ??
        (async (executable: string, childArgs: string[]) => {
          // cwd 를 임시 폴더로 둔다. Windows 에서 열린 핸들이 플러그인 폴더 정리를 막지 않도록.
          await spawnDetached(executable, childArgs, { cwd: os.tmpdir(), windowsHide: true });
        });
      try {
        await spawnChild(process.execPath, args);
      } catch {
        /* 자동 업데이트 실패로 세션을 막지 않는다 */
      }
    }
  } else if (systemMessage) {
    writeCache(next);
  }

  return systemMessage ? { systemMessage } : null;
}

/**
 * relay 기동 트리거. 두 호스트 모두 세션마다 relay 를 새로 띄우므로 이것이 host-neutral 한
 * "세션 시작" 신호다. 호스트 훅이 없는 환경에서도 이 경로로 확인이 돌아간다.
 *
 * relay 의 stdout 은 MCP transport 가 소유하므로 결과는 로그로만 남긴다.
 */
export async function triggerSelfUpdateFromRelay(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const pluginRoot = resolvePluginRoot(null, env, process.argv[1]);
    if (!pluginRoot) return;
    const result = await runSelfUpdateHook({ pluginRoot, cliHint: null, env });
    if (result) log.info('[selfupdate] ' + result.systemMessage.split('\n')[0]);
  } catch {
    /* 자동 업데이트 실패로 relay 를 막지 않는다 */
  }
}

function emit(value: HookOutput | null): void {
  if (!value) return;
  // hook 서브커맨드의 stdout 계약: 마지막에 정확히 한 줄.
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/**
 * selfupdate 모드의 진입점. 어떤 예외도 밖으로 던지지 않는다 —
 * index.ts 의 main().catch 가 exit code 1 을 세팅하기 때문이다.
 */
export async function runSelfUpdateCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const { sub, root, cli, json, force } = parseSelfUpdateArgs(argv);
    const pluginRoot = resolvePluginRoot(root, env, process.argv[1]);

    if (sub === 'hook') {
      emit(await runSelfUpdateHook({ pluginRoot, cliHint: cli, env }));
      return;
    }

    if (sub === 'run') {
      if (!pluginRoot) return;
      const outcome = performSelfUpdate({
        pluginRoot,
        env,
        io: createDefaultIo(env),
        cliHint: cli,
      });
      log.info(`[selfupdate] ${outcome.result}` + (outcome.latestVersion ? ` → ${outcome.latestVersion}` : ''));
      return;
    }

    if (sub === 'check') {
      if (!pluginRoot) {
        process.stdout.write('플러그인 루트를 찾지 못했습니다. --root 로 지정하세요.\n');
        return;
      }
      // 쿨다운은 훅 쪽 판단이라 여기서는 이미 무시된다. --force 는 원격 게이트까지 건너뛰고
      // 스냅샷을 무조건 다시 받는다 — 캐시가 꼬였을 때만 쓴다.
      const outcome: SelfUpdateOutcome = performSelfUpdate({
        pluginRoot,
        env,
        io: createDefaultIo(env),
        cliHint: cli,
        force,
      });
      process.stdout.write(
        json ? `${JSON.stringify(outcome)}\n` : `${describeOutcome(outcome)}\n`,
      );
      return;
    }

    process.stderr.write(
      'usage: arma-mcp selfupdate <hook|run|check> [--root <path>] [--cli <name>] [--json] [--force]\n',
    );
  } catch (error) {
    log.debug('[selfupdate] ' + String(error));
  }
}
