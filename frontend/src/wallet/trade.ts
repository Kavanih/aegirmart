import { parseAbi, maxUint256, erc20Abi, type Address } from "viem";
import type { Market } from "../api";

// The generic placeOrder reverts UseBinaryPlacement on a binary pool: the
// YES/NO leg is an explicit param here, and price is always the YES side.
export const binaryPoolAbi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);

export { erc20Abi };

export const ORDER_KIND = { BUY_YES: 0, SELL_YES: 1, BUY_NO: 2, SELL_NO: 3 } as const;
export const ORDER_TYPE = { LIMIT: 0, FILL_OR_KILL: 1, IOC: 2, POST_ONLY: 3 } as const;
export const CANCEL_TAKER = 0;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

// Testnet collateral is six decimals. Binary rows carry no tickSize or lotSize,
// so the venue grid is not discoverable and these mirror the kit's defaults.
export const DECIMALS = 6;
export const ONE = 10n ** BigInt(DECIMALS);
export const TICK = 1000n;
// Measured against the live venue: 0.01 shares, not the kit default of 1.
export const LOT = 10_000n;

// Snap in grid steps rather than raw units: the step count is small enough that
// one rounding absorbs float error, which multiplying by 10^n does not.
function snap(human: number, step: bigint, mode: "round" | "floor"): bigint {
  const perOne = Number(ONE / step);
  const n = human * perOne;
  const steps = mode === "round" ? Math.round(n) : Math.floor(n + 1e-9);
  return BigInt(Math.max(0, steps)) * step;
}

export type Direction = "up" | "down";

export type OrderPlan = {
  pool: Address;
  collateral: Address;
  kind: number;
  priceYes: bigint;
  quantity: bigint;
  expireNs: bigint;
  escrow: bigint;
  shares: number;
  limitPrice: number;
};

/**
 * Build a resting limit buy on one leg.
 *
 * `limitPrice` is what we are willing to pay for the leg we are buying, in that
 * leg's own probability. The pool always wants the YES price, which is the
 * complement on the down leg.
 */
export function planOrder(market: Market, direction: Direction, stake: number, limitPrice = 0.5): OrderPlan | null {
  if (!market.poolAddress || !market.collateral) return null;

  const ownPrice = snap(limitPrice, TICK, "round");
  if (ownPrice <= 0n || ownPrice >= ONE) return null;

  const priceYes = direction === "up" ? ownPrice : ONE - ownPrice;

  // Escrow is price times quantity in the leg's own price, so size from the stake.
  const quantity = snap(stake / limitPrice, LOT, "floor");
  if (quantity <= 0n) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = Math.min(nowSec + 3600, market.expiry);
  if (expiresAt <= nowSec) return null;

  return {
    pool: market.poolAddress as Address,
    collateral: market.collateral as Address,
    kind: direction === "up" ? ORDER_KIND.BUY_YES : ORDER_KIND.BUY_NO,
    priceYes,
    quantity,
    expireNs: BigInt(expiresAt) * 1_000_000_000n,
    escrow: (ownPrice * quantity) / ONE,
    shares: Number(quantity) / Number(ONE),
    limitPrice: Number(ownPrice) / Number(ONE),
  };
}

export function orderArgs(plan: OrderPlan) {
  return [
    plan.kind,
    plan.priceYes,
    plan.quantity,
    plan.expireNs,
    ORDER_TYPE.LIMIT,
    CANCEL_TAKER,
    ZERO_ADDRESS,
    0n,
    0n,
  ] as const;
}

export const APPROVE_AMOUNT = maxUint256;

/**
 * What to bid for a side.
 *
 * The model read is the whole point of the app, so it sets the price when it is
 * available: a swipe becomes a resting bid at what the model thinks it is worth.
 * Clamped away from the extremes so a confident read cannot bid the full dollar.
 */
export function bidPrice(direction: Direction, modelProbability: number | null): number {
  const fair = modelProbability ?? 0.5;
  const own = direction === "up" ? fair : 1 - fair;
  return Math.min(0.95, Math.max(0.05, Math.round(own * 100) / 100));
}
