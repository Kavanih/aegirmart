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
  /** Absent on a stored read, which keeps only the numbers and the reasoning. */
  key_factors?: string[];
};

export type PredictionState =
  /** No read yet and none asked for. Costs nothing and stays that way. */
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; prediction: Prediction; evidence?: Evidence; model: string }
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
/**
 * How old the spot proxy is.
 *
 * There is no tick feed here: the venue mints at the money every sixty
 * seconds, so the newest strike IS the price, and it is between nought and
 * sixty seconds old. On a one minute contract that is the whole window, so it
 * is worth saying rather than calling it current.
 */
export function spotAge(series: PricePoint[], now: number): number | null {
  if (series.length === 0) return null;
  return Math.max(0, now - series[series.length - 1].t);
}

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
  /** Shares offset by the opposite leg: a minted set, not a directional bet. */
  pairedShares: number;
  minted: boolean;
  cost: number | null;
  averagePrice: number | null;
  pnl: number | null;
};

export type VenueStats = { volume: number; trades: number; traders: number };
export type StrategyRow = { kind: BotKind; trades: number; settled: number; won: number; winRate: number };

export async function fetchStats(): Promise<{ venue: VenueStats; strategies: StrategyRow[] } | null> {
  const res = await fetch("/api/stats");
  if (!res.ok) return null;
  return await res.json();
}

export type Tier = "free" | "starter" | "pro";
export type Cycle = "monthly" | "yearly";

export type TierSpec = {
  id: Tier;
  name: string;
  tagline: string;
  monthly: number;
  yearly: number;
  yearlyDiscount: number;
  dailyTrades: number;
  strategyBots: boolean;
  aiBots: boolean;
  paidModels: boolean;
  features: string[];
};

export type Subscription = {
  address: string;
  plan: Tier;
  cycle: Cycle | null;
  since: number;
  expires: number | null;
  txHash: string | null;
};

export async function fetchPlans(address?: string): Promise<{
  tiers: TierSpec[];
  treasury: string;
  token: string;
  subscription: Subscription | null;
} | null> {
  const res = await fetch(`/api/plans${address ? `?address=${address}` : ""}`);
  if (!res.ok) return null;
  return await res.json();
}

/** Hands the payment hash over. The grant is decided by reading it on chain. */
export async function redeemPlan(
  address: string,
  txHash: string,
  tier: Tier,
  cycle: Cycle,
): Promise<string | null> {
  const res = await fetch("/api/plans/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, txHash, tier, cycle }),
  });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not confirm the payment";
}

export type BotKind = "standard" | "quant" | "ai";

export type Bot = {
  id: string;
  address: string;
  name: string;
  kind: BotKind;
  asset: "BTC" | "ETH" | "BOTH";
  stake: number;
  dailyTrades: number;
  spread: number;
  /** Floor on the chance of winning before a directional bot acts. */
  minProbability: number;
  model: string | null;
  status: "running" | "paused";
  createdAt: number;
  updatedAt: number;
  /** The address the stored signing key controls, or null when none is set. */
  keyAddress: string | null;
  tradesToday: number;
  tradeDay: string;
};

export type BotSummary = { placed: number; filled: number; open: number; expired: number; volume: number };
export type BotStats = {
  settled: number;
  won: number;
  winRate: number;
  realised: number;
  lost: number;
  priced: number;
  unpriced: number;
};

export async function fetchBotActivity(address: string, id: string): Promise<{
  bot: Bot;
  orders: OrderRow[];
  summary: BotSummary | null;
  stats: BotStats | null;
  keyChanged: boolean;
  recordedMarkets: number;
} | null> {
  const res = await fetch(`/api/bots/${id}/activity?address=${address}`);
  if (!res.ok) return null;
  return await res.json();
}

export type Plan = Subscription;
export type BotLimits = {
  maxBots: number;
  /** How many of those may run at once on the current plan. */
  maxRunning: number;
  proPrice: number;
  assets: string[];
  kinds: string[];
  /** False when the server has no encryption secret, so no key can be stored. */
  keyStorage: boolean;
};
export type BotDraft = Partial<
  Pick<Bot, "name" | "kind" | "asset" | "stake" | "dailyTrades" | "spread" | "minProbability" | "model" | "status">
>;

export async function fetchBots(address: string): Promise<{ bots: Bot[]; plan: Plan; limits: BotLimits } | null> {
  const res = await fetch(`/api/bots?address=${address}`);
  if (!res.ok) return null;
  return await res.json();
}

/** Resolves to an error string the form can show, or null on success. */
export async function saveBot(address: string, draft: BotDraft, id?: string): Promise<string | null> {
  const res = await fetch(id ? `/api/bots/${id}` : "/api/bots", {
    method: id ? "PATCH" : "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, bot: draft }),
  });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not save the bot";
}

export async function removeBot(address: string, id: string): Promise<boolean> {
  const res = await fetch(`/api/bots/${id}?address=${address}`, { method: "DELETE" });
  return res.ok;
}

/** Sends the key once. It is sealed server side and never returned. */
export async function storeBotKey(address: string, id: string, privateKey: string): Promise<string | null> {
  const res = await fetch(`/api/bots/${id}/key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, privateKey }),
  });
  if (res.ok) return null;
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not store the key";
}

export async function clearBotKey(address: string, id: string): Promise<boolean> {
  const res = await fetch(`/api/bots/${id}/key?address=${address}`, { method: "DELETE" });
  return res.ok;
}

export async function fetchModels(): Promise<string[]> {
  const res = await fetch("/api/models");
  if (!res.ok) return [];
  return ((await res.json()) as { models: string[] }).models;
}

export type BookLevel = { side: string; price: number; size: number; owner: string };
export type MarketBook = {
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  lastPrice: number | null;
  tradeCount: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

export async function fetchBooks(): Promise<MarketBook[]> {
  const res = await fetch("/api/books");
  if (!res.ok) return [];
  return ((await res.json()) as { books: MarketBook[] }).books;
}

export type MarketTrade = {
  t: number;
  price: number;
  size: number;
  takerSide: string;
  buyer: string;
  seller: string;
};

export type MarketRead = {
  probability: number;
  side: "up" | "down";
  confidence: "low" | "medium" | "high";
  reasoning: string;
  model: string;
  outcome: "up" | "down" | null;
  correct: boolean | null;
};

export type Holding = { outcomeIndex: number; shares: number; cost: number | null; pnl: number | null };

export type MarketDetail = {
  market: Market & { finalized?: boolean; wentUp?: boolean | null };
  series: PricePoint[];
  trades: MarketTrade[];
  holdings: Holding[];
  myOrders: OrderRow[];
  read: MarketRead | null;
};

export async function fetchMarketDetail(marketId: string, address?: string): Promise<MarketDetail | null> {
  const res = await fetch(`/api/market/${marketId}${address ? `?address=${address}` : ""}`);
  if (!res.ok) return null;
  return (await res.json()) as MarketDetail;
}

export type OrderRow = {
  orderId: string;
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  side: string;
  outcomeIndex: number;
  price: number;
  quantity: number;
  filled: number;
  remaining: number;
  status: string;
  rested: boolean;
  /** The raw YES price the venue stores, for anything working in book terms. */
  priceYes: number;
  /** Null while the window is open, or on a side that cannot be priced. */
  won: boolean | null;
  /** What this one order made or lost once its window settled. */
  pnl: number | null;
  placedAt: number;
  txHash: string;
};

export async function fetchOrders(address: string): Promise<OrderRow[]> {
  const res = await fetch(`/api/orders?address=${address}`);
  if (!res.ok) return [];
  return ((await res.json()) as { orders: OrderRow[] }).orders;
}

/** Absolute local date and time, for a history row that needs to be pinned down. */
export function stamp(seconds: number): string {
  if (!seconds) return "--";
  const d = new Date(seconds * 1000);
  return `${d.toLocaleDateString([], { day: "2-digit", month: "short" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

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
/** Turns a stored record into the shape a card renders, without a model call. */
export function recordToState(r: PredictionRecord): PredictionState {
  return {
    status: "ok",
    model: r.model,
    prediction: { probability: r.probability, confidence: r.confidence, reasoning: r.reasoning },
  };
}

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

export async function fetchPositions(address: string): Promise<{ positions: Position[]; stats: BotStats }> {
  const res = await fetch(`/api/positions?address=${address}`);
  if (!res.ok) throw new Error(`positions ${res.status}`);
  return (await res.json()) as { positions: Position[]; stats: BotStats };
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
