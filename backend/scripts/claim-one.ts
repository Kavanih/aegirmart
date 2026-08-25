// Redeem a single settled win, to prove the path end to end.
import "dotenv/config";
import { createPublicClient, createWalletClient, http, defineChain, parseAbi, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { positionsFor } from "../src/markets.js";

const chain = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } }, testnet: true,
});
const SETTLEMENT = "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23" as Address;
const abi = parseAbi([
  "function finalizeAndRedeem(address pool, uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
]);

const rawIn = (process.env.PRIVATE_KEY ?? process.env.PK ?? "").trim();
const raw = rawIn && !rawIn.startsWith("0x") ? `0x${rawIn}` : rawIn;
const account = privateKeyToAccount(raw as `0x${string}`);
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });

const positions = await positionsFor(account.address, 100);
const won = positions.filter((p) => p.finalized && p.winningOutcome !== null && p.outcomeIndex === p.winningOutcome);
if (!won.length) { console.log("nothing to claim"); process.exit(0); }

const p = won[0];
const amount = BigInt(Math.floor(p.size * 1e6));
console.log(`claiming ${p.asset} ${p.intervalSec}s ${p.outcomeIndex === 1 ? "UP" : "DOWN"} size ${p.size}`);

const hash = await wallet.writeContract({
  abi, address: SETTLEMENT, functionName: "finalizeAndRedeem",
  args: [p.poolAddress as Address, BigInt(p.outcomeId), amount, account.address],
});
const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`${receipt.status === "success" ? "CLAIMED" : "REVERTED"}  ${formatUnits(amount, 6)} tUSDC`);
console.log(`https://shannon-explorer.somnia.network/tx/${hash}`);
