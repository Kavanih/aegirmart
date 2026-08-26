import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, parseUnits, type Address } from "viem";
import { FaBolt, FaCheck, FaCrown, FaRobot, FaStar } from "react-icons/fa";
import { fetchPlans, redeemPlan, type Cycle, type Subscription, type Tier, type TierSpec } from "./api";
import { somniaTestnet, TUSDC } from "./wallet/config";
import { useToast } from "./Toast";

const MARK: Record<Tier, JSX.Element> = {
  free: <FaRobot />,
  starter: <FaBolt />,
  pro: <FaCrown />,
};

export function Pricing() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const toast = useToast();

  const [cycle, setCycle] = useState<Cycle>("monthly");
  const [tiers, setTiers] = useState<TierSpec[] | null>(null);
  const [treasury, setTreasury] = useState<Address | null>(null);
  const [sub, setSub] = useState<Subscription | null>(null);
  const [busy, setBusy] = useState<Tier | null>(null);

  const load = useCallback(() => {
    fetchPlans(address).then((d) => {
      if (!d) return;
      setTiers(d.tiers);
      setTreasury(d.treasury as Address);
      setSub(d.subscription);
    });
  }, [address]);

  useEffect(load, [load]);

  const priceOf = (tier: TierSpec) => (cycle === "yearly" ? tier.yearly : tier.monthly);

  /**
   * Pay, then prove it. The transfer is signed in the operator's own wallet and
   * the plan is granted by the server reading that transaction, so nothing here
   * can grant itself a tier.
   */
  const upgrade = async (tier: TierSpec) => {
    if (!address) return toast.push("error", "Connect a wallet first");
    if (!treasury) return toast.push("error", "No payment address configured");
    if (chainId !== somniaTestnet.id) return toast.push("error", "Switch to Somnia testnet");

    const price = priceOf(tier);
    const id = toast.push("pending", `Paying ${price} ${TUSDC.symbol} for ${tier.name}`);
    setBusy(tier.id);

    try {
      const hash = await writeContract(config, {
        abi: erc20Abi,
        address: TUSDC.address,
        functionName: "transfer",
        args: [treasury, parseUnits(String(price), TUSDC.decimals)],
      });

      toast.update(id, "pending", "Sent. Waiting for confirmation", `https://shannon-explorer.somnia.network/tx/${hash}`);
      const receipt = await waitForTransactionReceipt(config, { hash });
      if (receipt.status !== "success") {
        setBusy(null);
        return toast.update(id, "error", "The payment reverted on chain");
      }

      const problem = await redeemPlan(address, hash, tier.id, cycle);
      setBusy(null);
      if (problem) return toast.update(id, "error", problem);

      toast.update(id, "success", `${tier.name} is active`);
      load();
    } catch (err) {
      setBusy(null);
      const message = err instanceof Error ? err.message : String(err);
      toast.update(id, "error", /rejected|denied/i.test(message) ? "Payment cancelled" : message.split("\n")[0].slice(0, 120));
    }
  };

  const current = sub?.plan ?? "free";

  return (
    <div className="pricing">
      <header className="pricing-head">
        <h2>Pick a plan</h2>
        <p>Bots quote for you. A paid plan is what lets a model price them.</p>

        <div className="cycle-toggle" role="group" aria-label="Billing cycle">
          {(["monthly", "yearly"] as const).map((c) => (
            <button key={c} className={cycle === c ? "cycle on" : "cycle"} aria-pressed={cycle === c} onClick={() => setCycle(c)}>
              {c === "monthly" ? "Monthly" : "Yearly"}
              {c === "yearly" && <span className="cycle-save">save up to 15%</span>}
            </button>
          ))}
        </div>
      </header>

      {tiers === null ? (
        <p className="read-idle">Loading plans…</p>
      ) : (
        <div className="tier-grid">
          {tiers.map((tier) => {
            const active = current === tier.id;
            const price = priceOf(tier);
            const recommended = tier.id === "starter";

            return (
              <article key={tier.id} className={`tier${recommended ? " featured" : ""}${active ? " active" : ""}`}>
                <header>
                  <span className="tier-mark">{MARK[tier.id]}</span>
                  <h3>{tier.name}</h3>
                  {recommended && <span className="tier-flag"><FaStar /> Recommended</span>}
                </header>

                <p className="tier-tagline">{tier.tagline}</p>

                <p className="tier-price">
                  <span className="tier-amount">${price}</span>
                  <span className="tier-cycle">/ {cycle === "yearly" ? "year" : "month"}</span>
                </p>
                {/* Only worth stating where there is actually a saving. */}
                {cycle === "yearly" && tier.yearlyDiscount > 0 && (
                  <p className="tier-save">{tier.yearlyDiscount}% off twelve months at ${tier.monthly}</p>
                )}

                {active ? (
                  <button className="tier-cta current" disabled>Your current plan</button>
                ) : tier.id === "free" ? (
                  <button className="tier-cta current" disabled>Always available</button>
                ) : (
                  <button
                    className={recommended ? "tier-cta cta" : "tier-cta"}
                    onClick={() => upgrade(tier)}
                    disabled={busy !== null}
                  >
                    {busy === tier.id ? "Confirming…" : `Upgrade to ${tier.name}`}
                  </button>
                )}

                <ul className="tier-features">
                  {tier.features.map((f) => (
                    <li key={f}><FaCheck aria-hidden="true" /> {f}</li>
                  ))}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      {sub?.expires && (
        <p className="footnote">
          {sub.plan} runs until {new Date(sub.expires).toLocaleDateString()}. Renewing early adds to the end of the term
          rather than restarting it.
        </p>
      )}

    </div>
  );
}
