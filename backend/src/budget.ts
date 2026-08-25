import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * The free tier allows a fixed number of requests per ACCOUNT per UTC day.
 * Nothing upstream paces that allowance, so an unattended poller can spend the
 * whole day's budget in its first few minutes and leave the demo with nothing.
 *
 * This spreads the allowance across the day and keeps a slice back for live
 * requests, which are the ones a person is actually waiting on.
 */
const STORE = new URL("../quota.json", import.meta.url).pathname;
const DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT ?? 50);
// The rest is reserved for cards a person swipes before the tracker covers them.
const TRACKER_SHARE = 0.6;

type Ledger = { day: string; spent: number; blockedUntil?: number };

/** The free tier resets at 00:00 UTC, so the ledger rolls on the UTC date. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let ledger: Ledger = load();

function load(): Ledger {
  if (existsSync(STORE)) {
    try {
      const parsed = JSON.parse(readFileSync(STORE, "utf8")) as Ledger;
      if (parsed.day === today()) return parsed;
    } catch {
      // A corrupt ledger costs at most one day of pacing.
    }
  }
  return { day: today(), spent: 0 };
}

function current(): Ledger {
  if (ledger.day !== today()) ledger = { day: today(), spent: 0 };
  return ledger;
}

function persist(): void {
  try {
    writeFileSync(STORE, JSON.stringify(ledger));
  } catch {
    // Pacing is an optimisation; losing it must not take the poller down.
  }
}

/** Fraction of the UTC day elapsed, so spend is earned rather than granted. */
function dayElapsed(): number {
  const now = new Date();
  const seconds = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  return seconds / 86_400;
}

/**
 * True when the tracker may spend one request now. The tracker is held to a
 * share of the allowance AND to the pace of the day, so leaving the server up
 * overnight covers markets steadily instead of in one burst.
 */
export function claimTrackerSpend(): boolean {
  const l = current();
  const earned = Math.ceil(DAILY_LIMIT * TRACKER_SHARE * dayElapsed());
  if (l.spent >= earned || l.spent >= DAILY_LIMIT) return false;
  l.spent += 1;
  persist();
  return true;
}

/** Live requests draw on the full allowance; they are not paced. */
export function claimLiveSpend(): boolean {
  const l = current();
  if (l.spent >= DAILY_LIMIT) return false;
  l.spent += 1;
  persist();
  return true;
}

/**
 * The upstream cap survives a process restart, so the latch must too. It lives
 * on the ledger because both roll over at the same 00:00 UTC boundary.
 */
export function loadBlockUntil(): number {
  return current().blockedUntil ?? 0;
}

export function saveBlockUntil(resetAt: number): void {
  current().blockedUntil = resetAt;
  persist();
}

export function budgetStatus(): { limit: number; spent: number; remaining: number } {
  const l = current();
  return { limit: DAILY_LIMIT, spent: l.spent, remaining: Math.max(0, DAILY_LIMIT - l.spent) };
}
