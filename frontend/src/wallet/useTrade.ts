import { useCallback, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { readContract, writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi, type Address } from "viem";
import { somniaTestnet } from "./config";
import { binaryPoolAbi, planOrder, orderArgs, bidPrice, APPROVE_AMOUNT, type Direction } from "./trade";
import type { Market } from "../api";

export type TradeState =
  | { phase: "idle" }
  | { phase: "approving" }
  | { phase: "placing" }
  | { phase: "done"; hash: string; direction: Direction; shares: number; price: number }
  | { phase: "error"; message: string };

// Contract reverts arrive as long multi-line strings; keep the first line.
function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/User rejected|denied transaction/i.test(raw)) return "Signature rejected";
  if (/UseBinaryPlacement/.test(raw)) return "Wrong pool entrypoint for this market";
  if (/InvalidPrice/.test(raw)) return "Price is off the tick grid";
  if (/ERC20InsufficientBalance|transfer amount exceeds/i.test(raw)) return "Not enough tUSDC";
  return raw.split("\n")[0].slice(0, 140);
}

/** Progress for one placement, so a caller can drive a single toast with it. */
export type TradePhase = "approving" | "placing" | "sent" | "done" | "error";
export type OnPhase = (phase: TradePhase, detail: string) => void;

const ignore: OnPhase = () => {};

export function useTrade() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const [state, setState] = useState<TradeState>({ phase: "idle" });

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  const place = useCallback(
    async (
      market: Market,
      direction: Direction,
      stake: number,
      modelProbability: number | null = null,
      onPhase: OnPhase = ignore,
      /**
       * Price this exact order, rather than deriving one. A caller that shows
       * the operator a price must place at that price: deriving it separately
       * meant the ticket displayed one number and the order carried another.
       */
      limitPrice?: number,
    ) => {
      const fail = (message: string) => {
        setState({ phase: "error", message });
        onPhase("error", message);
      };

      if (!address) return fail("Connect a wallet first");
      if (chainId !== somniaTestnet.id) return fail("Switch to Somnia testnet");

      const plan = planOrder(
        market,
        direction,
        stake,
        limitPrice ?? bidPrice(direction, modelProbability),
      );
      if (!plan) return fail("Window closed before the order could be built");

      try {
        const allowance = await readContract(config, {
          abi: erc20Abi,
          address: plan.collateral,
          functionName: "allowance",
          args: [address, plan.pool],
        });

        // Approve once per pool. Pools are recycled per window, so this recurs.
        if (allowance < plan.escrow) {
          setState({ phase: "approving" });
          onPhase("approving", "");
          const approveHash = await writeContract(config, {
            abi: erc20Abi,
            address: plan.collateral,
            functionName: "approve",
            args: [plan.pool as Address, APPROVE_AMOUNT],
          });
          await waitForTransactionReceipt(config, { hash: approveHash });
        }

        setState({ phase: "placing" });
        onPhase("placing", "");
        const hash = await writeContract(config, {
          abi: binaryPoolAbi,
          address: plan.pool,
          functionName: "placeBinaryOrder",
          args: orderArgs(plan),
        });

        // Signed and broadcast: say so before waiting, so a slow confirmation
        // reads as waiting on the chain rather than as a stuck app.
        onPhase("sent", hash);

        // A reverted binary write does not always throw, so check the receipt.
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") {
          setState({ phase: "error", message: "Order reverted on chain" });
          return onPhase("error", "Order reverted on chain");
        }

        setState({ phase: "done", hash, direction, shares: plan.shares, price: plan.limitPrice });
        onPhase(
          "done",
          `${hash}|${plan.shares.toFixed(2)}|${Math.round(plan.limitPrice * 100)}|${direction}`,
        );
      } catch (err) {
        const message = readableError(err);
        setState({ phase: "error", message });
        onPhase("error", message);
      }
    },
    [address, chainId, config],
  );

  return { state, place, reset };
}
