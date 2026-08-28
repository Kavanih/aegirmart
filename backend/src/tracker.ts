import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { liveMarkets, settledOutcomes, type Market } from "./markets.js";
import { buildEvidence } from "./quant.js";
import { predict, quotaBlockedFor } from "./openrouter.js";
import { noteOutcome } from "./modelStats.js";
import { claimTrackerSpend, budgetStatus } from "./budget.js";
import { runningBots, claimBotRead, refundBotRead, AI_MIN_INTERVAL } from "./bots.js";

const STORE = new URL("../predictions.json", import.meta.url).pathname;
const MAX_RECORDS = 100;
const POLL_MS = 15_000;
// Bound the work per tick so a slow model cannot stall the next sweep.
const MAX_PER_TICK = 2;
/** How far from a coin flip a read must sit to count as a call. */
const MIN_VIEW = Number(process.env.MIN_VIEW ?? 0.05);
/**
 * How far into a window to wait before reading it.
 *
 * At the open, spot sits on the strike and the window really is a coin flip, so
 * the model correctly answers 0.50 and there is nothing to trade. The
 * asymmetry only appears once spot has moved away from the strike with the
 * clock running. Measured over the first sessions:
 *
 *   read at 0-20% of the window   1.5c average conviction, 16% made a call
 *   read at 40-60% of the window  15.5c average conviction, 58% made a call
 *
 * The same allowance buys a usable answer roughly four times as often.
 */
const READ_AFTER = Number(process.env.READ_AFTER ?? 0.4);
/** Seconds that must remain after a read for a bot to act on it. */
const MIN_ACT_SECONDS = Number(process.env.MIN_ACT_SECONDS ?? 80);
/**
 * Which windows to read. A read costs one call from a fixed daily allowance
 * and takes tens of seconds, so the sixty second lane spends the budget on
 * answers that arrive against a price which has already moved. Default to the
 * five minute lane, which is the one an AI bot can act on.
 */
const LANES = (process.env.TRACKER_LANES ?? "300")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

export type PredictionRecord = {
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  /** The model's probability that the up side resolves true. */
  probability: number;
  /**
   * The call. "none" when the model answered close enough to a coin flip that
   * it made no call at all, which is not a prediction and must not be scored
   * as one.
   */
  side: "up" | "down" | "none";
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
// Replay what is already scored, so ranking starts from the whole record
// rather than only from windows that settle after this process started.
for (const r of records) if (r.correct !== null) noteOutcome(r.model, r.correct);
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
    side: callOf(prediction.probability),
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

/**
 * The direction a read actually calls.
 *
 * Reading `p >= 0.5` as "up" turned every 0.50 into an up call, which then
 * scored as a hit whenever the market happened to rise. Fourteen of sixty reads
 * were exactly 0.50, so the scoreboard was substantially measuring coin flips.
 */
function callOf(probability: number): "up" | "down" | "none" {
  if (Math.abs(probability - 0.5) < MIN_VIEW) return "none";
  return probability > 0.5 ? "up" : "down";
}

async function predictMarket(market: Market, apiKey: string, preferred?: string | null): Promise<boolean> {
  const evidence = await buildEvidence(market);
  // Leave a third of the window for the card to actually show the read.
  const remainingMs = (market.expiry - Math.floor(Date.now() / 1000)) * 1000;
  const budget = Math.max(8_000, Math.min(45_000, remainingMs * 0.6));
  const result = await predict(evidence, apiKey, budget, preferred);
  if (result.status !== "ok") return false;

  records.unshift({
    marketId: market.marketId,
    asset: market.asset,
    intervalSec: market.intervalSec,
    strike: market.strike,
    expiry: market.expiry,
    probability: result.prediction.probability,
    side: callOf(result.prediction.probability),
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
  return true;
}

async function scorePending(): Promise<void> {
  const unscored = records.filter(
    (r) => r.correct === null && r.side !== "none" && r.expiry < Math.floor(Date.now() / 1000),
  );
  if (unscored.length === 0) return;

  const outcomes = await settledOutcomes(unscored.map((r) => r.marketId));
  let changed = false;

  for (const record of unscored) {
    const winning = outcomes.get(record.marketId);
    if (winning === undefined) continue;
    // A read that made no call cannot be right or wrong about direction.
    if (record.side === "none") continue;
    // outcomeIndex 0 is the YES/up leg, verified against tokenId.
    record.outcome = winning === 0 ? "up" : "down";
    record.correct = record.side === record.outcome;
    // Feed the result back into model selection. Without this the fallback
    // order was decided by speed alone, and being fast is not being right.
    noteOutcome(record.model, record.correct);
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

      // Nothing is read speculatively any more. A read is only worth its cost
      // if some switched-on bot can act on it, so the running AI bots decide
      // what gets read and pay for it out of their own daily allowance.
      const readers = runningBots().filter((b) => b.kind === "ai");
      if (readers.length === 0) {
        await scorePending().catch(() => undefined);
        return;
      }

      const markets = (await Promise.all(LANES.map((lane) => liveMarkets(lane, 5)))).flat();
      const nowSec = Math.floor(Date.now() / 1000);
      const fresh = markets
        .filter((m) => !records.some((r) => r.marketId === m.marketId) && !inFlight.has(m.marketId) && mayAttempt(m.marketId))
        // Read in the middle of the window, not at its open. Too early and the
        // model has nothing to say; too late and there is no time left to act
        // on what it says.
        .filter((m) => {
          const left = m.expiry - nowSec;
          const elapsed = m.intervalSec - left;
          return elapsed >= m.intervalSec * READ_AFTER && left >= MIN_ACT_SECONDS;
        })
        // Closest to expiry first, so a window about to leave the band is read
        // before one that still has time to wait.
        .sort((a, b) => a.expiry - b.expiry)
        .slice(0, MAX_PER_TICK);

      // Concurrent across markets, so one slow model does not block the others.
      await Promise.all(
        fresh.map(async (market) => {
          // Whoever wants this window pays for it. A bot out of allowance is
          // not a reader, so its markets simply go uncovered.
          const owner = readers.find(
            (b) =>
              (b.asset === "BOTH" || b.asset === market.asset) &&
              market.intervalSec >= AI_MIN_INTERVAL &&
              claimBotRead(b.id),
          );
          if (!owner) return;
          if (!claimTrackerSpend()) return;
          inFlight.add(market.marketId);
          noteAttempt(market.marketId);
          try {
            // An allowance buys a usable read, not an attempt. A provider that
            // refuses would otherwise spend a bot's whole daily budget and
            // leave it with nothing to trade on, which is exactly what a bot
            // pinned to a flaky model did: twenty reads, no predictions.
            if (!(await predictMarket(market, apiKey, owner.model))) refundBotRead(owner.id);
          } catch {
            refundBotRead(owner.id);
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
    `tracker running on the ${LANES.join(", ")}s lane${LANES.length > 1 ? "s" : ""}, ` +
      `reading mid-window for running AI bots, ${remaining}/${limit} free requests left today`,
  );
}
