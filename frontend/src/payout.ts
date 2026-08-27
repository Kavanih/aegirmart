import { quoteFor } from "./wallet/trade";

// Binary contracts redeem at exactly 1.00 collateral per winning share, so the
// price you pay is both the probability and the inverse of your return.
export const PAYOUT_PER_SHARE = 1;

export type Payout = {
  shares: number;
  payout: number;
  profit: number;
  returnMultiple: number;
  /** What actually leaves the wallet, after quantity floors to a whole lot. */
  escrow: number;
};

export function quotePayout(stake: number, price: number): Payout | null {
  if (!(price > 0) || price >= 1 || !(stake > 0)) return null;

  // Snap the same way the order does, so the shares previewed are the shares
  // bought. Quantity floors to a whole lot, so the raw division overstates.
  const quote = quoteFor(stake, price);
  if (!quote) return null;

  const payout = quote.shares * PAYOUT_PER_SHARE;
  return {
    shares: quote.shares,
    payout,
    profit: payout - quote.escrow,
    returnMultiple: quote.escrow > 0 ? payout / quote.escrow : 0,
    escrow: quote.escrow,
  };
}

/**
 * Expected value of the stake under the model's probability.
 *
 * `price` must be what the MARKET charges. Passing a price derived from the
 * model made this identically zero at every probability, because it compared
 * the model against itself; the readout could never fire. The edge only exists
 * where the model and the book disagree.
 */
export function expectedValue(stake: number, price: number, probability: number | null): number | null {
  const quote = quotePayout(stake, price);
  if (!quote || probability === null) return null;
  return probability * quote.payout - quote.escrow;
}

export function fmt(value: number, digits = 2): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
