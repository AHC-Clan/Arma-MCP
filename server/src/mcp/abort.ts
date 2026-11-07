export interface CombinedAbortSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Compose request/session/operation cancellation without relying on AbortSignal.any. */
export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): CombinedAbortSignal {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];

  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    signal.addEventListener('abort', listener, { once: true });
    listeners.push({ signal, listener });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const entry of listeners) {
        entry.signal.removeEventListener('abort', entry.listener);
      }
      listeners.length = 0;
    },
  };
}

/**
 * 신호를 묶어 fn 에 넘기고, fn 이 끝나면 리스너를 푼다.
 * 도구 핸들러는 세션 신호와 요청 신호(SDK 의 extra.signal)를 함께 넘긴다.
 * 요청 신호는 클라이언트가 notifications/cancelled 로 그 호출만 취소할 때 끊긴다.
 */
export async function withAbortSignals<T>(
  signals: Array<AbortSignal | undefined>,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const combined = combineAbortSignals(...signals);
  try {
    return await fn(combined.signal);
  } finally {
    combined.dispose();
  }
}
