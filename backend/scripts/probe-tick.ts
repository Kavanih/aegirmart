// Find the venue's real price tick by simulating orders at many prices.
import "dotenv/config";
import { createPublicClient, http, defineChain, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { liveMarkets } from "../src/markets.js";

const chain = defineChain({
  id: 50312, name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } }, testnet: true,
});
const abi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const rawIn = (process.env.PRIVATE_KEY ?? process.env.PK ?? "").trim();
const raw = rawIn && !rawIn.startsWith("0x") ? `0x${rawIn}` : rawIn;
const account = privateKeyToAccount(raw as `0x${string}`);
const pub = createPublicClient({ chain, transport: http() });

const markets = await liveMarkets(300, 30);
if (!markets.length) { console.log("no live market"); process.exit(0); }
const m = markets[0];
console.log(`probing ${m.asset} ${m.intervalSec}s pool ${m.poolAddress}\n`);

const expire = BigInt(Math.min(Math.floor(Date.now() / 1000) + 600, m.expiry)) * 1_000_000_000n;
const results: { price: number; ok: boolean; err: string }[] = [];

const QUANTITIES = [
  1_000_000n, 2_000_000n, 5_000_000n, 500_000n, 250_000n, 100_000n,
  4_651_162n, 4_650_000n, 4_600_000n, 4_500_000n, 1_500_000n, 1n, 999_999n,
];
for (const q of QUANTITIES) {
  const price = 400_000n;
  try {
    await pub.simulateContract({
      abi, address: m.poolAddress as Address, functionName: "placeBinaryOrder",
      args: [0, price, q, expire, 0, 0, ZERO, 0n, 0n], account,
    });
    results.push({ price: Number(q), ok: true, err: "" });
  } catch (e) {
    const msg = (e as Error).message;
    const sel = msg.match(/0x[0-9a-f]{8}/i)?.[0] ?? "";
    const name = msg.match(/reverted with the following reason:\s*\n(.+)/)?.[1]
      ?? msg.match(/Error:\s*(\w+)\(/)?.[1] ?? sel;
    results.push({ price: Number(q), ok: false, err: name });
  }
}

for (const r of results) {
  console.log(`  qty ${String(r.price).padStart(9)} (${(r.price/1e6).toFixed(6)} shares) -> ${r.ok ? "ACCEPTED" : "rejected " + r.err}`);
}
const errs = [...new Set(results.filter(r => !r.ok).map(r => r.err))];
console.log("distinct revert reasons:", errs.slice(0, 5).join(" | "));
