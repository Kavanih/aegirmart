import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STORE = new URL("../model-stats.json", import.meta.url).pathname;
const COOLDOWN_MS = 300_000;

export type ModelStat = {
  model: string;
  ok: number;
  fail: number;
  /** Mean milliseconds across successful calls only. */
  avgMs: number;
  rateLimitedUntil: number;
  lastOkAt: number;
};

let stats: Record<string, ModelStat> = load();

function load(): Record<string, ModelStat> {
  if (!existsSync(STORE)) return {};
  try {
    return JSON.parse(readFileSync(STORE, "utf8")) as Record<string, ModelStat>;
  } catch {
    return {};
  }
}

function persist(): void {
  try {
    writeFileSync(STORE, JSON.stringify(stats));
  } catch {
    // Stats are an optimisation; losing them must not break a prediction.
  }
}

function entry(model: string): ModelStat {
  return (stats[model] ??= { model, ok: 0, fail: 0, avgMs: 0, rateLimitedUntil: 0, lastOkAt: 0 });
}

export function recordSuccess(model: string, elapsedMs: number): void {
  const s = entry(model);
  // Running mean, so one slow call cannot dominate the estimate.
  s.avgMs = s.ok === 0 ? elapsedMs : (s.avgMs * s.ok + elapsedMs) / (s.ok + 1);
  s.ok += 1;
  s.lastOkAt = Date.now();
  s.rateLimitedUntil = 0;
  persist();
}

export function recordFailure(model: string, rateLimited: boolean): void {
  const s = entry(model);
  s.fail += 1;
  // A rate limited model is skipped for a while rather than demoted forever.
  if (rateLimited) s.rateLimitedUntil = Date.now() + COOLDOWN_MS;
  persist();
}

export function allStats(): ModelStat[] {
  return Object.values(stats).sort((a, b) => rank(a) - rank(b));
}

function successRate(s: ModelStat): number {
  const total = s.ok + s.fail;
  return total === 0 ? 0.5 : s.ok / total;
}

/** Lower is better: proven, fast models first; cooling-off models last. */
function rank(s: ModelStat): number {
  if (Date.now() < s.rateLimitedUntil) return 1e9;
  if (s.ok === 0) return s.fail > 0 ? 1e6 + s.fail : 1e5;
  // Latency in seconds, inflated when the model is also unreliable.
  return (s.avgMs / 1000) / Math.max(0.1, successRate(s));
}

/**
 * Order the candidate list by what we have measured.
 *
 * Untried models sit between proven ones and known-bad ones, so the pool keeps
 * exploring without letting a slow provider block a sixty second window.
 */
export function orderByPerformance(models: string[]): string[] {
  return [...models].sort((a, b) => rank(entry(a)) - rank(entry(b)));
}


const CALLS_PER_MINUTE = 20;
const window: number[] = [];

/** True when there is outbound budget left this minute. */
export function canCall(): boolean {
  const cutoff = Date.now() - 60_000;
  while (window.length > 0 && window[0] < cutoff) window.shift();
  return window.length < CALLS_PER_MINUTE;
}

export function noteCall(): void {
  window.push(Date.now());
}

export function callsThisMinute(): number {
  const cutoff = Date.now() - 60_000;
  while (window.length > 0 && window[0] < cutoff) window.shift();
  return window.length;
}
