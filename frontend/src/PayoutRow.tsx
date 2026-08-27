import { expectedValue, fmt, quotePayout } from "./payout";

type Props = { stake: number; price: number | null; probability: number | null; side: "up" | "down" };

// Shows what the stake buys before the swipe commits, plus whether the model
// thinks that price is worth taking.
export function PayoutRow({ stake, price, probability, side }: Props) {
  if (price === null) {
    return <p className="payout-row muted">No resting price yet. Your swipe rests a bid at the model read.</p>;
  }

  const quote = quotePayout(stake, price);
  if (!quote) return null;

  const ev = expectedValue(stake, price, probability);
  // Measured against what actually leaves the wallet, not the amount typed,
  // since quantity floors to a whole lot.
  const edge = ev === null || quote.escrow <= 0 ? null : ev / quote.escrow;

  return (
    <div className="payout-row">
      <span className="payout-main">
        {fmt(quote.escrow)} to win <strong>{fmt(quote.payout)}</strong>
      </span>
      <span className="payout-sub">
        {fmt(quote.shares)} shares at {Math.round(price * 100)}c &middot; {fmt(quote.returnMultiple, 2)}x
      </span>
      {edge !== null && Math.abs(edge) > 0.02 && (
        <span className={`payout-ev ${edge > 0 ? "good" : "bad"}`}>
          {edge > 0 ? "+" : ""}{Math.round(edge * 100)}% EV on the {side} side
        </span>
      )}
    </div>
  );
}
