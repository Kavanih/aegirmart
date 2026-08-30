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

/**
 * Spot prices this venue has actually settled on, newest last.
 *
 * The oracle answer for a resolved market IS the price that decided it, so a
 * run of them is a real price series. Strikes cannot serve: this venue mints
 * every window of every lane at one fixed strike, so a strike-derived series is
 * a flat line and every model built on it reports a coin flip.
 *
 * Answers are keyed by oracle question, and a question can back several markets
 * (the 300s and 900s windows share one), so questions are de-duplicated.
 */
export async function spotSeries(asset: string, limit = 60): Promise<PricePoint[]> {
  const bindBody = JSON.stringify({
    query: `query Binds($asset: String!, $limit: Int!) {
      OracleBind(
        limit: $limit
        where: {market: {asset: {_eq: $asset}}, resolvedAt: {_is_null: false}}
        order_by: {resolvedAt: desc}
      ) { oracleQuestionId resolvedAt }
    }`,
    variables: { asset, limit },
  });

  const bindData = await query<{ OracleBind: { oracleQuestionId: string; resolvedAt: string }[] }>(bindBody);
  const byQuestion = new Map<string, number>();
  for (const b of bindData.OracleBind) {
    if (!byQuestion.has(String(b.oracleQuestionId))) byQuestion.set(String(b.oracleQuestionId), Number(b.resolvedAt));
  }
  if (byQuestion.size === 0) return [];

  const ids = [...byQuestion.keys()];
  const answerBody = JSON.stringify({
    query: `query Answers($ids: [numeric!]!) {
      OracleAnswer(where: {oracleQuestionId: {_in: $ids}, voided: {_eq: false}}) {
        oracleQuestionId numericValue
      }
    }`,
    variables: { ids: ids.map(Number) },
  });

  const answerData = await query<{ OracleAnswer: { oracleQuestionId: string; numericValue: string }[] }>(answerBody);

  const points: PricePoint[] = [];
  for (const a of answerData.OracleAnswer) {
    const t = byQuestion.get(String(a.oracleQuestionId));
    const price = Number(a.numericValue) / STRIKE_SCALE;
    // One question also carries range answers far outside a spot price; keep
    // only values in the neighbourhood of the venue's own strikes.
    if (t === undefined || !Number.isFinite(price) || price <= 0) continue;
    points.push({ t, price });
  }

  return points.sort((a, b) => a.t - b.t);
}

/**
 * Current spot, taken from the freshest at-the-money mint.
 *
 * The venue mints each window at the money, so a strike is a record of spot at
 * the moment it was created. The SIXTY SECOND lane is the right source: it
 * mints every minute, so its newest strike is at most a minute old.
 *
 * Reading the newest market of any lane returned the five minute window that
 * was being priced, which made spot identical to strike by construction. Every
 * digital estimate then came out at exactly 0.500, for the quant and for the
 * model reading the same evidence, so neither ever had a view to trade on.
 */
export async function spotReference(asset: string): Promise<number | null> {
  const body = JSON.stringify({
    query: `query Spot($venue: String!, $asset: String!) {
      Market(
        limit: 1
        where: {venueId: {_eq: $venue}, asset: {_eq: $asset}, intervalSec: {_eq: "60"}, strike: {_gt: "0"}}
        order_by: {expiry: desc}
      ) { strike }
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
        order_by: {market: {expiry: desc}}
      ) {
        ${POSITION_FIELDS}
      }
    }`,
    variables: { account: address.toLowerCase(), limit },
  });

  const data = await query<{ OutcomeBalance: Record<string, any>[] }>(body);
  return data.OutcomeBalance.map(toPosition).filter((p) => p.marketId);
}

export type VenueFill = { id: string; size: number; accounts: string[] };

/** Recent fills across the venue, for the running totals. */
export async function venueFills(limit = 200): Promise<VenueFill[]> {
  const body = JSON.stringify({
    query: `query Fills($venue: String!, $limit: Int!) {
      Fill(limit: $limit, order_by: {timestamp: desc}, where: {market: {venueId: {_eq: $venue}}}) {
        id quantity maker taker
      }
    }`,
    variables: { venue: VENUE_ID, limit },
  });

  const data = await query<{ Fill: Record<string, any>[] }>(body);
  return data.Fill.map((f) => ({
    id: String(f.id),
    size: Number(f.quantity) / COLLATERAL_SCALE,
    accounts: [f.maker, f.taker].filter(Boolean).map(String),
  })).filter((f) => Number.isFinite(f.size) && f.size > 0);
}

export type Redemption = { marketId: string; outcomeIndex: number; burned: number; collateralOut: number };

/**
 * What the account actually collected, per market and leg.
 *
 * Redeeming burns the outcome tokens, so a claimed position's size is gone from
 * OutcomeBalance. Without this the payout has to be guessed from what is left,
 * which is why realised P&L moved every time somebody claimed.
 */
export async function redemptionsFor(address: string, limit = 400): Promise<Redemption[]> {
  const body = JSON.stringify({
    query: `query Redemptions($holder: String!, $limit: Int!) {
      RedemptionRecord(limit: $limit, where: {holder: {_eq: $holder}}) {
        outcomeIdx amountBurned collateralOut
        market { marketId }
      }
    }`,
    variables: { holder: address.toLowerCase(), limit },
  });

  const data = await query<{ RedemptionRecord: Record<string, any>[] }>(body);
  return data.RedemptionRecord
    .filter((r) => r.market?.marketId)
    .map((r) => ({
      marketId: String(r.market.marketId),
      outcomeIndex: Number(r.outcomeIdx),
      burned: Number(r.amountBurned) / COLLATERAL_SCALE,
      collateralOut: Number(r.collateralOut) / COLLATERAL_SCALE,
    }));
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

/**
 * Resting orders on every live market, split into bids and asks on the YES leg.
 *
 * A binary book has one price axis: BUY_YES and SELL_NO both want YES cheap, so
 * they land on the same side of it. Reading only BUY_YES/SELL_YES would show
 * half a book.
 */
export async function liveBooks(): Promise<MarketBook[]> {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    query: `query Books($venue: String!, $now: numeric!) {
      Order(
        limit: 300
        where: {
          status: {_eq: "Open"}
          market: {venueId: {_eq: $venue}, expiry: {_gt: $now}, strike: {_gt: "0"}}
        }
        order_by: {price: asc}
      ) {
        side price quantityRemaining owner
        market { marketId asset intervalSec strike expiry lastPrice tradeCount }
      }
    }`,
    variables: { venue: VENUE_ID, now: String(now) },
  });

  const data = await query<{ Order: Record<string, any>[] }>(body);
  const byMarket = new Map<string, MarketBook>();

  for (const row of data.Order) {
    const m = row.market;
    if (!m?.marketId) continue;

    const book = byMarket.get(m.marketId) ?? {
      marketId: String(m.marketId),
      asset: String(m.asset ?? ""),
      intervalSec: Number(m.intervalSec ?? 0),
      strike: Number(m.strike ?? 0) / STRIKE_SCALE,
      expiry: Number(m.expiry ?? 0),
      lastPrice: m.lastPrice === null || m.lastPrice === undefined ? null : Number(m.lastPrice) / PRICE_SCALE,
      tradeCount: Number(m.tradeCount ?? 0),
      bids: [],
      asks: [],
    };

    const side = String(row.side ?? "");
    const level: BookLevel = {
      side,
      price: Number(row.price) / PRICE_SCALE,
      size: Number(row.quantityRemaining) / COLLATERAL_SCALE,
      owner: String(row.owner ?? "").toLowerCase(),
    };
    if (level.size <= 0) continue;

    // Wanting YES is a bid; offering it is an ask, whichever leg names it.
    if (side === "BUY_YES" || side === "SELL_NO") book.bids.push(level);
    else book.asks.push(level);

    byMarket.set(m.marketId, book);
  }

  for (const book of byMarket.values()) {
    book.bids.sort((a, b) => b.price - a.price);
    book.asks.sort((a, b) => a.price - b.price);
  }

  return [...byMarket.values()].sort((a, b) => a.expiry - b.expiry);
}

export type MarketTrade = {
  t: number;
  price: number;
  size: number;
  takerSide: string;
  /** Who bought the leg the taker was after, and who supplied it. */
  buyer: string;
  seller: string;
};

/** One market by id, including dead ones, so a detail page can render history. */
export async function marketById(marketId: string): Promise<Market | null> {
  const body = JSON.stringify({
    query: `query One($id: String!) {
      Market(limit: 1, where: {marketId: {_eq: $id}}) {
        marketId asset strike expiry intervalSec lastPrice tradeCount poolAddress collateral
        finalized winningOutcome
      }
    }`,
    variables: { id: marketId },
  });

  const data = await query<{ Market: Record<string, string | null>[] }>(body);
  const row = data.Market[0];
  if (!row) return null;
  return {
    ...toMarket(row),
    finalized: Boolean(row.finalized),
    wentUp: row.winningOutcome === null ? null : Number(row.winningOutcome) === 0,
  } as Market & { finalized: boolean; wentUp: boolean | null };
}

/**
 * Traded prices for one market, oldest first.
 *
 * quoteQuantity is the YES side value of the fill, so the ratio is the YES
 * probability the trade printed at, whichever leg the taker was on.
 */
export async function tradesFor(marketId: string, limit: number): Promise<MarketTrade[]> {
  const body = JSON.stringify({
    query: `query Trades($id: String!, $limit: Int!) {
      Fill(limit: $limit, order_by: {timestamp: desc}, where: {market: {marketId: {_eq: $id}}}) {
        timestamp quantity quoteQuantity takerSide maker taker
      }
    }`,
    variables: { id: marketId, limit },
  });

  const data = await query<{ Fill: Record<string, string>[] }>(body);
  return data.Fill
    .map((f) => {
      const size = Number(f.quantity) / COLLATERAL_SCALE;
      const quote = Number(f.quoteQuantity) / COLLATERAL_SCALE;
      const takerSide = String(f.takerSide ?? "");
      // The taker names the direction. Whoever took a BUY was the buyer of
      // that leg, and the maker supplied it; a SELL taker is the other way up.
      const takerBought = takerSide.startsWith("BUY");
      return {
        t: Number(f.timestamp),
        price: size > 0 ? quote / size : 0,
        size,
        takerSide,
        buyer: String((takerBought ? f.taker : f.maker) ?? ""),
        seller: String((takerBought ? f.maker : f.taker) ?? ""),
      };
    })
    .filter((f) => f.size > 0 && f.price > 0 && f.price < 1)
    .reverse();
}

type OrderSpend = { shares: number; cost: number };

/**
 * Collateral actually paid per order, from its fills.
 *
 * A fill carries the YES price, so the NO leg pays the complement: buying N
 * shares of NO for a YES quote value of V costs N - V. Same inversion as the
 * order price, one level down.
 */
async function spendByOrder(addressRaw: string, limit = 500): Promise<Map<string, OrderSpend>> {
  const account = addressRaw.toLowerCase();
  const body = JSON.stringify({
    query: `query OrderFills($account: String!, $limit: Int!) {
      Fill(
        limit: $limit
        where: {_or: [{maker: {_eq: $account}}, {taker: {_eq: $account}}]}
        order_by: {timestamp: desc}
      ) {
        maker taker makerSide takerSide makerOrderId takerOrderId quantity quoteQuantity
      }
    }`,
    variables: { account, limit },
  });

  const data = await query<{ Fill: Record<string, any>[] }>(body);
  const spend = new Map<string, OrderSpend>();

  for (const f of data.Fill) {
    // One account can sit on both sides of a fill, so read the side that
    // belongs to it rather than assuming taker.
    const isTaker = String(f.taker ?? "").toLowerCase() === account;
    const side = String((isTaker ? f.takerSide : f.makerSide) ?? "");
    const orderId = String((isTaker ? f.takerOrderId : f.makerOrderId) ?? "");
    if (!orderId || !/^BUY_/.test(side)) continue;

    const shares = Number(f.quantity) / COLLATERAL_SCALE;
    const yesValue = Number(f.quoteQuantity) / COLLATERAL_SCALE;
    const cost = side === "BUY_YES" ? yesValue : shares - yesValue;
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(cost)) continue;

    const entry = spend.get(orderId) ?? { shares: 0, cost: 0 };
    entry.shares += shares;
    entry.cost += cost;
    spend.set(orderId, entry);
  }

  return spend;
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
  /**
   * Average price actually paid a share on this leg, from the fills.
   *
   * Not the limit price. A taking order crosses the book and fills at whatever
   * is resting, so an order carrying a 97c limit routinely pays 76c. Pricing a
   * result off the limit overstated every loss and hid most of every win.
   *
   * Falls back to the limit price while nothing has filled, where there is no
   * average to report yet.
   */
  price: number;
  /** The limit this order was placed at, in the leg's own terms. */
  limitPrice: number;
  /** The raw YES price the venue stores, for anything working in book terms. */
  priceYes: number;
  /** Collateral actually paid for the filled shares. */
  cost: number;
  quantity: number;
  filled: number;
  remaining: number;
  status: string;
  rested: boolean;
  placedAt: number;
  txHash: string;
  /** Null while the window is still open, or on a side we cannot price. */
  won: boolean | null;
  /**
   * What this one order made or lost, in collateral. A winning share redeems
   * at 1.00, so a buy filled at p profits (1 - p) a share and otherwise loses
   * the p it paid. Kept per order rather than per market: a bot can hold both
   * legs, and each fill still stands or falls on its own price.
   */
  pnl: number | null;
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
        orderId placedAtTimestamp placedTxHash
        market { marketId asset intervalSec strike expiry finalized winningOutcome }
      }
    }`,
    variables: { account: address.toLowerCase(), limit },
  });

  const data = await query<{ Order: Record<string, any>[] }>(body);

  // What each order actually paid, keyed by order id. Fetched separately
  // because the venue's limit price says what an order was willing to pay, not
  // what it got.
  const spend = await spendByOrder(address).catch(() => new Map<string, OrderSpend>());

  return data.Order
    .filter((o) => o.market?.marketId)
    .map((o) => {
      const expiry = Number(o.market.expiry ?? 0);
      const expired = Boolean(o.market.finalized) || expiry * 1000 < Date.now();

      const side = String(o.side ?? "");
      const outcomeIndex = /^(BUY_YES|SELL_NO)$/.test(side) ? 0 : 1;
      const priceYes = Number(o.price) / PRICE_SCALE;
      const limitPrice = outcomeIndex === 0 ? priceYes : 1 - priceYes;
      const filled = Number(o.filledQuantity) / COLLATERAL_SCALE;

      // What this order actually paid, from its own fills. Falls back to the
      // limit only while nothing has filled and there is no average yet.
      const paid = spend.get(String(o.orderId));
      const cost = paid ? paid.cost : filled * limitPrice;
      const price = paid && paid.shares > 0 ? paid.cost / paid.shares : limitPrice;

      // Only a buy is priced here. A sell is a short whose result depends on
      // what it was closing, which one order row cannot see, and none have
      // ever filled on this venue anyway.
      const bought = /^BUY_/.test(side);
      const settled = Boolean(o.market.finalized) && o.market.winningOutcome !== null;
      const won = settled && bought && filled > 0 ? Number(o.market.winningOutcome) === outcomeIndex : null;
      // A winning share redeems at 1.00, so the payout is the share count.
      const pnl = won === null ? null : won ? filled - cost : -cost;

      return {
      orderId: String(o.orderId),
      marketId: String(o.market.marketId),
      asset: String(o.market.asset ?? ""),
      intervalSec: Number(o.market.intervalSec ?? 0),
      strike: Number(o.market.strike ?? 0) / STRIKE_SCALE,
      expiry: Number(o.market.expiry ?? 0),
      side,
      // Direction, not leg name. Buying YES and selling NO are both bets that
      // it goes up; selling YES and buying NO are both bets that it does not.
      // Reading only for "NO" labelled every SELL_YES as an up bet.
      outcomeIndex,
      price,
      limitPrice,
      priceYes,
      cost,
      quantity: Number(o.fullQuantity) / COLLATERAL_SCALE,
      filled,
      remaining: Number(o.quantityRemaining) / COLLATERAL_SCALE,
      // The indexer leaves orders on settled markets as "Open" indefinitely.
      // Nothing can fill there, so reporting it as working is a lie.
      status: expired && String(o.status) === "Open" ? "Expired" : String(o.status ?? ""),
      rested: Boolean(o.rested),
      placedAt: Number(o.placedAtTimestamp ?? 0),
      txHash: String(o.placedTxHash ?? ""),
      won,
      pnl,
      };
    });
}

export type TraderRow = { account: string; settled: number; wins: number; winRate: number; volume: number };

// Ranked from settled positions: a position wins when its outcome is the winner.
// Claimed positions are included, so win rate counts collected wins. Their size
// is burned on redemption, so volume reads low for accounts that claim often.
export async function leaderboard(limit: number, accumulated: Record<string, number> = {}): Promise<TraderRow[]> {
  const body = JSON.stringify({
    query: `query Board($limit: Int!) {
      OutcomeBalance(
        limit: $limit
        where: {market: {finalized: {_eq: true}}}
        order_by: {market: {expiry: desc}}
      ) {
        ${POSITION_FIELDS}
      }
    }`,
    variables: { limit },
  });

  // Volume has to come from fills. A settled leg's balance is what is LEFT,
  // and a redeemed winner has none, so summing balances reported zero for
  // exactly the traders who did best.
  const [data, fills] = await Promise.all([
    query<{ OutcomeBalance: Record<string, any>[] }>(body),
    venueFills(1000).catch((): VenueFill[] => []),
  ]);

  // Recent fills, then whatever has been accumulated for anyone missing from
  // them. A trader whose activity has aged out of the last thousand fills still
  // has a real number rather than a blank.
  // Sum the recent fills, then take whichever is larger: this window, or the
  // total accumulated across every window seen so far. Recent alone left forty
  // three of fifty rows blank, because the best traders are the older ones and
  // their fills had aged out.
  const recent = new Map<string, number>();
  for (const fill of fills) {
    for (const account of fill.accounts) {
      const key = account.toLowerCase();
      recent.set(key, (recent.get(key) ?? 0) + fill.size);
    }
  }

  const tradedBy = new Map<string, number>(Object.entries(accumulated));
  for (const [key, size] of recent) {
    tradedBy.set(key, Math.max(tradedBy.get(key) ?? 0, size));
  }

  // Group by account AND market first. An account holding both legs of a
  // market minted a set: one leg wins by construction, so counting them
  // separately gave every maker exactly one win in two and a 50% rate.
  const byAccountMarket = new Map<string, { account: string; legs: Position[] }>();
  for (const row of data.OutcomeBalance) {
    const p = toPosition(row);
    if (p.winningOutcome === null) continue;
    const account = String(row.account).toLowerCase();
    const key = `${account}:${p.marketId}`;
    const entry = byAccountMarket.get(key) ?? { account, legs: [] };
    entry.legs.push(p);
    byAccountMarket.set(key, entry);
  }

  const byAccount = new Map<string, TraderRow>();
  for (const { account, legs } of byAccountMarket.values()) {
    const entry = byAccount.get(account) ?? { account, settled: 0, wins: 0, winRate: 0, volume: 0 };

    // Both legs held is a wash, so it is not a call anyone can be judged on.
    const hedged = legs.length > 1 && new Set(legs.map((l) => l.outcomeIndex)).size > 1;
    if (!hedged) {
      for (const leg of legs) {
        entry.settled += 1;
        if (leg.outcomeIndex === leg.winningOutcome) entry.wins += 1;
      }
    }

    byAccount.set(account, entry);
  }

  return [...byAccount.values()]
    .map((r) => ({
      ...r,
      winRate: r.settled ? r.wins / r.settled : 0,
      volume: tradedBy.get(r.account) ?? 0,
    }))
    // Rank on the record where there is one, and never let a single lucky
    // call outrank a long one: below the threshold, order by volume traded.
    .sort((a, b) => {
      const aRanked = a.settled >= 5;
      const bRanked = b.settled >= 5;
      if (aRanked !== bRanked) return aRanked ? -1 : 1;
      if (aRanked && bRanked) return b.winRate - a.winRate || b.settled - a.settled;
      return b.volume - a.volume;
    })
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
