// SPDX-License-Identifier: Apache-2.0

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
      if (signal === undefined) {
        setTimeout(resolve, ms);
        return;
      }
      const sig = signal;
      if (sig.aborted) {
        reject(abortError(sig));
        return;
      }
      const timer = setTimeout(() => {
        sig.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError(sig));
      };
      sig.addEventListener("abort", onAbort, { once: true });
    });
  },
};

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}
