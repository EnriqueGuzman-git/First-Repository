/**
 * Dependency-free fixed-window rate limiter for the HTTP surface, guarding the
 * unauthenticated `POST /api/rooms` against unbounded room creation.
 *
 * Fixed-window (not sliding) is O(1) and allocation-free — adequate for coarse
 * abuse protection. The in-memory map is single-process by design; a multi-
 * instance deployment would move it to Redis (see README "Production
 * Considerations"). Clock is injectable so window logic is testable.
 */

export type RateLimitResult = {
  /** True if the request is within the limit and may proceed. */
  readonly allowed: boolean;
  /** Milliseconds until the current window resets. 0 when allowed. */
  readonly retryAfterMs: number;
};

export type FixedWindowLimiter = {
  /** Record a hit for `key` and report whether it is allowed. */
  check(key: string): RateLimitResult;
  /** Number of tracked keys — exposed for observability/tests. */
  readonly size: number;
};

type Bucket = {
  windowStart: number;
  count: number;
};

export type FixedWindowLimiterOptions = {
  /** Length of the counting window, in milliseconds. */
  readonly windowMs: number;
  /** Maximum number of hits allowed per key per window. */
  readonly max: number;
  /** Injectable clock. Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Prune expired keys once the tracked-key count exceeds this threshold.
   * Bounds memory under key-space abuse (e.g. spoofed source addresses).
   */
  readonly pruneThreshold?: number;
};

export function createFixedWindowLimiter(
  options: FixedWindowLimiterOptions,
): FixedWindowLimiter {
  const { windowMs, max } = options;
  const now = options.now ?? Date.now;
  const pruneThreshold = options.pruneThreshold ?? 10_000;

  const buckets = new Map<string, Bucket>();

  function prune(currentTime: number): void {
    for (const [key, bucket] of buckets) {
      if (currentTime - bucket.windowStart >= windowMs) {
        buckets.delete(key);
      }
    }
  }

  return {
    check(key: string): RateLimitResult {
      const currentTime = now();

      if (buckets.size > pruneThreshold) prune(currentTime);

      let bucket = buckets.get(key);
      if (!bucket || currentTime - bucket.windowStart >= windowMs) {
        bucket = { windowStart: currentTime, count: 0 };
        buckets.set(key, bucket);
      }

      bucket.count += 1;

      const allowed = bucket.count <= max;
      const retryAfterMs = allowed
        ? 0
        : bucket.windowStart + windowMs - currentTime;

      return { allowed, retryAfterMs };
    },

    get size(): number {
      return buckets.size;
    },
  };
}
