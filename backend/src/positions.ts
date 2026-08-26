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
    positionsFor(address, 100),
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

    // A minted set costs one collateral per unit and returns one on the
    // winning leg. Charging that cost to the leg that pays makes the pair net
    // to zero across the two rows instead of inventing a profit.
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
}

export type PositionStats = { settled: number; won: number; winRate: number; realised: number; lost: number };

/** The same summary the profile shows, so a bot's page can state its own. */
export function summarise(rows: PricedPosition[]): PositionStats {
  const settled = rows.filter((p) => p.finalized);
  // Minted legs win by construction, so they say nothing about a call.
  const directional = settled.filter((p) => !p.minted);
  const won = directional.filter((p) => p.won).length;

  return {
    settled: settled.length,
    won,
    winRate: directional.length ? won / directional.length : 0,
    realised: settled.reduce((sum, p) => sum + (p.pnl ?? 0), 0),
    lost: settled.reduce((sum, p) => sum + Math.min(0, p.pnl ?? 0), 0) * -1,
  };
}
