/** A single wall-clock budget, shared by build, discovery and every test app. */
export function createTestBudget(timeoutMs = 600_000, signal?: AbortSignal, deadlineAt?: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer.");
  const deadline = Math.min(deadlineAt ?? Infinity, Date.now() + timeoutMs);
  const timedOut = () => Date.now() >= deadline || (signal?.aborted === true && signal.reason instanceof Error && signal.reason.name === "TimeoutError");
  const cancelled = () => signal?.aborted === true && !timedOut();
  return {
    deadline,
    timedOut,
    cancelled,
    remaining: () => {
      if (cancelled()) throw new Error("Test run cancelled; no further stages started.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Test run deadline exceeded; no further stages started.");
      return remaining;
    },
  };
}
