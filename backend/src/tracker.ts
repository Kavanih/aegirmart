import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { liveMarkets, settledOutcomes, type Market } from "./markets.js";
import { buildEvidence } from "./quant.js";
import { predict, quotaBlockedFor } from "./openrouter.js";
import { claimTrackerSpend, budgetStatus } from "./budget.js";

const STORE = new URL("../predictions.json", import.meta.url).pathname;
const MAX_RECORDS = 100;
const POLL_MS = 15_000;
// Bound the work per tick so a slow model cannot stall the next sweep.
const MAX_PER_TICK = 2;
const LANES = [60, 300];

export type PredictionRecord = {
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  /** The model's probability that the up side resolves true. */
  probability: number;
  side: "up" | "down";
  confidence: "low" | "medium" | "high";
  reasoning: string;
  model: string;
  predictedAt: number;
  /** Null until the window settles. */
  outcome: "up" | "down" | null;
  correct: boolean | null;
};

export type ModelScore = {
  model: string;
  scored: number;
  correct: number;
  accuracy: number;
  brier: number;
  pending: number;
};

let records: PredictionRecord[] = load();
// Guards against a second tick re-requesting a market still being predicted.
const inFlight = new Set<string>();
// Without backoff the same uncovered market is retried every tick and eats the
// whole outbound budget, starving every market that mints after it.
const attempts = new Map<string, { count: number; nextTryAt: number }>();
const MAX_ATTEMPTS = 2;

function mayAttempt(marketId: string): boolean {
  const a = attempts.get(marketId);
  if (!a) return true;
  return a.count < MAX_ATTEMPTS && Date.now() >= a.nextTryAt;
}

function noteAttempt(marketId: string): void {
  const a = attempts.get(marketId) ?? { count: 0, nextTryAt: 0 };
  a.count += 1;
  a.nextTryAt = Date.now() + 20_000 * a.count;
  attempts.set(marketId, a);
  if (attempts.size > 400) attempts.clear();
}

function load(): PredictionRecord[] {
  if (!existsSync(STORE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    writeFileSync(STORE, JSON.stringify(records));
  } catch {
    // Losing a record must never take the poller down.
  }
}

export function allRecords(): PredictionRecord[] {
  return [...records].sort((a, b) => b.predictedAt - a.predictedAt);
}

/** Ranked by accuracy, then by Brier score, over settled predictions only. */
export function modelScores(): ModelScore[] {
  const byModel = new Map<string, ModelScore>();

  for (const r of records) {
    const entry = byModel.get(r.model) ?? { model: r.model, scored: 0, correct: 0, accuracy: 0, brier: 0, pending: 0 };
    if (r.correct === null) {
      entry.pending += 1;
    } else {
      entry.scored += 1;
      if (r.correct) entry.correct += 1;
      // Brier over the up-probability against the realised outcome.
      const actual = r.outcome === "up" ? 1 : 0;
      entry.brier += (r.probability - actual) ** 2;
    }
    byModel.set(r.model, entry);
  }

  return [...byModel.values()]
    .map((m) => ({
      ...m,
      accuracy: m.scored ? m.correct / m.scored : 0,
      brier: m.scored ? m.brier / m.scored : 0,
    }))
    .sort((a, b) => b.accuracy - a.accuracy || a.brier - b.brier);
}

/** The stored read for a market, so a card never waits on the model. */
export function cachedPrediction(marketId: string): PredictionRecord | undefined {
  return records.find((r) => r.marketId === marketId);
}

/**
 * Batch lookup for the grid. Reads only what the tracker already stored, so a
 * page of cards costs nothing against the daily allowance.
 */
export function cachedPredictions(ids: string[]): PredictionRecord[] {
  const wanted = new Set(ids);
  return records.filter((r) => wanted.has(r.marketId));
}

/**
 * Store a read against a market.
 *
 * Used by the tracker and by a read someone asked for by hand: both cost the
 * same allowance, so both belong in the record and both should be reusable
 * rather than answered twice.
 */
export function recordRead(
  market: { marketId: string; asset: string; intervalSec: number; strike: number; expiry: number },
  prediction: { probability: number; confidence: "low" | "medium" | "high"; reasoning: string },
  model: string,
): void {
  if (records.some((r) => r.marketId === market.marketId)) return;

  records.unshift({
    marketId: market.marketId,
    asset: market.asset,
    intervalSec: market.intervalSec,
    strike: market.strike,
    expiry: market.expiry,
    probability: prediction.probability,
    side: prediction.probability >= 0.5 ? "up" : "down",
    confidence: prediction.confidence,
    reasoning: prediction.reasoning,
    model,
    predictedAt: Math.floor(Date.now() / 1000),
    outcome: null,
    correct: null,
  });

  if (records.length > MAX_RECORDS) records = records.slice(0, MAX_RECORDS);
  persist();
}

async function predictMarket(market: Market, apiKey: string): Promise<void> {
  const evidence = await buildEvidence(market);
  // Leave a third of the window for the card to actually show the read.
  const remainingMs = (market.expiry - Math.floor(Date.now() / 1000)) * 1000;
  const budget = Math.max(8_000, Math.min(45_000, remainingMs * 0.6));
  const result = await predict(evidence, apiKey, budget);
  if (result.status !== "ok") return;

  records.unshift({
    marketId: market.marketId,
    asset: market.asset,
    intervalSec: market.intervalSec,
    strike: market.strike,
    expiry: market.expiry,
    probability: result.prediction.probability,
    side: result.prediction.probability >= 0.5 ? "up" : "down",
    confidence: result.prediction.confidence,
    reasoning: result.prediction.reasoning,
    model: result.model,
    predictedAt: Math.floor(Date.now() / 1000),
    outcome: null,
    correct: null,
  });

  // Ring buffer, so the store cannot grow without bound.
  if (records.length > MAX_RECORDS) records = records.slice(0, MAX_RECORDS);
  persist();
}

async function scorePending(): Promise<void> {
  const unscored = records.filter((r) => r.correct === null && r.expiry < Math.floor(Date.now() / 1000));
  if (unscored.length === 0) return;

  const outcomes = await settledOutcomes(unscored.map((r) => r.marketId));
  let changed = false;

  for (const record of unscored) {
    const winning = outcomes.get(record.marketId);
    if (winning === undefined) continue;
    // outcomeIndex 0 is the YES/up leg, verified against tokenId.
    record.outcome = winning === 0 ? "up" : "down";
    record.correct = record.side === record.outcome;
    changed = true;
  }

  if (changed) persist();
}

export function startTracker(apiKey: string): void {
  if (!apiKey) {
    console.log("tracker idle: no OPENROUTER_API_KEY");
    return;
  }

  const tick = async () => {
    try {
      // Scoring reads the indexer, not the model, so it runs even with no budget.
      if (quotaBlockedFor() > 0) {
        await scorePending().catch(() => undefined);
        return;
      }

      const markets = (await Promise.all(LANES.map((lane) => liveMarkets(lane, 5)))).flat();
      const fresh = markets
        .filter((m) => !records.some((r) => r.marketId === m.marketId) && !inFlight.has(m.marketId) && mayAttempt(m.marketId))
        // Shortest window first: a 60s market goes stale before a 5 minute one.
        .sort((a, b) => a.expiry - b.expiry)
        .slice(0, MAX_PER_TICK);

      // Concurrent across markets, so one slow model does not block the others.
      await Promise.all(
        fresh.map(async (market) => {
          // Paced against the day's allowance so the first minutes of uptime
          // cannot consume every request a person might swipe for later.
          if (!claimTrackerSpend()) return;
          inFlight.add(market.marketId);
          noteAttempt(market.marketId);
          try {
            await predictMarket(market, apiKey);
          } catch {
            // Retried on a later tick; no record means not yet covered.
          } finally {
            inFlight.delete(market.marketId);
          }
        }),
      );

      await scorePending().catch(() => undefined);
    } catch {
      // Poller must survive an indexer blip.
    }
  };

  void tick();
  setInterval(() => void tick(), POLL_MS);
  const { limit, remaining } = budgetStatus();
  console.log(
    `tracker running, polling every ${POLL_MS / 1000}s, keeping ${MAX_RECORDS} records, ` +
      `${remaining}/${limit} free requests left today`,
  );
}
