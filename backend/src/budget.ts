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

/**
 * True when the tracker may spend one request now.
 *
 * Nothing paces this any more. Spreading the allowance across the day meant a
 * read every forty eight minutes, which is not coverage of a five minute
 * window, and an operator watching a bot could not tell a paced-out tracker
 * from a broken one. The throttle is now the operator: the tracker only reads
 * for a bot that is switched on and still holds a daily read allowance, so
 * turning a bot off stops the spend.
 */
export function claimTrackerSpend(): boolean {
  const l = current();
  if (l.spent >= DAILY_LIMIT) return false;
  l.spent += 1;
  persist();
  return true;
}

/**
 * Hand a claimed request back when nothing was served for it.
 *
 * The ledger exists to model the upstream daily cap, and a provider that
 * answers "temporarily overloaded" served no completion to count. Without this
 * a flaky model drains the day's budget on refusals. If the assumption is ever
 * wrong the upstream 429 latch still stops us.
 */
export function refundSpend(): void {
  const l = current();
  if (l.spent <= 0) return;
  l.spent -= 1;
  persist();
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
