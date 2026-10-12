/**
 * Failed-authentication throttle for the RACP-WS upgrade (security §5).
 *
 * Each remote address owns a token bucket that only failed authentications
 * drain. While the bucket has tokens, failures are merely counted; once it is
 * empty the address is refused outright for a backoff that doubles with each
 * further exhaustion, up to a cap. The bucket refills at a steady rate, and a
 * full bucket forgets past backoff. Successful authentications neither drain
 * nor refill it, so a legitimate client cannot reset an attacker's budget on
 * the same address.
 */
export type AuthRateLimitOptions = {
  /** Failures an address may make in a burst before it is refused. */
  capacity: number;
  /** Milliseconds for one failure token to refill. */
  refillIntervalMs: number;
  /** Refusal window after the first exhaustion; doubles per repeat. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Addresses tracked at once; the least recently touched is dropped. */
  maxTrackedAddresses: number;
};

export const DEFAULT_AUTH_RATE_LIMIT: AuthRateLimitOptions = {
  capacity: 10,
  refillIntervalMs: 6_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 60_000,
  maxTrackedAddresses: 1_024,
};

type Bucket = {
  tokens: number;
  updatedAt: number;
  strikes: number;
  blockedUntil: number;
};

export type AuthRateDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

export class AuthFailureRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly options: AuthRateLimitOptions;

  constructor(
    options: Partial<AuthRateLimitOptions> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.options = { ...DEFAULT_AUTH_RATE_LIMIT, ...options };
  }

  /** May `address` attempt authentication now? */
  check(address: string): AuthRateDecision {
    const bucket = this.refill(address);
    if (!bucket) return { allowed: true };
    const now = this.now();
    if (bucket.blockedUntil > now) return { allowed: false, retryAfterMs: bucket.blockedUntil - now };
    return { allowed: true };
  }

  /** Record one failed authentication from `address`. */
  recordFailure(address: string): void {
    const now = this.now();
    const bucket = this.refill(address) ?? { tokens: this.options.capacity, updatedAt: now, strikes: 0, blockedUntil: 0 };
    bucket.tokens = Math.max(0, bucket.tokens - 1);
    if (bucket.tokens < 1) {
      const backoff = Math.min(this.options.maxBackoffMs, this.options.baseBackoffMs * 2 ** bucket.strikes);
      bucket.strikes = Math.min(bucket.strikes + 1, 30);
      bucket.blockedUntil = now + backoff;
    }
    this.buckets.delete(address);
    this.buckets.set(address, bucket);
    while (this.buckets.size > this.options.maxTrackedAddresses) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }

  private refill(address: string): Bucket | undefined {
    const bucket = this.buckets.get(address);
    if (!bucket) return undefined;
    const now = this.now();
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsed / this.options.refillIntervalMs);
    bucket.updatedAt = now;
    if (bucket.tokens >= this.options.capacity && bucket.blockedUntil <= now) {
      // A full bucket has nothing left to remember.
      this.buckets.delete(address);
      return undefined;
    }
    return bucket;
  }
}
