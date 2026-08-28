import { createPublicClient, createWalletClient, http, parseAbi, erc20Abi, maxUint256, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Order placement for the runner.
 *
 * Mirrors the browser path in frontend/src/wallet/trade.ts. The generic
 * placeOrder reverts UseBinaryPlacement on a binary pool, so the leg is an
 * explicit argument and price always refers to the YES side.
 */
export const RPC = process.env.SOMNIA_RPC ?? "https://dream-rpc.somnia.network";
export const CHAIN_ID = 50312;

const somnia = {
  id: CHAIN_ID,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

export const binaryPoolAbi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  // Without these the client cannot decode a custom revert and every failure
  // reads as a bare "execution reverted", which hides which guard fired.
  "error PostOnlyWouldCross()",
  "error UseBinaryPlacement()",
  "error InvalidPrice()",
  "error InvalidQuantity()",
  "error MarketNotTrading()",
  "error SelfMatch()",
  "error IncorrectSender(address expected, address actual)",
]);

export const ORDER_KIND = { BUY_YES: 0, SELL_YES: 1, BUY_NO: 2, SELL_NO: 3 } as const;
/** Post-only: a quote that would cross is rejected rather than taking. */
export const ORDER_TYPE_LIMIT = 0;
export const ORDER_TYPE_POST_ONLY = 3;

const DECIMALS = 6;
const ONE = 10n ** BigInt(DECIMALS);
const TICK = 1000n;
const LOT = 10_000n;

export const publicClient = createPublicClient({ chain: somnia, transport: http(RPC) });

function snap(human: number, step: bigint, mode: "round" | "floor"): bigint {
  const perOne = Number(ONE / step);
  const n = human * perOne;
  const steps = mode === "round" ? Math.round(n) : Math.floor(n + 1e-9);
  return BigInt(Math.max(0, steps)) * step;
}

export type Quote = {
  pool: Address;
  collateral: Address;
  /** The leg being bought. Buying NO is how a maker offers YES without holding it. */
  side: "yes" | "no";
  /** Price of the leg being bought, in its own probability. */
  price: number;
  /**
   * Price to size the stake against, when it differs from the limit.
   *
   * A taking order fills at the resting offer, so sizing on the limit bought
   * fewer shares than the stake pays for and spent less than was asked.
   */
  sizeAt?: number;
  /** Collateral to commit, in tUSDC. */
  stake: number;
  expiry: number;
  /**
   * Post only rests and never takes, which is what a market maker wants. A
   * directional bot wants the opposite: if the book is offering something for
   * less than it is worth, it should be allowed to cross and actually buy it.
   */
  taking?: boolean;
};

export type PlacedQuote = { hash: string; shares: number; price: number };

/**
 * Buy one leg as a resting post-only bid.
 *
 * Both sides of a two-sided quote are BUYS here: bidding YES and bidding NO is
 * economically a bid and an offer on YES, and neither needs the maker to hold
 * outcome tokens. That is what lets the runner quote without minting a set,
 * and therefore without dragging the faucet in.
 */
export async function placeQuote(privateKey: string, q: Quote): Promise<PlacedQuote | { error: string }> {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const wallet = createWalletClient({ account, chain: somnia, transport: http(RPC) });

  const ownPrice = snap(q.price, TICK, "round");
  if (ownPrice <= 0n || ownPrice >= ONE) return { error: "price off the grid" };

  const quantity = snap(q.stake / (q.sizeAt && q.sizeAt > 0 ? q.sizeAt : q.price), LOT, "floor");
  if (quantity <= 0n) return { error: "stake too small for one lot" };

  const escrow = (ownPrice * quantity) / ONE;

  try {
    const allowance = await publicClient.readContract({
      abi: erc20Abi,
      address: q.collateral,
      functionName: "allowance",
      args: [account.address, q.pool],
    });

    if (allowance < escrow) {
      const approveHash = await wallet.writeContract({
        abi: erc20Abi,
        address: q.collateral,
        functionName: "approve",
        args: [q.pool, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    // The pool always wants the YES price, which is the complement on the NO leg.
    const priceYes = q.side === "yes" ? ownPrice : ONE - ownPrice;
    const nowSec = Math.floor(Date.now() / 1000);
    // Expire with the window, so a stale quote cannot outlive its market and
    // the runner never has to cancel anything.
    if (q.expiry <= nowSec + 5) return { error: "window too close to expiry" };

    const hash = await wallet.writeContract({
      abi: binaryPoolAbi,
      address: q.pool,
      functionName: "placeBinaryOrder",
      args: [
        q.side === "yes" ? ORDER_KIND.BUY_YES : ORDER_KIND.BUY_NO,
        priceYes,
        quantity,
        BigInt(q.expiry) * 1_000_000_000n,
        q.taking ? ORDER_TYPE_LIMIT : ORDER_TYPE_POST_ONLY,
        0,
        "0x0000000000000000000000000000000000000000" as Address,
        0n,
        0n,
      ],
    });

    // A reverted binary write does not always throw, so read the receipt.
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") return { error: "order reverted" };

    return { hash, shares: Number(quantity) / Number(ONE), price: Number(ownPrice) / Number(ONE) };
  } catch (err) {
    return { error: revertReason(err) };
  }
}

/**
 * A usable reason from a viem error.
 *
 * viem puts the decoded revert on a line well below the first, so reading only
 * line one reports "reverted with the following signature" for everything and
 * hides which guard actually fired.
 */
export function revertReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);

  const named = raw.match(/\b([A-Z][A-Za-z0-9]*)\((?:[^)]*)\)/);
  if (named && !/^(Error|TypeError)$/.test(named[1])) return named[1];

  const reason = raw.match(/reverted with (?:the following reason|custom error):\s*\n?\s*(.+)/);
  if (reason) return reason[1].trim().slice(0, 120);

  const short = raw.match(/Details:\s*(.+)/);
  if (short) return short[1].trim().slice(0, 120);

  // Undecodable custom error: keep the selector so it can be identified rather
  // than logging "execution reverted" forever.
  const selector = raw.match(/0x[0-9a-fA-F]{8}(?![0-9a-fA-F])/);
  if (selector) return `reverted ${selector[0]}`;

  return raw.split("\n")[0].slice(0, 120);
}
