import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { decodeEventLog, erc20Abi, type Address } from "viem";
import { publicClient } from "./chain.js";

/**
 * Subscription tiers, and proof that one was paid for.
 *
 * The client never asserts a plan. It hands over a transaction hash, and the
 * grant comes from reading that transaction on chain: the right token, the
 * right recipient, from the account claiming it, for at least the price. A
 * hash can only be spent once.
 */
const STORE = new URL("../plans.json", import.meta.url).pathname;
const SPENT = new URL("../plan-receipts.json", import.meta.url).pathname;

export const TREASURY = (process.env.TREASURY_ADDRESS ??
  "0x803f09058F436b760ea241923De14dcE51Fb53ea").toLowerCase() as Address;

export const COLLATERAL = (process.env.COLLATERAL_ADDRESS ??
  "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E").toLowerCase() as Address;

const DECIMALS = 6;
const DAY = 86_400_000;

export type Tier = "free" | "starter" | "pro";
export type Cycle = "monthly" | "yearly";

export type TierSpec = {
  id: Tier;
  name: string;
  tagline: string;
  monthly: number;
  /** Yearly total after the discount, rounded to the cent. */
  yearly: number;
  yearlyDiscount: number;
  /** Ceiling on a bot's daily orders under this tier. Zero means unlimited. */
  dailyTrades: number;
  aiBots: boolean;
  paidModels: boolean;
  features: string[];
};

export const TIERS: TierSpec[] = [
  {
    id: "free",
    name: "Free",
    tagline: "Watch the book and quote by hand",
    monthly: 0,
    yearly: 0,
    yearlyDiscount: 0,
    dailyTrades: 0,
    aiBots: false,
    paidModels: false,
    features: [
      "Standard bots that quote around the book",
      "Model reads on demand, one contract at a time",
      "Full market history and settled results",
      "Positions, orders and P&L",
    ],
  },
  {
    id: "starter",
    name: "Starter",
    tagline: "Let a model price your quotes",
    monthly: 15,
    yearly: 162,
    yearlyDiscount: 10,
    dailyTrades: 50,
    aiBots: true,
    paidModels: false,
    features: [
      "Everything in Free",
      "AI bots priced from a model read",
      "50 bot trades a day",
      "Free models, ranked by settled accuracy",
      "Pick which model runs each bot",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "The strongest models, no daily ceiling",
    monthly: 30,
    yearly: 306,
    yearlyDiscount: 15,
    dailyTrades: 0,
    aiBots: true,
    paidModels: true,
    features: [
      "Everything in Starter",
      "No daily trade ceiling",
      "Paid frontier models, once integrated",
      "Priority on the model queue",
      "Every bot slot unlocked",
    ],
  },
];

export function tierSpec(id: Tier): TierSpec {
  return TIERS.find((t) => t.id === id) ?? TIERS[0];
}

export function priceOf(id: Tier, cycle: Cycle): number {
  const spec = tierSpec(id);
  return cycle === "yearly" ? spec.yearly : spec.monthly;
}

export type Subscription = {
  address: string;
  plan: Tier;
  cycle: Cycle | null;
  since: number;
  expires: number | null;
  /** The payment that bought the current term. */
  txHash: string | null;
};

function load<T>(path: string): Record<string, T> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

let subs: Record<string, Subscription> = load<Subscription>(STORE);
let spent: Record<string, string> = load<string>(SPENT);

function persist(): void {
  try {
    writeFileSync(STORE, JSON.stringify(subs));
    writeFileSync(SPENT, JSON.stringify(spent));
  } catch {
    // A lost write costs a grant, never the caller's money: the hash still
    // proves the payment and can be presented again.
  }
}

const FREE = (address: string): Subscription => ({
  address,
  plan: "free",
  cycle: null,
  since: 0,
  expires: null,
  txHash: null,
});

export function subscriptionFor(addressRaw: string): Subscription {
  const address = addressRaw.toLowerCase();
  const current = subs[address];
  if (!current) return FREE(address);
  // An expired term reverts rather than staying paid for ever.
  if (current.expires !== null && current.expires < Date.now()) {
    subs[address] = FREE(address);
    persist();
    return subs[address];
  }
  return current;
}

/**
 * Grant a tier by proving the payment.
 *
 * Everything here is read from the chain. A caller that lies about the tier,
 * the amount, or whose payment it was fails on the receipt, not on trust.
 */
export async function redeem(
  addressRaw: string,
  txHash: string,
  tier: Tier,
  cycle: Cycle,
): Promise<{ subscription: Subscription } | { error: string }> {
  const address = addressRaw.toLowerCase();

  if (tier === "free") return { error: "The free tier needs no payment" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { error: "That is not a transaction hash" };
  if (spent[txHash.toLowerCase()]) return { error: "That payment has already been redeemed" };

  const price = priceOf(tier, cycle);
  if (price <= 0) return { error: "Unknown plan" };

  let receipt;
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { error: "That transaction is not on chain yet. Try again in a moment." };
  }
  if (receipt.status !== "success") return { error: "That transaction failed on chain" };

  // Find a token transfer of at least the price, from this account to us.
  const need = BigInt(Math.round(price * 10 ** DECIMALS));
  let paid = 0n;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== COLLATERAL) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
      if (event.eventName !== "Transfer") continue;
      const { from, to, value } = event.args as { from: Address; to: Address; value: bigint };
      if (from.toLowerCase() !== address || to.toLowerCase() !== TREASURY) continue;
      paid += value;
    } catch {
      // Not a transfer we can read; ignore rather than fail the whole receipt.
    }
  }

  if (paid < need) {
    const short = Number(need - paid) / 10 ** DECIMALS;
    return { error: `That payment is ${short.toFixed(2)} tUSDC short of the ${tier} plan` };
  }

  const now = Date.now();
  const current = subscriptionFor(address);
  // Extend rather than restart when the same account renews early.
  const base = current.plan === tier && current.expires && current.expires > now ? current.expires : now;
  const term = cycle === "yearly" ? 365 * DAY : 30 * DAY;

  subs[address] = { address, plan: tier, cycle, since: now, expires: base + term, txHash: txHash.toLowerCase() };
  spent[txHash.toLowerCase()] = address;
  persist();

  return { subscription: subs[address] };
}
