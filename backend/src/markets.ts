const GRAPHQL = process.env.SOMNIA_GRAPHQL ?? "https://dev.smk.somnia.host/v1/graphql";
const VENUE_ID = process.env.VENUE_ID ?? "0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f";

// Strikes arrive as integer cents against the underlying pair.
const STRIKE_SCALE = 100;
// Book prices arrive in raw collateral units; a binary price is a probability.
const PRICE_SCALE = 1e6;

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

export type Candle = { bucketStart: number; closePrice: number };

async function query<T>(body: string): Promise<T> {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`indexer ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (!json.data) throw new Error(`indexer returned no data: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function toMarket(row: Record<string, string | null>): Market {
  return {
    marketId: String(row.marketId),
    asset: String(row.asset),
    strike: Number(row.strike) / STRIKE_SCALE,
    expiry: Number(row.expiry),
    intervalSec: Number(row.intervalSec),
    lastPrice: row.lastPrice === null ? null : Number(row.lastPrice) / PRICE_SCALE,
    tradeCount: Number(row.tradeCount ?? 0),
    poolAddress: String(row.poolAddress ?? ""),
    collateral: String(row.collateral ?? ""),
  };
}

// The indexer carries dead rows from retired venues, so gate on venue,
// a future expiry, and a real strike rather than trusting clobStatus alone.
export async function liveMarkets(intervalSec: number, headroomSec: number): Promise<Market[]> {
  const now = Math.floor(Date.now() / 1000);
  const floor = now + headroomSec;

  const body = JSON.stringify({
    query: `query Live($venue: String!, $floor: numeric!, $interval: numeric!) {
      Market(
        limit: 20
        where: {
          venueId: {_eq: $venue}
          clobStatus: {_eq: "Trading"}
          expiry: {_gt: $floor}
          intervalSec: {_eq: $interval}
        }
        order_by: {expiry: asc}
      ) { marketId asset strike expiry intervalSec lastPrice tradeCount poolAddress collateral }
    }`,
    variables: { venue: VENUE_ID, floor: String(floor), interval: String(intervalSec) },
  });

  const data = await query<{ Market: Record<string, string | null>[] }>(body);
  return data.Market.map(toMarket).filter((m) => m.strike > 0);
}

export async function recentCloses(asset: string, limit: number): Promise<Candle[]> {
  const body = JSON.stringify({
    query: `query Closes($limit: Int!) {
      Candle(limit: $limit, order_by: {bucketStart: desc}, where: {intervalSeconds: {_eq: 60}}) {
        bucketStart closePrice
      }
    }`,
    variables: { limit },
  });

  const data = await query<{ Candle: Record<string, string>[] }>(body);
  return data.Candle.map((c) => ({
    bucketStart: Number(c.bucketStart),
    closePrice: Number(c.closePrice),
  })).filter((c) => Number.isFinite(c.closePrice) && c.closePrice > 0);
}

// Settled history for the empirical base rate. Outcome 0 means the up side won,
// matching OutcomeBalance where index 0 is the YES/up leg. Verified against 598
// settled 60s windows by reconstructing spot from the next window's strike.
export async function settledHistory(asset: string, intervalSec: number, limit: number) {
  const body = JSON.stringify({
    query: `query Settled($venue: String!, $asset: String!, $interval: numeric!, $limit: Int!) {
      Market(
        limit: $limit
        where: {
          venueId: {_eq: $venue}
          asset: {_eq: $asset}
          intervalSec: {_eq: $interval}
          finalized: {_eq: true}
        }
        order_by: {expiry: desc}
      ) { strike expiry winningOutcome }
    }`,
    variables: { venue: VENUE_ID, asset, interval: String(intervalSec), limit },
  });

  const data = await query<{ Market: { strike: string; expiry: string; winningOutcome: number | null }[] }>(body);
  return data.Market
    .filter((m) => m.winningOutcome !== null && Number(m.strike) > 0)
    .map((m) => ({
      strike: Number(m.strike) / STRIKE_SCALE,
      expiry: Number(m.expiry),
      wentUp: m.winningOutcome === 0,
    }));
}

export type PricePoint = { t: number; price: number };

// Each window mints at the money, so the strike history is a price series.
export async function strikeSeries(asset: string, limit: number): Promise<PricePoint[]> {
  const body = JSON.stringify({
    query: `query Series($venue: String!, $asset: String!, $limit: Int!) {
      Market(
        limit: $limit
        where: {venueId: {_eq: $venue}, asset: {_eq: $asset}, intervalSec: {_eq: "60"}, strike: {_gt: "0"}}
        order_by: {expiry: desc}
      ) { expiry strike }
    }`,
    variables: { venue: VENUE_ID, asset, limit },
  });

  const data = await query<{ Market: { expiry: string; strike: string }[] }>(body);
  return data.Market
    .map((m) => ({ t: Number(m.expiry), price: Number(m.strike) / STRIKE_SCALE }))
    .reverse();
}

// Latest strike doubles as a spot reference: the venue mints it at the money.
export async function spotReference(asset: string): Promise<number | null> {
  const body = JSON.stringify({
    query: `query Spot($venue: String!, $asset: String!) {
      Market(limit: 1, where: {venueId: {_eq: $venue}, asset: {_eq: $asset}, strike: {_gt: "0"}}, order_by: {expiry: desc}) {
        strike
      }
    }`,
    variables: { venue: VENUE_ID, asset },
  });

  const data = await query<{ Market: { strike: string }[] }>(body);
  const row = data.Market[0];
  return row ? Number(row.strike) / STRIKE_SCALE : null;
}

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
  finalized: boolean;
  winningOutcome: number | null;
  /** Settled and already redeemed: the outcome tokens were burned to zero. */
  claimed: boolean;
};

const COLLATERAL_SCALE = 1e6;

function toPosition(row: Record<string, any>): Position {
  const m = row.market ?? {};
  return {
    marketId: String(m.marketId ?? ""),
    poolAddress: String(m.poolAddress ?? ""),
    outcomeId: String(row.tokenId ?? ""),
    asset: String(m.asset ?? ""),
    intervalSec: Number(m.intervalSec ?? 0),
    strike: Number(m.strike ?? 0) / STRIKE_SCALE,
    expiry: Number(m.expiry ?? 0),
    outcomeIndex: Number(row.outcomeIndex),
    size: Number(row.balance) / COLLATERAL_SCALE,
    finalized: Boolean(m.finalized),
    winningOutcome: m.winningOutcome === null || m.winningOutcome === undefined ? null : Number(m.winningOutcome),
    claimed: Boolean(m.finalized) && Number(row.balance) === 0,
  };
}

const POSITION_FIELDS = `account balance outcomeIndex tokenId
  market { marketId asset intervalSec strike expiry finalized winningOutcome poolAddress yesTokenId noTokenId }`;

export type SettledMarket = {
  marketId: string;
  asset: string;
  strike: number;
  expiry: number;
  intervalSec: number;
  /** True when the up side resolved. Outcome 0 is up, verified on chain. */
  wentUp: boolean;
  lastPrice: number | null;
  tradeCount: number;
  /** Where the underlying actually closed, or null when it cannot be recovered. */
  settlePrice: number | null;
};

/**
 * Recently resolved windows across every lane, newest first. Read only: the
 * landing page shows these as history, so nothing here is tradeable.
 *
 * The venue mints every window at the money, so the strike of the window that
 * opened at this one's expiry is the spot price at settlement. Over fetch a
 * little to give the newest rows a neighbour to pair against.
 */
export async function settledMarkets(limit: number): Promise<SettledMarket[]> {
  const body = JSON.stringify({
    query: `query Settled($venue: String!, $limit: Int!) {
      Market(
        limit: $limit
        where: {
          venueId: {_eq: $venue}
          strike: {_gt: "0"}
        }
        order_by: {expiry: desc}
      ) { marketId asset strike expiry intervalSec winningOutcome lastPrice tradeCount }
    }`,
    // Unsettled windows are kept for the mint index: a window that closed needs
    // the one that opened at its expiry, and that successor is often still live.
    variables: { venue: VENUE_ID, limit: limit + 24 },
  });

  const data = await query<{ Market: Record<string, string | null>[] }>(body);
  const all = data.Market.map((m) => ({
    asset: String(m.asset),
    intervalSec: Number(m.intervalSec),
    expiry: Number(m.expiry),
    strike: Number(m.strike) / STRIKE_SCALE,
  }));

  const mintedAt = new Map<string, number>();
  for (const r of all) mintedAt.set(`${r.asset}:${r.intervalSec}:${r.expiry - r.intervalSec}`, r.strike);

  const rows = data.Market
    .filter((m) => m.winningOutcome !== null)
    .map((m) => ({
      marketId: String(m.marketId),
      asset: String(m.asset),
      strike: Number(m.strike) / STRIKE_SCALE,
      expiry: Number(m.expiry),
      intervalSec: Number(m.intervalSec),
      wentUp: Number(m.winningOutcome) === 0,
      lastPrice: m.lastPrice === null ? null : Number(m.lastPrice) / PRICE_SCALE,
      tradeCount: Number(m.tradeCount ?? 0),
      settlePrice: null as number | null,
    }));

  for (const r of rows) {
    r.settlePrice = mintedAt.get(`${r.asset}:${r.intervalSec}:${r.expiry}`) ?? null;
  }

  return rows.slice(0, limit);
}

export async function positionsFor(address: string, limit: number): Promise<Position[]> {
  const body = JSON.stringify({
    query: `query Positions($account: String!, $limit: Int!) {
      OutcomeBalance(
        limit: $limit
        where: {
          account: {_eq: $account}
          _or: [{balance: {_gt: "0"}}, {market: {finalized: {_eq: true}}}]
        }
        order_by: {balance: desc}
      ) {
        ${POSITION_FIELDS}
      }
    }`,
    variables: { account: address.toLowerCase(), limit },
  });

  const data = await query<{ OutcomeBalance: Record<string, any>[] }>(body);
  return data.OutcomeBalance.map(toPosition).filter((p) => p.marketId);
}

export type OrderRow = {
  orderId: string;
  marketId: string;
  asset: string;
  intervalSec: number;
  strike: number;
  expiry: number;
  side: string;
  /** The leg the order buys: 0 is up/YES, matching OutcomeBalance. */
  outcomeIndex: number;
  price: number;
  quantity: number;
  filled: number;
  remaining: number;
  status: string;
  rested: boolean;
  placedAt: number;
  txHash: string;
};

/**
 * The account's orders, filled or not. A resting limit order leaves no balance
 * until it fills, so without this an order that never filled is invisible.
 */
export async function ordersFor(address: string, limit: number): Promise<OrderRow[]> {
  const body = JSON.stringify({
    query: `query Orders($account: String!, $limit: Int!) {
      Order(limit: $limit, where: {owner: {_eq: $account}}, order_by: {placedAtTimestamp: desc}) {
        orderId side price fullQuantity filledQuantity quantityRemaining status rested
        placedAtTimestamp placedTxHash
        market { marketId asset intervalSec strike expiry }
      }
    }`,
    variables: { account: address.toLowerCase(), limit },
  });

  const data = await query<{ Order: Record<string, any>[] }>(body);
  return data.Order
    .filter((o) => o.market?.marketId)
    .map((o) => ({
      orderId: String(o.orderId),
      marketId: String(o.market.marketId),
      asset: String(o.market.asset ?? ""),
      intervalSec: Number(o.market.intervalSec ?? 0),
      strike: Number(o.market.strike ?? 0) / STRIKE_SCALE,
      expiry: Number(o.market.expiry ?? 0),
      side: String(o.side ?? ""),
      outcomeIndex: String(o.side).includes("NO") ? 1 : 0,
      price: Number(o.price) / PRICE_SCALE,
      quantity: Number(o.fullQuantity) / COLLATERAL_SCALE,
      filled: Number(o.filledQuantity) / COLLATERAL_SCALE,
      remaining: Number(o.quantityRemaining) / COLLATERAL_SCALE,
      status: String(o.status ?? ""),
      rested: Boolean(o.rested),
      placedAt: Number(o.placedAtTimestamp ?? 0),
      txHash: String(o.placedTxHash ?? ""),
    }));
}

export type TraderRow = { account: string; settled: number; wins: number; winRate: number; volume: number };

// Ranked from settled positions: a position wins when its outcome is the winner.
// Claimed positions are included, so win rate counts collected wins. Their size
// is burned on redemption, so volume reads low for accounts that claim often.
export async function leaderboard(limit: number): Promise<TraderRow[]> {
  const body = JSON.stringify({
    query: `query Board($limit: Int!) {
      OutcomeBalance(limit: $limit, where: {market: {finalized: {_eq: true}}}, order_by: {balance: desc}) {
        ${POSITION_FIELDS}
      }
    }`,
    variables: { limit },
  });

  const data = await query<{ OutcomeBalance: Record<string, any>[] }>(body);
  const byAccount = new Map<string, TraderRow>();

  for (const row of data.OutcomeBalance) {
    const p = toPosition(row);
    if (p.winningOutcome === null) continue;

    const account = String(row.account);
    const entry = byAccount.get(account) ?? { account, settled: 0, wins: 0, winRate: 0, volume: 0 };
    entry.settled += 1;
    entry.volume += p.size;
    if (p.outcomeIndex === p.winningOutcome) entry.wins += 1;
    byAccount.set(account, entry);
  }

  return [...byAccount.values()]
    .map((r) => ({ ...r, winRate: r.settled ? r.wins / r.settled : 0 }))
    .sort((a, b) => b.wins - a.wins || b.volume - a.volume)
    .slice(0, 50);
}

/** Winning outcome index per marketId, for scoring settled predictions. */
export async function settledOutcomes(marketIds: string[]): Promise<Map<string, number>> {
  if (marketIds.length === 0) return new Map();

  const body = JSON.stringify({
    query: `query Outcomes($ids: [String!]!) {
      Market(where: {marketId: {_in: $ids}, finalized: {_eq: true}}) {
        marketId winningOutcome
      }
    }`,
    variables: { ids: marketIds },
  });

  const data = await query<{ Market: { marketId: string; winningOutcome: number | null }[] }>(body);
  const out = new Map<string, number>();
  for (const row of data.Market) {
    if (row.winningOutcome !== null) out.set(row.marketId, Number(row.winningOutcome));
  }
  return out;
}
