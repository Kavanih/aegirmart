import "dotenv/config";
import express from "express";
import { liveMarkets, strikeSeries, positionsFor, leaderboard } from "./markets.js";
import { likesFor, toggleLike } from "./social.js";
import { costBasisFor, type BasisIndex } from "./fills.js";
import { startTracker, allRecords, modelScores, cachedPrediction, cachedPredictions } from "./tracker.js";
import { allStats } from "./modelStats.js";
import { buildEvidence } from "./quant.js";
import { predict, quotaBlockedFor } from "./openrouter.js";
import { TtlCache, RateLimiter } from "./cache.js";
import { claimLiveSpend, budgetStatus } from "./budget.js";
import type { PredictionResult } from "./openrouter.js";

const PORT = Number(process.env.PORT ?? 8787);
const API_KEY = process.env.OPENROUTER_API_KEY ?? "";

// Narratives hold until the window closes. The number is recomputed per request.
const narratives = new TtlCache<PredictionResult>();
const seriesCache = new TtlCache<{ t: number; price: number }[]>();
const boardCache = new TtlCache<unknown>();
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
    // Basis is best effort: a fills outage must not hide the positions.
    const [positions, basis] = await Promise.all([
      positionsFor(address, 100),
      costBasisFor(address).catch((): BasisIndex => ({})),
    ]);

    const priced = positions.map((p) => {
      const entry = basis[p.marketId]?.[p.outcomeIndex];
      const payout = p.finalized && p.winningOutcome === p.outcomeIndex ? p.size : p.finalized ? 0 : null;
      return {
        ...p,
        cost: entry?.cost ?? null,
        averagePrice: entry?.averagePrice ?? null,
        pnl: entry && payout !== null ? payout - entry.cost : null,
      };
    });

    res.json({ positions: priced });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message, positions: [] });
  }
});

app.get("/api/likes", (req, res) => {
  const ids = String(req.query.ids ?? "").split(",").filter(Boolean);
  const address = String(req.query.address ?? "").toLowerCase() || null;
  res.json({ likes: likesFor(ids, address) });
});

app.post("/api/likes", (req, res) => {
  const marketId = String(req.body?.marketId ?? "");
  const address = String(req.body?.address ?? "").toLowerCase();
  if (!marketId || !/^0x[0-9a-f]{40}$/.test(address)) {
    res.status(400).json({ error: "marketId and a connected address are required" });
    return;
  }
  res.json(toggleLike(marketId, address));
});

app.get("/api/accuracy", (_req, res) => {
  res.json({ records: allRecords(), models: modelScores(), latency: allStats() });
});

app.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
  console.log(`openrouter key ${API_KEY ? "loaded" : "MISSING, predictions degrade to unavailable"}`);
  startTracker(API_KEY);
});
