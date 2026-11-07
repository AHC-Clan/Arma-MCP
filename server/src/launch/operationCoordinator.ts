import type { SessionTransport } from '../mcp/session.js';

export type OperationName =
  | 'arma_launch'
  | 'arma_launch_mp'
  | 'arma_launch_server'
  | 'arma_play'
  | 'arma_scaffold_mission'
  | 'arma_kill';

/** lease 를 잡은 MCP 클라이언트 세션. 기다리는 쪽이 누가 잡고 있는지 알 수 있게 내보낸다. */
export interface OperationOwner {
  /** 세션 짧은 id. arma_status 의 sessions[].shortId 와 같다. */
  session: string;
  transport: SessionTransport;
}

export interface OperationSnapshot {
  operation: OperationName;
  startedAt: number;
  elapsedMs: number;
  owner?: OperationOwner;
}

export interface OperationLease {
  signal: AbortSignal;
  release(): void;
}

export type AcquireResult =
  | { acquired: true; lease: OperationLease }
  | { acquired: false; busy: OperationSnapshot };

export type PreemptResult =
  | { acquired: true; lease: OperationLease; interrupted: OperationSnapshot | null }
  | { acquired: false; busy: OperationSnapshot };

interface ActiveOperation {
  id: number;
  operation: OperationName;
  startedAt: number;
  controller: AbortController;
  owner?: OperationOwner;
}

/**
 * Serializes process-wide launch mutations while still allowing parallel
 * read/exec tools. A lease is intentionally acquired only by MCP tool
 * entrypoints; nested launcher calls reuse the lease's AbortSignal.
 */
export class OperationCoordinator {
  private active: ActiveOperation | null = null;
  private nextId = 1;

  tryAcquire(operation: OperationName, owner?: OperationOwner): AcquireResult {
    if (this.active) return { acquired: false, busy: this.toSnapshot(this.active) };
    return { acquired: true, lease: this.replaceActive(operation, owner) };
  }

  /**
   * Atomically hands ownership to a recovery operation while aborting the
   * previous launch. The old lease cannot clear the replacement because leases
   * release by id. A kill already in progress is not preempted.
   */
  preemptWithKill(
    reason = 'operation aborted by arma_kill',
    owner?: OperationOwner,
  ): PreemptResult {
    if (this.active?.operation === 'arma_kill') {
      return { acquired: false, busy: this.toSnapshot(this.active) };
    }
    const interrupted = this.active ? this.toSnapshot(this.active) : null;
    this.active?.controller.abort(new Error(reason));
    return {
      acquired: true,
      lease: this.replaceActive('arma_kill', owner),
      interrupted,
    };
  }

  private replaceActive(operation: OperationName, owner?: OperationOwner): OperationLease {
    const current: ActiveOperation = {
      id: this.nextId++,
      operation,
      startedAt: Date.now(),
      controller: new AbortController(),
      owner: owner ? { ...owner } : undefined,
    };
    this.active = current;

    let released = false;
    return {
      signal: current.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        if (this.active?.id === current.id) this.active = null;
      },
    };
  }

  /**
   * Requests cancellation without releasing the lease. The launch path keeps
   * ownership until its finally block exits, so a replacement launch cannot
   * race cleanup from the interrupted operation.
   */
  abortActive(reason = 'operation aborted'): OperationSnapshot | null {
    if (!this.active) return null;
    const snapshot = this.toSnapshot(this.active);
    this.active.controller.abort(new Error(reason));
    return snapshot;
  }

  snapshot(): OperationSnapshot | null {
    return this.active ? this.toSnapshot(this.active) : null;
  }

  private toSnapshot(active: ActiveOperation): OperationSnapshot {
    return {
      operation: active.operation,
      startedAt: active.startedAt,
      elapsedMs: Math.max(0, Date.now() - active.startedAt),
      ...(active.owner ? { owner: { ...active.owner } } : {}),
    };
  }
}
