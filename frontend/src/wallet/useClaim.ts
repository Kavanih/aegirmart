import { useCallback, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { writeContract, waitForTransactionReceipt } from "wagmi/actions";
import { parseAbi, type Address } from "viem";
import { somniaTestnet } from "./config";
import { ONE } from "./trade";

// Settlement core is CREATE3 deterministic, so it is the same on both networks.
export const BINARY_SETTLEMENT = "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23" as Address;

// finalizeAndRedeem settles the market and pays out in one call, so a user never
// has to know that a finished market still owes them money.
const settlementAbi = parseAbi([
  "function finalizeAndRedeem(address pool, uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
]);

export function useClaim() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const [claiming, setClaiming] = useState<string | null>(null);

  const claim = useCallback(
    async (pool: string, outcomeId: string, size: number, onEvent: (phase: "sent" | "done" | "error", detail: string) => void) => {
      if (!address) return onEvent("error", "Connect a wallet first");
      if (chainId !== somniaTestnet.id) return onEvent("error", "Switch to Somnia testnet");
      if (!pool || !outcomeId) return onEvent("error", "This position has no settlement pool");

      const amount = BigInt(Math.floor(size * Number(ONE)));
      if (amount <= 0n) return onEvent("error", "Nothing to claim");

      setClaiming(outcomeId);
      try {
        const hash = await writeContract(config, {
          abi: settlementAbi,
          address: BINARY_SETTLEMENT,
          functionName: "finalizeAndRedeem",
          args: [pool as Address, BigInt(outcomeId), amount, address],
        });
        onEvent("sent", hash);

        const receipt = await waitForTransactionReceipt(config, { hash });
        onEvent(receipt.status === "success" ? "done" : "error", hash);
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        onEvent("error", /User rejected|denied/i.test(raw) ? "Signature rejected" : raw.split("\n")[0].slice(0, 120));
      } finally {
        setClaiming(null);
      }
    },
    [address, chainId, config],
  );

  return { claim, claiming };
}
