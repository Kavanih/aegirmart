// Two tier store. Narratives live until market expiry, quotes live seconds.
type Entry<T> = { value: T; expiresAt: number };

export class TtlCache<T> {
  private map = new Map<string, Entry<T>>();

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Collapses concurrent misses so twenty cards cannot fire twenty calls.
  private inflight = new Map<string, Promise<T>>();

  async resolve(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const running = this.inflight.get(key);
    if (running) return running;

    const task = load()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.inflight.delete(key));

    this.inflight.set(key, task);
    return task;
  }
}

type Bucket = { tokens: number; refilledAt: number };

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private capacity: number, private refillMs: number) {}

  // Token bucket keyed by session. Returns seconds to wait, or 0 when allowed.
  take(sessionId: string): number {
    const now = Date.now();
    const bucket = this.buckets.get(sessionId) ?? { tokens: this.capacity, refilledAt: now };

    const elapsed = now - bucket.refilledAt;
    const refill = Math.floor(elapsed / this.refillMs);
    if (refill > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refill);
      bucket.refilledAt = now;
    }

    if (bucket.tokens <= 0) {
      this.buckets.set(sessionId, bucket);
      return Math.ceil((this.refillMs - (now - bucket.refilledAt)) / 1000);
    }

    bucket.tokens -= 1;
    this.buckets.set(sessionId, bucket);
    return 0;
  }
}
