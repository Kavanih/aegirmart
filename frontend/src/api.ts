export type Market = {
  marketId: string;
  asset: string;
  strike: number;
  expiry: number;
  intervalSec: number;
  lastPrice: number | null;
  tradeCount: number;
  poolAddress: string;
  collateral: string;
};

export type Evidence = {
  spot: number;
  strike: number;
  tauSeconds: number;
  vol: number;
  modelProbability: number;
  baseRateProbability: number;
  baseRateSample: number;
  marketProbability: number | null;
};

export type Prediction = {
  probability: number;
  confidence: "low" | "medium" | "high";
  reasoning: string;
  key_factors: string[];
};

export type PredictionState =
  | { status: "loading" }
  | { status: "ok"; prediction: Prediction; evidence: Evidence; model: string }
  | { status: "unavailable"; reason: string; evidence?: Evidence }
  | { status: "rate_limited"; retryAfter: number };

// One id per browser session so the server can rate limit per user.
const SESSION_ID = Math.random().toString(36).slice(2);

export function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function windowLabel(intervalSec: number): string {
  return intervalSec >= 3600 ? `${intervalSec / 3600} hr` : `${intervalSec / 60} min`;
}

/** Only needs the asset, so a settled row can use it as well as a live one. */
export function title(market: { asset: string }): string {
  return `${market.asset} Up or Down`;
}

// Local clock range for the window, matching how venues label their contracts.
export function windowRange(market: Market): string {
  const end = new Date(market.expiry * 1000);
  const start = new Date((market.expiry - market.intervalSec) * 1000);
  const fmt = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${fmt(start)} - ${fmt(end)}`;
}

export function cents(probability: number): string {
  return `${Math.round(probability * 100)}c`;
}

export function countdown(expiry: number, now: number): string {
  const left = Math.max(0, expiry - now);
  const m = Math.floor(left / 60);
  const s = left % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export type PricePoint = { t: number; price: number };

export type Deck = {
  markets: Market[];
  series: Record<string, PricePoint[]>;
  spot: Record<string, number | null>;
};

export async function fetchMarkets(intervalSec: number): Promise<Deck> {
  const res = await fetch(`/api/markets?intervalSec=${intervalSec}`);
  if (!res.ok) throw new Error(`markets ${res.status}`);
  return (await res.json()) as Deck;
}

export async function fetchPrediction(market: Market): Promise<PredictionState> {
  const res = await fetch("/api/prediction", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": SESSION_ID },
    body: JSON.stringify({ market }),
  });

  const json = await res.json();

  if (res.status === 429) {
    return { status: "rate_limited", retryAfter: Number(json.retryAfter ?? 5) };
  }
  if (json.status === "ok") {
    return { status: "ok", prediction: json.prediction, evidence: json.evidence, model: json.model };
  }
  return { status: "unavailable", reason: String(json.reason ?? "unknown"), evidence: json.evidence };
}

export type Trader = { account: string; settled: number; wins: number; winRate: number; volume: number };

export type Position = {
  marketId: string;
  poolAddress: string;
  outcomeId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  outcomeIndex: number;
  size: number;
  /** Shares bought, recovered from fills when a redeemed win has no balance. */
  shares: number;
  finalized: boolean;
  winningOutcome: number | null;
  /** Settled and already redeemed on chain. */
  claimed: boolean;
  won: boolean | null;
  cost: number | null;
  averagePrice: number | null;
  pnl: number | null;
};

export type Like = { marketId: string; count: number; liked: boolean };

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export type Health = {
  ok: boolean;
  keyConfigured: boolean;
  freeQuota: { limit: number; spent: number; remaining: number };
};

export async function fetchHealth(): Promise<Health | null> {
  const res = await fetch("/api/health");
  if (!res.ok) return null;
  return (await res.json()) as Health;
}

export type SettledMarket = {
  marketId: string;
  asset: string;
  strike: number;
  expiry: number;
  intervalSec: number;
  wentUp: boolean;
  lastPrice: number | null;
  tradeCount: number;
  /** Where the underlying closed, recovered from the next window's mint. */
  settlePrice: number | null;
  modelProbability: number | null;
  modelSide: "up" | "down" | null;
  /** Null when the model never read this window, which is not the same as wrong. */
  modelCorrect: boolean | null;
};

export async function fetchSettled(limit = 30): Promise<SettledMarket[]> {
  const res = await fetch(`/api/settled?limit=${limit}`);
  if (!res.ok) return [];
  return ((await res.json()) as { settled: SettledMarket[] }).settled;
}

/** Compact relative age, so a strip of results reads at a glance. */
export function ago(expiry: number, now: number): string {
  const secs = Math.max(0, now - expiry);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/**
 * Reads the tracker's stored predictions. Costs nothing against the model
 * allowance, so the grid can poll it as often as it polls markets.
 */
export async function fetchPredictions(ids: string[]): Promise<PredictionRecord[]> {
  if (ids.length === 0) return [];
  const res = await fetch(`/api/predictions?ids=${ids.join(",")}`);
  if (!res.ok) return [];
  return ((await res.json()) as { predictions: PredictionRecord[] }).predictions;
}

export async function fetchLeaderboard(): Promise<Trader[]> {
  const res = await fetch("/api/leaderboard");
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  return ((await res.json()) as { traders: Trader[] }).traders;
}

export async function fetchPositions(address: string): Promise<Position[]> {
  const res = await fetch(`/api/positions?address=${address}`);
  if (!res.ok) throw new Error(`positions ${res.status}`);
  return ((await res.json()) as { positions: Position[] }).positions;
}

export async function fetchLikes(ids: string[], address: string | null): Promise<Like[]> {
  if (ids.length === 0) return [];
  const query = new URLSearchParams({ ids: ids.join(",") });
  if (address) query.set("address", address);
  const res = await fetch(`/api/likes?${query}`);
  if (!res.ok) return [];
  return ((await res.json()) as { likes: Like[] }).likes;
}

export async function toggleLike(marketId: string, address: string) {
  const res = await fetch("/api/likes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ marketId, address }),
  });
  if (!res.ok) throw new Error("like failed");
  return (await res.json()) as { count: number; liked: boolean };
}

export type PredictionRecord = {
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  probability: number;
  side: "up" | "down";
  confidence: "low" | "medium" | "high";
  reasoning: string;
  model: string;
  predictedAt: number;
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

export type ModelLatency = {
  model: string;
  ok: number;
  fail: number;
  avgMs: number;
  rateLimitedUntil: number;
  lastOkAt: number;
};

export async function fetchAccuracy(): Promise<{
  records: PredictionRecord[];
  models: ModelScore[];
  latency: ModelLatency[];
}> {
  const res = await fetch("/api/accuracy");
  if (!res.ok) throw new Error(`accuracy ${res.status}`);
  return (await res.json()) as { records: PredictionRecord[]; models: ModelScore[]; latency: ModelLatency[] };
}
