// processScope.ts — 한 스택의 Arma 프로세스만 보는 조회와 종료.
//
// MpLauncher.killMp 와 실행 가드는 이미지 이름으로 묻는 MpProcFns 를 쓴다. 여기서는 같은
// 모양을 유지하되 "그 이미지 중 이 스택의 프로세스" 로 좁힌다. 그래서 killMp 의 대기와
// 잠금 해제 로직은 그대로 두고, default 스택의 종료가 다른 스택의 게임을 죽이지 않는다.

import type { Config } from '../config.js';
import { resolveServerImage } from '../config.js';
import {
  CLIENT_IMAGE,
  SERVER_IMAGE_CANDIDATES,
  findRunningServerImage,
  invalidateProcCache,
  isProcRunningAsync,
  killProcAsync,
  waitPathsWritable,
  waitProcGone,
} from '../procs.js';
import type { MpProcFns } from '../launch/mpLauncher.js';
import {
  clientIndexOf,
  killPids,
  listArmaProcesses,
  pidAlive,
  profilesArg,
  stackOfProfiles,
  type ArmaProcessInfo,
  type ProcessLister,
} from './processIndex.js';

export interface StackProcess {
  pid: number;
  image: string;
  role: 'client' | 'server';
  /** 클라 순번(1부터). 서버는 0. */
  index: number;
  profiles: string | null;
}

export interface ScopedProcs extends MpProcFns {
  /** 이 스택의 Arma 프로세스. 조회에 실패하면 null. */
  list(force?: boolean): Promise<StackProcess[] | null>;
}

export interface ScopedProcsOptions {
  cfg: Config;
  stackId: string;
  stacksRoot: string;
  /** 다른 스택이 게임을 돌리는 중인지. 조회 실패 때 이미지 이름 종료로 물러설지 정한다. */
  othersActive?: () => boolean;
  lister?: ProcessLister;
  killer?: typeof killPids;
  alive?: (pid: number) => boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function watchedImages(cfg: Config): string[] {
  return [CLIENT_IMAGE, resolveServerImage(cfg), ...SERVER_IMAGE_CANDIDATES];
}

export function classify(
  info: ArmaProcessInfo,
  stacksRoot: string,
): { stack: string; process: StackProcess } {
  const profiles = profilesArg(info.commandLine);
  const role: StackProcess['role'] =
    info.image.toLowerCase() === CLIENT_IMAGE.toLowerCase() ? 'client' : 'server';
  return {
    stack: stackOfProfiles(profiles, stacksRoot),
    process: {
      pid: info.pid,
      image: info.image,
      role,
      index: role === 'client' ? clientIndexOf(profiles) : 0,
      profiles,
    },
  };
}

/**
 * 스택 범위 MpProcFns. 이미지 이름을 받는 자리는 "그 이미지 중 이 스택 것" 으로 읽는다.
 * 조회에 실패하면 default 스택만, 그리고 다른 스택이 조용할 때만 이미지 이름 방식으로 물러선다.
 */
export function createScopedProcs(opts: ScopedProcsOptions): ScopedProcs {
  const lister = opts.lister ?? ((images) => listArmaProcesses(images));
  const forcedLister = opts.lister ?? ((images) => listArmaProcesses(images, true));
  const killer = opts.killer ?? killPids;
  const alive = opts.alive ?? pidAlive;
  const isDefault = opts.stackId === 'default';
  const images = (): string[] => watchedImages(opts.cfg);
  const canFallBack = (): boolean => isDefault && !(opts.othersActive?.() ?? false);

  const list = async (force = false): Promise<StackProcess[] | null> => {
    const raw = await (force ? forcedLister : lister)(images());
    if (raw === null) return null;
    return raw
      .map((info) => classify(info, opts.stacksRoot))
      .filter((c) => c.stack === opts.stackId)
      .map((c) => c.process);
  };

  const ofImage = (procs: StackProcess[], image: string): StackProcess[] =>
    procs.filter((p) => p.image.toLowerCase() === image.toLowerCase());

  const isRunning: MpProcFns['isProcRunningAsync'] = async (image, force = false) => {
    const procs = await list(force);
    if (procs === null) return canFallBack() ? isProcRunningAsync(image, force) : false;
    return ofImage(procs, image).length > 0;
  };

  const findServer: MpProcFns['findRunningServerImage'] = async (preferred = '', force = false) => {
    const procs = await list(force);
    if (procs === null) return canFallBack() ? findRunningServerImage(preferred, force) : null;
    const servers = procs.filter((p) => p.role === 'server');
    if (servers.length === 0) return null;
    const pref = servers.find((p) => p.image.toLowerCase() === preferred.toLowerCase());
    return (pref ?? servers[0]!).image;
  };

  const kill: MpProcFns['killProcAsync'] = async (image) => {
    // 죽이기 직전에 새로 읽는다. 그 사이 끝나고 pid 가 재사용된 프로세스를 잡지 않기 위해서다.
    const procs = await list(true);
    if (procs === null) {
      if (canFallBack()) return killProcAsync(image);
      return { killed: false, detail: `프로세스 목록을 읽지 못해 ${image} 를 끄지 않음` };
    }
    const targets = ofImage(procs, image);
    if (targets.length === 0) return { killed: false, detail: `${image} 미실행` };
    const res = await killer(targets.map((p) => p.pid));
    invalidateProcCache();
    return { killed: res.ok, detail: res.detail };
  };

  const waitGone: MpProcFns['waitProcGone'] = async (image, timeoutMs, pollMs = 150, signal) => {
    if (signal?.aborted) return false;
    const procs = await list(true);
    if (procs === null) {
      return canFallBack() ? waitProcGone(image, timeoutMs, pollMs, signal) : false;
    }
    const pids = ofImage(procs, image).map((p) => p.pid);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pids.every((pid) => !alive(pid))) return true;
      if (signal?.aborted || Date.now() >= deadline) return false;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
    }
  };

  return {
    list,
    isProcRunningAsync: isRunning,
    findRunningServerImage: findServer,
    killProcAsync: kill,
    waitProcGone: waitGone,
    waitPathsWritable,
  };
}

/** 스택을 모르는 기존 이미지 방식. 테스트와 standalone 호출부가 쓴다. */
export function imageScopedProcs(): ScopedProcs {
  return {
    async list() {
      return null;
    },
    isProcRunningAsync,
    findRunningServerImage,
    killProcAsync,
    waitProcGone,
    waitPathsWritable,
  };
}
