import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { TUSDC } from "./wallet/config";

type Props = {
  stake: number;
  onChange: (stake: number) => void;
  /** Offer fractions of the balance instead of fixed additions. */
  percentOfBalance?: boolean;
};

const QUICK = [1, 5, 10, 100];
const MAX_STAKE = 100_000;

/**
 * Amount entry for the next swipe.
 *
 * Typed rather than picked from three presets: the quick buttons ADD to the
 * amount the way a book's ticket does, so stacking them reaches any figure
 * without hunting for a preset that happens to match.
 */
export function StakePanel({ stake, onChange, percentOfBalance = false }: Props) {
  const { address, isConnected } = useAccount();

  const { data: balance } = useReadContract({
    abi: erc20Abi,
    address: TUSDC.address,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  const available = Number(formatUnits(balance ?? 0n, TUSDC.decimals));
  // Never offer more than the wallet holds, and never a negative amount.
  const clamp = (next: number) => Math.max(0, Math.min(MAX_STAKE, Math.round(next * 100) / 100));
  const overBalance = isConnected && stake > available;

  return (
    <section className="stake-panel" aria-label="Stake">
      <header>
        <div className="stake-head">
          <span className="stake-title">Amount</span>
          <span className="stake-avail">
            {isConnected ? `Available ${available.toFixed(2)} ${TUSDC.symbol}` : "Paper mode until a wallet connects"}
          </span>
          {stake > 0 && (
            <button type="button" className="stake-clear" onClick={() => onChange(0)}>
              Clear
            </button>
          )}
        </div>

        <label className="stake-input">
          <span aria-hidden="true">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={stake === 0 ? "" : String(stake)}
            placeholder="0"
            aria-label="Stake in tUSDC"
            onChange={(e) => onChange(clamp(Number(e.target.value)))}
          />
        </label>
      </header>

      <div className="stake-quick">
        {percentOfBalance
          ? [25, 50, 75].map((percent) => (
              <button
                key={percent}
                className="stake"
                disabled={!isConnected || available <= 0}
                onClick={() => onChange(clamp((available * percent) / 100))}
              >
                {percent}%
              </button>
            ))
          : QUICK.map((amount) => (
              <button key={amount} className="stake" onClick={() => onChange(clamp(stake + amount))}>
                +${amount}
              </button>
            ))}
        <button
          className="stake"
          onClick={() => onChange(clamp(available))}
          disabled={!isConnected || available <= 0}
          title={isConnected ? "Use the whole balance" : "Connect a wallet first"}
        >
          Max
        </button>
      </div>

      {overBalance && (
        <p className="stake-warn" role="status">
          That is more than the {available.toFixed(2)} {TUSDC.symbol} in the wallet. The order will fail to escrow.
        </p>
      )}
    </section>
  );
}
