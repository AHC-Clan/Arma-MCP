// rptWatch.ts — RPT 디렉터리 감시 가속기.
//
// fs.watch(ReadDirectoryChangesW)는 로컬 NTFS 에서 파일 생성/append 를 대체로 즉시
// 알려주지만 이벤트 병합·유실 가능성이 있고 네트워크 드라이브에선 침묵할 수 있다.
// 그래서 watch 를 진실의 원천으로 삼지 않는다 — 호출부의 기존 폴링 루프는 그대로 두고,
// wait() 가 "폴 간격을 다 자기 전에 조기 기상"하는 신호로만 쓴다. 이벤트가 전부
// 유실돼도 동작은 순수 폴링과 동일하다.

import { watch, type FSWatcher } from 'node:fs';

export interface DirWatcher {
  /** 최대 ms 대기하되 디렉터리 변경 이벤트가 오면 즉시 깨어난다. */
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  dispose(): void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function createDirWatcher(dir: string): DirWatcher {
  let watcher: FSWatcher | null = null;
  let pending: (() => void) | null = null;
  try {
    watcher = watch(dir, { persistent: false }, () => {
      const wake = pending;
      pending = null;
      if (wake) wake();
    });
    // 감시 대상 삭제 등 런타임 오류 시 조용히 순수 폴링으로 강등.
    watcher.on('error', () => {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  return {
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      if (!watcher || signal?.aborted) return sleep(ms, signal);
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          if (pending === done) pending = null;
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        pending = done;
        signal?.addEventListener('abort', done, { once: true });
      });
    },
    dispose(): void {
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      watcher = null;
      pending = null;
    },
  };
}
