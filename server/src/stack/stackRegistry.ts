// stackRegistry.ts — 데몬이 아는 테스트 스택 목록.
//
// default 스택은 데몬과 함께 늘 있다. 다른 스택은 실행 계열 도구가 처음 부를 때 만들고,
// <stacks.root>\<id>\stack.json 에 포트를 적어 둔다. 데몬이 다시 뜨면 적어 둔 스택의
// 파이프를 다시 열어, 돌던 서버가 제 파이프로 다시 붙게 한다.

import dgram from 'node:dgram';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { resolveStacksRoot } from '../config.js';
import { log } from '../log.js';
import {
  DEFAULT_STACK_ID,
  namedStackContext,
  validateStackId,
  type StackContext,
} from './stackContext.js';
import { createStackBundle, type StackBundle, type StackBundleOptions } from './stackRuntime.js';
import { removeTreeNoFollow } from './fsSafe.js';

const STACK_FILE = 'stack.json';
/** 게임 포트, Steam 쿼리 포트, 그다음 포트까지 UDP 로 비어 있는지 본다. */
const PORT_PROBE_SPAN = 3;
const PORT_SEARCH_LIMIT = 64;

export interface StackRecord {
  v: 1;
  id: string;
  port: number;
  createdAt: number;
}

export type EnsureResult =
  | { ok: true; bundle: StackBundle; created: boolean }
  | { ok: false; error: string };

export interface StackRegistryOptions {
  /** 포트가 비어 있는지. 테스트에서 바꿔 끼운다. */
  probePort?: (port: number) => Promise<boolean>;
  /** 스택 번들 생성. 테스트에서 게임 파이프 없이 만들 때 쓴다. */
  createBundle?: (cfg: Config, ctx: StackContext, options: StackBundleOptions) => StackBundle;
}

export class StackRegistry {
  private readonly bundles = new Map<string, StackBundle>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly createBundle: (
    cfg: Config,
    ctx: StackContext,
    options: StackBundleOptions,
  ) => StackBundle;

  constructor(
    private readonly cfg: Config,
    defaultBundle: StackBundle,
    options: StackRegistryOptions = {},
  ) {
    this.bundles.set(DEFAULT_STACK_ID, defaultBundle);
    this.probePort = options.probePort ?? udpPortsFree;
    this.createBundle = options.createBundle ?? createStackBundle;
  }

  root(): string {
    return resolveStacksRoot(this.cfg);
  }

  get(id: string | undefined): StackBundle | undefined {
    const check = validateStackId(id);
    return check.ok ? this.bundles.get(check.id) : undefined;
  }

  /** default 가 먼저, 나머지는 이름순. */
  list(): StackBundle[] {
    const named = [...this.bundles.values()]
      .filter((b) => !b.ctx.isDefault)
      .sort((a, b) => a.ctx.id.localeCompare(b.ctx.id));
    return [this.bundles.get(DEFAULT_STACK_ID)!, ...named];
  }

  /** 있으면 돌려주고, 없으면 포트를 골라 만들고 파이프를 연다. 동시 호출은 줄을 세운다. */
  ensure(rawId: string | undefined): Promise<EnsureResult> {
    return this.serialize(() => this.ensureNow(rawId));
  }

  private async ensureNow(rawId: string | undefined): Promise<EnsureResult> {
    const check = validateStackId(rawId);
    if (!check.ok) return check;
    const existing = this.bundles.get(check.id);
    if (existing) return { ok: true, bundle: existing, created: false };

    const namedCount = this.bundles.size - 1;
    if (namedCount >= this.cfg.stacks.max) {
      return {
        ok: false,
        error:
          `스택이 이미 ${namedCount}개다(stacks.max=${this.cfg.stacks.max}). ` +
          'arma_kill { stack, forget:true } 로 안 쓰는 스택을 지우거나 stacks.max 를 늘린다',
      };
    }

    const port = await this.pickPort();
    if (port === null) {
      return { ok: false, error: `비어 있는 게임 포트를 찾지 못했다(mp.port=${this.cfg.mp.port} 부터)` };
    }
    const ctx = namedStackContext(this.cfg, check.id, port);
    const bundle = this.createBundle(this.cfg, ctx, this.bundleOptions(ctx.id));
    try {
      await bundle.start({ requireOwnership: true });
    } catch (error) {
      await bundle.stop().catch(() => {});
      return { ok: false, error: `스택 ${check.id} 의 게임 파이프를 열지 못했다: ${(error as Error).message}` };
    }
    try {
      await writeRecord(ctx.root, { v: 1, id: check.id, port, createdAt: Date.now() });
    } catch (error) {
      await bundle.stop().catch(() => {});
      return { ok: false, error: `스택 폴더를 만들지 못했다(${ctx.root}): ${(error as Error).message}` };
    }
    this.bundles.set(check.id, bundle);
    log.info(`[stack] ${check.id} 생성: port=${port} pipe=${ctx.pipeName}`);
    return { ok: true, bundle, created: true };
  }

  /**
   * 적어 둔 스택을 다시 연다. 파이프가 잡혀 있으면 그 스택만 5초마다 다시 시도하는
   * degraded 상태로 둔다. 데몬 전체는 멈추지 않는다.
   */
  loadPersisted(): Promise<string[]> {
    return this.serialize(async () => {
      const loaded: string[] = [];
      let entries: string[] = [];
      try {
        entries = await fsp.readdir(this.root());
      } catch {
        return loaded;
      }
      for (const name of entries.sort()) {
        if (name === DEFAULT_STACK_ID || this.bundles.has(name)) continue;
        if (this.bundles.size - 1 >= this.cfg.stacks.max) {
          log.warn(`[stack] stacks.max(${this.cfg.stacks.max}) 초과로 ${name} 을 다시 열지 않음`);
          continue;
        }
        const record = await readRecord(path.join(this.root(), name));
        if (!record || record.id !== name || !validateStackId(name).ok) continue;
        const ctx = namedStackContext(this.cfg, name, record.port);
        const bundle = this.createBundle(this.cfg, ctx, this.bundleOptions(ctx.id));
        try {
          await bundle.start({ requireOwnership: false });
        } catch (error) {
          log.warn(`[stack] ${name} 파이프 열기 실패: ${(error as Error).message}`);
        }
        this.bundles.set(name, bundle);
        loaded.push(name);
      }
      if (loaded.length > 0) log.info(`[stack] 저장된 스택 다시 열림: ${loaded.join(', ')}`);
      return loaded;
    });
  }

  /** 파이프를 닫고 스택 폴더를 지운다. default 는 지우지 않는다. */
  forget(rawId: string | undefined): Promise<{ ok: boolean; error?: string; removed?: string }> {
    return this.serialize(async () => {
      const check = validateStackId(rawId);
      if (!check.ok) return { ok: false, error: check.error };
      if (check.id === DEFAULT_STACK_ID) {
        return { ok: false, error: 'default 스택은 지울 수 없다' };
      }
      const bundle = this.bundles.get(check.id);
      const root = bundle?.ctx.root ?? path.join(this.root(), check.id);
      if (bundle) {
        this.bundles.delete(check.id);
        await bundle.stop().catch(() => {});
      }
      try {
        await removeTreeNoFollow(root, this.root());
      } catch (error) {
        return { ok: false, error: `스택 폴더를 지우지 못했다(${root}): ${(error as Error).message}` };
      }
      log.info(`[stack] ${check.id} 삭제`);
      return { ok: true, removed: root };
    });
  }

  /**
   * id 가 아닌 스택이 게임을 돌리는 중인지. 게임 연결이 살아 있거나 실행 lease 를 쥐고 있으면 그렇다.
   * 프로세스 조회가 실패했을 때 default 스택이 이미지 이름 종료로 물러서도 되는지 가린다.
   */
  othersActive(id: string): boolean {
    for (const bundle of this.bundles.values()) {
      if (bundle.ctx.id === id) continue;
      if (bundle.gateway?.isConnected?.()) return true;
      if (bundle.operationCoordinator?.snapshot()) return true;
    }
    return false;
  }

  bundleOptions(id: string): StackBundleOptions {
    return { othersActive: () => this.othersActive(id) };
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.bundles.values()].filter((b) => !b.ctx.isDefault).map((b) => b.stop().catch(() => {})),
    );
  }

  private async pickPort(): Promise<number | null> {
    const taken = new Set([...this.bundles.values()].map((b) => b.ctx.port));
    const step = this.cfg.stacks.portStep;
    for (let k = 1; k <= PORT_SEARCH_LIMIT; k++) {
      const port = this.cfg.mp.port + step * k;
      if (port + PORT_PROBE_SPAN > 65535) break;
      if (taken.has(port)) continue;
      if (await this.probePort(port)) return port;
    }
    return null;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}

async function writeRecord(root: string, record: StackRecord): Promise<void> {
  await fsp.mkdir(root, { recursive: true });
  const file = path.join(root, STACK_FILE);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

async function readRecord(root: string): Promise<StackRecord | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(root, STACK_FILE), 'utf8')) as Partial<StackRecord>;
    if (
      parsed.v !== 1 ||
      typeof parsed.id !== 'string' ||
      !Number.isInteger(parsed.port) ||
      (parsed.port ?? 0) <= 0 ||
      (parsed.port ?? 0) > 65535
    ) {
      return null;
    }
    return { v: 1, id: parsed.id, port: parsed.port!, createdAt: Number(parsed.createdAt) || 0 };
  } catch {
    return null;
  }
}

/** port 부터 PORT_PROBE_SPAN 개의 UDP 포트에 잠깐 바인드해 본다. */
export async function udpPortsFree(port: number): Promise<boolean> {
  for (let p = port; p < port + PORT_PROBE_SPAN; p++) {
    if (!(await bindOnce(p))) return false;
  }
  return true;
}

function bindOnce(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      resolve(false);
    });
    sock.bind(port, '0.0.0.0', () => {
      sock.close(() => resolve(true));
    });
  });
}
