// Find why a settled win will not redeem. Simulation only, nothing is sent.
import "dotenv/config";
import { createPublicClient, http, defineChain, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { positionsFor } from "../src/markets.js";

const chain = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } }, testnet: true,
});

const SETTLEMENT = "0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23" as Address;
const abi = parseAbi([
  "function redeem(uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
  "function finalizeAndRedeem(address pool, uint256 outcomeId, uint256 amount, address to) returns (uint256 collateralOut)",
  "function finalize(address pool) returns (uint256 marketKey)",
  "function isFinalized(uint256 outcomeId) view returns (bool)",
  "function isPoolApproved(address pool) view returns (bool)",
  "function outcomeToken() view returns (address)",
]);
const erc6909 = parseAbi([
  "function balanceOf(address owner, uint256 id) view returns (uint256)",
]);

const rawIn = (process.env.PRIVATE_KEY ?? process.env.PK ?? "").trim();
const raw = rawIn && !rawIn.startsWith("0x") ? `0x${rawIn}` : rawIn;
const account = privateKeyToAccount(raw as `0x${string}`);
const pub = createPublicClient({ chain, transport: http() });

const code = await pub.getBytecode({ address: SETTLEMENT });
console.log(`settlement ${SETTLEMENT} hasCode=${Boolean(code && code !== "0x")}\n`);

const positions = await positionsFor(account.address, 100);
const won = positions.filter((p) => p.finalized && p.winningOutcome !== null && p.outcomeIndex === p.winningOutcome);
console.log(`positions ${positions.length}, won ${won.length}\n`);

const outcomeTokenAddr = await pub.readContract({ abi, address: SETTLEMENT, functionName: "outcomeToken" }).catch(() => null);
console.log(`outcomeToken ${outcomeTokenAddr}\n`);

for (const p of won.slice(0, 3)) {
  const id = BigInt(p.outcomeId);
  const amount = BigInt(Math.floor(p.size * 1e6));
  console.log(`--- ${p.asset} ${p.intervalSec}s outcomeIndex=${p.outcomeIndex} size=${p.size} pool=${p.poolAddress}`);
  console.log(`    outcomeId ${p.outcomeId}`);

  for (const [label, fn] of [["isFinalized", "isFinalized"], ["isPoolApproved", "isPoolApproved"]] as const) {
    try {
      const args = fn === "isFinalized" ? [id] : [p.poolAddress as Address];
      const v = await pub.readContract({ abi, address: SETTLEMENT, functionName: fn as any, args: args as any });
      console.log(`    ${label}: ${v}`);
    } catch (e) { console.log(`    ${label}: read failed ${(e as Error).message.split("\n")[0].slice(0, 70)}`); }
  }

  if (outcomeTokenAddr) {
    try {
      const bal = await pub.readContract({ abi: erc6909, address: outcomeTokenAddr as Address, functionName: "balanceOf", args: [account.address, id] });
      console.log(`    token balance: ${bal} (want >= ${amount})`);
    } catch (e) { console.log(`    token balance read failed`); }
  }

  for (const fn of ["redeem", "finalizeAndRedeem"] as const) {
    try {
      const args = fn === "redeem" ? [id, amount, account.address] : [p.poolAddress as Address, id, amount, account.address];
      const sim = await pub.simulateContract({ abi, address: SETTLEMENT, functionName: fn, args: args as any, account });
      console.log(`    ${fn}: OK -> ${sim.result}`);
    } catch (e) {
      const m = (e as Error).message;
      const sel = m.match(/0x[0-9a-f]{8}/i)?.[0] ?? "";
      const named = m.match(/Error:\s*(\w+)\(/)?.[1] ?? "";
      console.log(`    ${fn}: REVERT ${named || sel || m.split("\n")[0].slice(0, 80)}`);
    }
  }
  console.log();
}
