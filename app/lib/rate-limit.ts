import "server-only";

/**
 * Minimal in-memory sliding-window rate limiter for auth endpoints
 * (login/register) that have no throttling anywhere else in the stack.
 *
 * LIMITATION: this app runs as a PM2 cluster (see pm2.config.js), and this
 * state is per-worker-process, not shared across workers or restarts. A
 * determined attacker distributing requests across workers gets roughly
 * `workerCount ×` the effective limit. That's still a meaningful bar over
 * "no limit at all" for the common single-connection credential-stuffing
 * case, and cheap to add without introducing a shared store (Redis, etc.)
 * this app doesn't otherwise have. If a stronger guarantee is ever needed,
 * move this to a shared store keyed the same way.
 */

type Bucket = { count: number; windowStart: number };

const buckets = new Map<string, Bucket>();

/** Bounds memory even if a huge number of distinct keys shows up. */
const MAX_TRACKED_KEYS = 20_000;

/**
 * Returns true if the call for `key` is allowed under a `limit`-per-`windowMs`
 * sliding (fixed-window, reset-on-expiry) rate limit.
 */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    if (buckets.size >= MAX_TRACKED_KEYS) {
      // Cheap pressure-relief: drop the oldest-looking entries rather than
      // grow unbounded. Exactness doesn't matter for a DoS-abuse guard.
      const cutoff = now - windowMs;
      for (const [k, b] of buckets) {
        if (b.windowStart < cutoff) buckets.delete(k);
      }
    }
    buckets.set(key, { count: 1, windowStart: now });
    return false;
  }

  existing.count += 1;
  return existing.count > limit;
}

/** Best-effort client identifier from proxy headers, falling back to a
 *  shared bucket when none is present (degrades to a global limit rather
 *  than no limit at all). */
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}
