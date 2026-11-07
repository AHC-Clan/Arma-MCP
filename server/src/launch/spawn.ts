import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface DetachedProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface DetachedProcess {
  child: ChildProcess;
  pid: number | undefined;
  exitSignal: AbortSignal;
  exitInfo(): DetachedProcessExit | undefined;
}

/**
 * Spawn a detached process and wait for Node's `spawn` event.
 *
 * `child_process.spawn()` reports missing executables and similar startup failures
 * asynchronously, so a surrounding try/catch alone is not sufficient.
 */
export function spawnDetached(
  executable: string,
  args: string[],
  options: SpawnOptions = {},
): Promise<DetachedProcess> {
  return new Promise((resolve, reject) => {
    const exitController = new AbortController();
    let exitInfo: DetachedProcessExit | undefined;
    let started = false;
    let settled = false;

    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      ...options,
    });

    const abortForExit = (info: DetachedProcessExit): void => {
      exitInfo = info;
      if (exitController.signal.aborted) return;
      if (info.error) {
        exitController.abort(info.error);
        return;
      }
      const detail =
        info.code !== null ? `exit code ${info.code}` : `signal ${info.signal ?? 'unknown'}`;
      exitController.abort(new Error(`process exited (${detail})`));
    };

    child.once('spawn', () => {
      started = true;
      child.unref();
      settled = true;
      resolve({
        child,
        pid: child.pid,
        exitSignal: exitController.signal,
        exitInfo: () => exitInfo,
      });
    });

    child.once('error', (error) => {
      abortForExit({ code: null, signal: null, error });
      if (!started && !settled) {
        settled = true;
        reject(error);
      }
    });

    child.once('exit', (code, signal) => {
      abortForExit({ code, signal });
      if (!started && !settled) {
        settled = true;
        reject(new Error(`process exited before spawn completed (code=${code}, signal=${signal})`));
      }
    });
  });
}
