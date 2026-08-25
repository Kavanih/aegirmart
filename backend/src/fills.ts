const GRAPHQL = process.env.SOMNIA_GRAPHQL ?? "https://dev.smk.somnia.host/v1/graphql";
const SCALE = 1e6;

export type CostBasis = {
  shares: number;
  cost: number;
  averagePrice: number;
  fills: number;
};

/** marketId -> outcomeIndex -> basis. */
export type BasisIndex = Record<string, Record<number, CostBasis>>;

type FillRow = {
  maker: string | null;
  taker: string | null;
  makerSide: string | null;
  takerSide: string | null;
  quantity: string;
  quoteQuantity: string;
  timestamp: string;
  market: { marketId: string } | null;
};

// A user can be either leg of a fill, so read the side from whichever role
// they filled. Sides are BUY_YES / SELL_YES / BUY_NO / SELL_NO.
function sideFor(fill: FillRow, account: string): string | null {
  if (fill.maker && fill.maker.toLowerCase() === account) return fill.makerSide;
  if (fill.taker && fill.taker.toLowerCase() === account) return fill.takerSide;
  return null;
}

/**
 * Cost basis per position, from the account's own fills.
 *
 * `quoteQuantity` is the YES-side value of the fill, so a NO buyer pays the
 * complement. Keyed by marketId because pools are recycled across windows.
 */
export async function costBasisFor(accountRaw: string, limit = 500): Promise<BasisIndex> {
  const account = accountRaw.toLowerCase();

  const body = JSON.stringify({
    query: `query Fills($account: String!, $limit: Int!) {
      Fill(
        limit: $limit
        where: {_or: [{maker: {_eq: $account}}, {taker: {_eq: $account}}]}
        order_by: {timestamp: desc}
      ) {
        maker taker makerSide takerSide quantity quoteQuantity timestamp
        market { marketId }
      }
    }`,
    variables: { account, limit },
  });

  const res = await fetch(GRAPHQL, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`fills ${res.status}`);
  const json = (await res.json()) as { data?: { Fill: FillRow[] } };
  const rows = json.data?.Fill ?? [];

  const index: BasisIndex = {};

  for (const fill of rows) {
    const side = sideFor(fill, account);
    const marketId = fill.market?.marketId;
    if (!side || !marketId || side.startsWith("SELL")) continue;

    // OutcomeBalance indexes YES as 0 and NO as 1, confirmed against tokenId.
    const outcome = side === "BUY_YES" ? 0 : 1;
    const quantity = Number(fill.quantity) / SCALE;
    const yesValue = Number(fill.quoteQuantity) / SCALE;
    const cost = outcome === 0 ? yesValue : quantity - yesValue;
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const byOutcome = (index[marketId] ??= {});
    const basis = (byOutcome[outcome] ??= { shares: 0, cost: 0, averagePrice: 0, fills: 0 });

    basis.shares += quantity;
    basis.cost += cost;
    basis.fills += 1;
    basis.averagePrice = basis.shares > 0 ? basis.cost / basis.shares : 0;
  }

  return index;
}
