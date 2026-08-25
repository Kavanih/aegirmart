// Binary contracts redeem at exactly 1.00 collateral per winning share, so the
// price you pay is both the probability and the inverse of your return.
export const PAYOUT_PER_SHARE = 1;

export type Payout = {
  shares: number;
  payout: number;
  profit: number;
  returnMultiple: number;
};

export function quotePayout(stake: number, price: number): Payout | null {
  if (!(price > 0) || price >= 1 || !(stake > 0)) return null;
  const shares = stake / price;
  const payout = shares * PAYOUT_PER_SHARE;
  return { shares, payout, profit: payout - stake, returnMultiple: payout / stake };
}

/**
 * Expected value of the stake under the model's probability.
 *
 * Positive means the model thinks the side is underpriced. This is where the
 * model read stops being decoration: it is the only input the market does not
 * already give you.
 */
export function expectedValue(stake: number, price: number, probability: number | null): number | null {
  const quote = quotePayout(stake, price);
  if (!quote || probability === null) return null;
  return probability * quote.payout - stake;
}

export function fmt(value: number, digits = 2): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
