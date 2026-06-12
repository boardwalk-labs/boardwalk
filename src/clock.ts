// Injectable time source. The scheduler and lifecycle take a Clock instead of calling
// Date.now()/setTimeout directly so tests can drive time deterministically (scheduler clock
// tests, DST cases, catch-up policy) without real waits.

export interface Clock {
  /** Current time, ms since epoch. */
  now(): number;
  /** Resolve after `ms` (a cancellable timer under the hood). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The real wall clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(signal as AbortSignal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
