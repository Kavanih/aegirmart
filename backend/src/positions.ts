import { positionsFor, redemptionsFor } from "./markets.js";
import { costBasisFor, type BasisIndex } from "./fills.js";

/**
 * Positions priced against what the account actually paid and received.
 *
 * Shared by the profile and by a bot's own page, so both read the same figures
 * from the same rules rather than drifting apart.
 */
export type PricedPosition = Awaited<ReturnType<typeof pricedPositionsFor>>[number];

export async function pricedPositionsFor(address: string) {
  // Basis and redemptions are best effort: an outage must not hide positions.
  const [positions, basis, redemptions] = await Promise.all([
    // The account has more legs than a page. Ordering by balance put every
    // claimed winner last and the cap then cut them, so the whole portfolio
    // was computed from the losers.
    positionsFor(address, 500),
    costBasisFor(address).catch((): BasisIndex => ({})),
    redemptionsFor(address).catch((): Awaited<ReturnType<typeof redemptionsFor>> => []),
  ]);

  const redeemed = new Map(redemptions.map((r) => [`${r.marketId}:${r.outcomeIndex}`, r]));

  // Holding BOTH legs of a market means a complete set was minted: collateral
  // in, one leg pays it back, the other expires. The overlap is a wash, not a
  // win, and pricing the legs separately made it read as free money.
  const held = new Map<string, Map<number, number>>();
  for (const p of positions) {
    const paid = redeemed.get(`${p.marketId}:${p.outcomeIndex}`);
    const size = p.size > 0 ? p.size : paid?.burned ?? 0;
    const legs = held.get(p.marketId) ?? new Map<number, number>();
    legs.set(p.outcomeIndex, (legs.get(p.outcomeIndex) ?? 0) + size);
    held.set(p.marketId, legs);
  }

  return positions.map((p) => {
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

    // Only the shares NOT accounted for by purchases can have come from a mint.
    // Charging the full paired amount on top of the buy cost billed the same
    // shares twice, which is how a pair that should net zero showed a loss on
    // both legs.
    const boughtShares = entry?.shares ?? 0;
    const mintedShares = Math.max(0, Math.min(pairedShares, shares - boughtShares));

    // A minted set costs one collateral per unit and returns one on the winning
    // leg, so charging it to the leg that pays makes the pair net to zero.
    const mintedCost = won ? mintedShares : 0;
    const cost = entry ? entry.cost + mintedCost : mintedShares > 0 ? mintedCost : null;

    return {
      ...p,
      shares,
      won: p.finalized ? won : null,
      pairedShares,
      mintedShares,
      /**
       * Even only when the WHOLE leg is offset by its pair. A leg that also
       * carries bought shares has a real result on those, so calling it a wash
       * hid a genuine win or loss.
       */
      minted: mintedShares > 0 && mintedShares >= shares - 0.0001,
      cost,
      averagePrice: entry?.averagePrice ?? null,
      pnl: cost !== null && payout !== null ? payout - cost : null,
    };
  });
}

export type PositionStats = {
  settled: number;
  won: number;
  winRate: number;
  realised: number;
  lost: number;
  /** Settled rows the P&L figures actually cover. */
  priced: number;
  /**
   * Rows with no basis to price from. A position minted as a complete set
   * leaves no trade behind it, so nothing on chain says what it cost. They are
   * counted rather than quietly dropped out of the totals.
   */
  unpriced: number;
};

/** The same summary the profile shows, so a bot's page can state its own. */
export function summarise(rows: PricedPosition[]): PositionStats {
  const settled = rows.filter((p) => p.finalized);
  // Minted legs win by construction, so they say nothing about a call.
  const directional = settled.filter((p) => !p.minted);
  const won = directional.filter((p) => p.won).length;

  const unpriced = settled.filter((p) => p.pnl === null).length;

  return {
    settled: settled.length,
    won,
    winRate: directional.length ? won / directional.length : 0,
    realised: settled.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
    lost: settled.reduce((sum, p) => sum + Math.min(0, p.pnl ?? 0), 0) * -1,
    priced: settled.length - unpriced,
    unpriced,
  };
}
