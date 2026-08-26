import "dotenv/config";
import express from "express";
import { liveMarkets, strikeSeries, positionsFor, leaderboard, settledMarkets, ordersFor, marketById, tradesFor, liveBooks, redemptionsFor } from "./markets.js";
import { costBasisFor, type BasisIndex } from "./fills.js";
import { startTracker, allRecords, modelScores, cachedPrediction, cachedPredictions } from "./tracker.js";
import { allStats } from "./modelStats.js";
import { buildEvidence } from "./quant.js";
import { predict, quotaBlockedFor, freeModels } from "./openrouter.js";
import { TtlCache, RateLimiter } from "./cache.js";
import { botsFor, createBot, updateBot, deleteBot, setBotKey, clearBotKey, planFor, MAX_BOTS, PRO_PRICE, ASSETS, KINDS } from "./bots.js";
import { keyStorageReady } from "./keys.js";
import { TIERS, TREASURY, COLLATERAL, redeem, subscriptionFor, priceOf, type Tier, type Cycle } from "./plans.js";
import { startRunner } from "./runner.js";
import { claimLiveSpend, budgetStatus } from "./budget.js";
import type { PredictionResult } from "./openrouter.js";

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

// Narratives hold until the window closes. The number is recomputed per request.
const narratives = new TtlCache<PredictionResult>();
const seriesCache = new TtlCache<{ t: number; price: number }[]>();
const boardCache = new TtlCache<unknown>();
const settledCache = new TtlCache<Awaited<ReturnType<typeof settledMarkets>>>();
const bookCache = new TtlCache<Awaited<ReturnType<typeof liveBooks>>>();
const modelCache = new TtlCache<string[]>();
const limiter = new RateLimiter(20, 3000);

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, x-session-id");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, keyConfigured: API_KEY.length > 0, freeQuota: budgetStatus() });
});

app.get("/api/markets", async (req, res) => {
  const intervalSec = Number(req.query.intervalSec ?? 300);
  try {
    // Headroom scales with the window so a card cannot lock between fetch and swipe.
    const markets = await liveMarkets(intervalSec, Math.max(15, Math.floor(intervalSec / 10)));

    // Ship spot and a sparkline with the deck so a card renders before the model replies.
    const assets = [...new Set(markets.map((m) => m.asset))];
    const series = await Promise.all(
      assets.map(async (asset) => [asset, await seriesCache.resolve(asset, 20_000, () => strikeSeries(asset, 30))] as const),
    );

    const byAsset = Object.fromEntries(series);
    const spot = Object.fromEntries(
      series.map(([asset, points]) => [asset, points.length ? points[points.length - 1].price : null]),
    );

    res.json({ markets, series: byAsset, spot });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, markets: [] });
  }
});

app.post("/api/prediction", async (req, res) => {
  const sessionId = String(req.header("x-session-id") ?? "anonymous");
  const market = req.body?.market;

  if (!market?.marketId || !market?.asset) {
    res.status(400).json({ status: "unavailable", reason: "market payload required" });
    return;
  }

  if (!API_KEY) {
    res.json({ status: "unavailable", reason: "server key not configured" });
    return;
  }

  const retryAfter = limiter.take(sessionId);
  if (retryAfter > 0) {
    res.status(429).json({ status: "rate_limited", retryAfter });
    return;
  }

  const cached = cachedPrediction(market.marketId);
  if (cached) {
    res.json({
      status: "ok",
      model: cached.model,
      prediction: {
        probability: cached.probability,
        confidence: cached.confidence,
        reasoning: cached.reasoning,
        key_factors: [],
      },
      cached: true,
    });
    return;
  }

  try {
    const evidence = await buildEvidence(market);
    const ttl = Math.max(10_000, evidence.tauSeconds * 1000);

    // resolve() collapses concurrent misses, so a deck of cards costs one call.
    const result = await narratives.resolve(market.marketId, ttl, async () => {
      // Claim only when a request will actually be sent: while the upstream cap
      // is latched no call goes out, so the ledger must not be charged for one.
      if (quotaBlockedFor() > 0) return predict(evidence, API_KEY);
      if (!claimLiveSpend()) {
        const { limit } = budgetStatus();
        return { status: "unavailable", reason: `daily free allowance of ${limit} requests is spent` };
      }
      return predict(evidence, API_KEY);
    });

    // A narrative holds until expiry, but a failure must not: retry in seconds.
    if (result.status !== "ok") narratives.set(market.marketId, result, 5_000);

    res.json({
      ...result,
      evidence: {
        spot: evidence.spot,
        strike: evidence.strike,
        tauSeconds: evidence.tauSeconds,
        vol: evidence.vol,
        modelProbability: evidence.modelProbability,
        baseRateProbability: evidence.baseRateProbability,
        baseRateSample: evidence.baseRateSample,
        marketProbability: evidence.marketProbability,
      },
    });
  } catch (err) {
    res.json({ status: "unavailable", reason: (err as Error).message });
  }
});

/**
 * Resolved windows for the landing page, joined to whatever the model said at
 * the time. Cached: this is history, so it only changes when a window settles.
 */
app.get("/api/settled", async (req, res) => {
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 30)));
  try {
    const rows = await settledCache.resolve(`settled:${limit}`, 20_000, () => settledMarkets(limit));
    const reads = new Map(cachedPredictions(rows.map((r) => r.marketId)).map((p) => [p.marketId, p]));

    res.json({
      settled: rows.map((row) => {
        const read = reads.get(row.marketId);
        return {
          ...row,
          // Null when the model never got to this window, which is not the
          // same as the model having been wrong about it.
          modelProbability: read?.probability ?? null,
          modelSide: read?.side ?? null,
          modelCorrect: read ? read.side === (row.wentUp ? "up" : "down") : null,
        };
      }),
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, settled: [] });
  }
});

// Cached reads only. Never calls a model, so the grid can poll it freely.
app.get("/api/predictions", (req, res) => {
  const ids = String(req.query.ids ?? "").split(",").filter(Boolean);
  res.json({ predictions: ids.length === 0 ? [] : cachedPredictions(ids) });
});

app.get("/api/leaderboard", async (_req, res) => {
  try {
    const rows = await boardCache.resolve("board", 30_000, () => leaderboard(500));
    res.json({ traders: rows });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, traders: [] });
  }
});

app.get("/api/positions", async (req, res) => {
  const address = String(req.query.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "valid address required", positions: [] });
    return;
  }
  try {
    // Basis and redemptions are best effort: an outage must not hide positions.
    const [positions, basis, redemptions] = await Promise.all([
      positionsFor(address, 100),
      costBasisFor(address).catch((): BasisIndex => ({})),
      redemptionsFor(address).catch((): Awaited<ReturnType<typeof redemptionsFor>> => []),
    ]);

    const redeemed = new Map(redemptions.map((r) => [`${r.marketId}:${r.outcomeIndex}`, r]));

    // Holding BOTH legs of a market means a complete set was minted: collateral
    // in, one leg pays it back, the other expires. The overlap is a wash, not a
    // win, and pricing the legs separately is what made it read as free money.
    const held = new Map<string, Map<number, number>>();
    for (const p of positions) {
      const paid = redeemed.get(`${p.marketId}:${p.outcomeIndex}`);
      const size = p.size > 0 ? p.size : paid?.burned ?? 0;
      const legs = held.get(p.marketId) ?? new Map<number, number>();
      legs.set(p.outcomeIndex, (legs.get(p.outcomeIndex) ?? 0) + size);
      held.set(p.marketId, legs);
    }

    const priced = positions.map((p) => {
      const entry = basis[p.marketId]?.[p.outcomeIndex];
      const paid = redeemed.get(`${p.marketId}:${p.outcomeIndex}`);

      // Prefer what was actually redeemed. It is the only figure that survives
      // the claim, so P&L no longer moves when somebody collects.
      const shares = p.size > 0 ? p.size : paid?.burned ?? entry?.shares ?? 0;
      const won = p.finalized && p.winningOutcome === p.outcomeIndex;
      const payout = paid ? paid.collateralOut : p.finalized ? (won ? shares : 0) : null;

      const legs = held.get(p.marketId);
      const other = legs ? legs.get(p.outcomeIndex === 0 ? 1 : 0) ?? 0 : 0;
      const pairedShares = Math.min(shares, other);

      // A minted set costs one collateral per unit and returns one on the
      // winning leg. Charging that cost to the leg that pays makes the pair
      // net to zero across the two rows instead of inventing a profit.
      const mintedCost = won ? pairedShares : 0;
      const cost = entry ? entry.cost + mintedCost : pairedShares > 0 ? mintedCost : null;

      return {
        ...p,
        shares,
        won: p.finalized ? won : null,
        pairedShares,
        /** True when this leg is offset by the other one: a wash, not a result. */
        minted: pairedShares > 0,
        cost,
        averagePrice: entry?.averagePrice ?? null,
        pnl: cost !== null && payout !== null ? payout - cost : null,
      };
    });

    res.json({ positions: priced });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, positions: [] });
  }
});

/**
 * Everything one contract's page needs in a single round trip: the market, the
 * underlying path it settles against, its own prints, and the stored model read.
 */
app.get("/api/market/:marketId", async (req, res) => {
  const marketId = String(req.params.marketId ?? "");
  if (!/^0x[0-9a-fA-F]{2,66}$/.test(marketId)) {
    res.status(400).json({ error: "valid marketId required" });
    return;
  }

  try {
    const market = await marketById(marketId);
    if (!market) {
      res.status(404).json({ error: "market not found" });
      return;
    }

    // Prints are the only real probability history here; the book is thin, so
    // the underlying path against the strike carries the rest of the story.
    const [series, trades] = await Promise.all([
      seriesCache.resolve(market.asset, 20_000, () => strikeSeries(market.asset, 60)),
      tradesFor(marketId, 200).catch((): Awaited<ReturnType<typeof tradesFor>> => []),
    ]);

    const read = cachedPredictions([marketId])[0] ?? null;

    res.json({
      market,
      series,
      trades,
      read: read && {
        probability: read.probability,
        side: read.side,
        confidence: read.confidence,
        reasoning: read.reasoning,
        model: read.model,
        outcome: read.outcome,
        correct: read.correct,
      },
    });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * The live book, for watching whether a maker is actually quoting. Cached
 * briefly: this is read by a page that polls.
 */
app.get("/api/books", async (_req, res) => {
  try {
    res.json({ books: await bookCache.resolve("books", 5_000, () => liveBooks()) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, books: [] });
  }
});

const ADDRESS = /^0x[0-9a-f]{40}$/;

function requireAddress(raw: unknown, res: express.Response): string | null {
  const address = String(raw ?? "").toLowerCase();
  if (!ADDRESS.test(address)) {
    res.status(400).json({ error: "valid address required" });
    return null;
  }
  return address;
}

/** The pricing table, and where a payment has to go. */
app.get("/api/plans", (req, res) => {
  const address = String(req.query.address ?? "").toLowerCase();
  res.json({
    tiers: TIERS,
    treasury: TREASURY,
    token: COLLATERAL,
    subscription: ADDRESS.test(address) ? subscriptionFor(address) : null,
  });
});

/**
 * Turn a paid transaction into a plan. The hash is the only thing the client
 * supplies that matters; everything else is read back off the chain.
 */
app.post("/api/plans/redeem", async (req, res) => {
  const address = requireAddress(req.body?.address, res);
  if (!address) return;

  const tier = String(req.body?.tier ?? "") as Tier;
  const cycle = String(req.body?.cycle ?? "monthly") as Cycle;
  if (!TIERS.some((t) => t.id === tier)) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }
  if (cycle !== "monthly" && cycle !== "yearly") {
    res.status(400).json({ error: "Unknown billing cycle" });
    return;
  }

  const result = await redeem(address, String(req.body?.txHash ?? ""), tier, cycle);
  if ("error" in result) {
    res.status(400).json(result);
    return;
  }
  res.json({ ...result, price: priceOf(tier, cycle) });
});

app.get("/api/bots", (req, res) => {
  const address = requireAddress(req.query.address, res);
  if (!address) return;
  res.json({
    bots: botsFor(address),
    plan: planFor(address),
    limits: { maxBots: MAX_BOTS, proPrice: PRO_PRICE, assets: ASSETS, kinds: KINDS, keyStorage: keyStorageReady() },
  });
});

app.post("/api/bots", (req, res) => {
  const address = requireAddress(req.body?.address, res);
  if (!address) return;
  const result = createBot(address, req.body?.bot ?? {});
  if ("error" in result) {
    res.status(400).json(result);
    return;
  }
  res.status(201).json(result);
});

app.patch("/api/bots/:id", (req, res) => {
  const address = requireAddress(req.body?.address, res);
  if (!address) return;
  const result = updateBot(address, String(req.params.id), req.body?.bot ?? {});
  if ("error" in result) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

app.delete("/api/bots/:id", (req, res) => {
  const address = requireAddress(req.query.address, res);
  if (!address) return;
  if (!deleteBot(address, String(req.params.id))) {
    res.status(404).json({ error: "bot not found" });
    return;
  }
  res.json({ ok: true });
});

/**
 * Store a signing key for one bot. The body carries a secret, so it is never
 * logged and the response echoes only the address the key controls.
 */
app.put("/api/bots/:id/key", (req, res) => {
  const address = requireAddress(req.body?.address, res);
  if (!address) return;
  const result = setBotKey(address, String(req.params.id), String(req.body?.privateKey ?? ""));
  if ("error" in result) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

app.delete("/api/bots/:id/key", (req, res) => {
  const address = requireAddress(req.query.address, res);
  if (!address) return;
  if (!clearBotKey(address, String(req.params.id))) {
    res.status(404).json({ error: "bot not found" });
    return;
  }
  res.json({ ok: true });
});

// The models a pro bot can be pointed at. Reads the catalogue, never the model.
app.get("/api/models", async (_req, res) => {
  try {
    res.json({ models: await modelCache.resolve("models", 3_600_000, () => freeModels()) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, models: [] });
  }
});

// Orders, filled or not. A resting order leaves no balance until it fills, so
// this is the only place an unfilled order is visible.
app.get("/api/orders", async (req, res) => {
  const address = String(req.query.address ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "valid address required", orders: [] });
    return;
  }
  try {
    res.json({ orders: await ordersFor(address, 60) });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, orders: [] });
  }
});

app.get("/api/accuracy", (_req, res) => {
  res.json({ records: allRecords(), models: modelScores(), latency: allStats() });
});

app.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
  console.log(`openrouter key ${API_KEY ? "loaded" : "MISSING, predictions degrade to unavailable"}`);
  // Opt out without editing code: the tracker is the only thing that spends
  // the daily model allowance on its own, so it has to be stoppable.
  if (process.env.TRACKER_ENABLED === "false") {
    console.log("tracker disabled by TRACKER_ENABLED=false, no model calls will be made");
  } else {
    startTracker(API_KEY);
  }
  startRunner();
});
