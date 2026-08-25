/**
 * Place resting test orders on live event contracts.
 *
 * Standalone on purpose: the server never reads PRIVATE_KEY, so a deployed
 * backend cannot leak or spend it. Run locally only.
 *
 *   npx tsx scripts/test-orders.ts            place 10 orders
 *   COUNT=4 STAKE=2 npx tsx scripts/test-orders.ts
 *   DRY_RUN=1 npx tsx scripts/test-orders.ts  plan only, sign nothing
 */
import "dotenv/config";
import { createWalletClient, createPublicClient, http, defineChain, parseAbi, erc20Abi, maxUint256, formatUnits, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { liveMarkets } from "../src/markets.js";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
  testnet: true,
});

const binaryPoolAbi = parseAbi([
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);

const ONE = 1_000_000n;
const TICK = 1000n;
// Measured on the live venue: quantities must be whole multiples of 0.01
// shares. The bot kit default of 1 is four orders of magnitude too fine.
const LOT = 10_000n;
const ORDER_TYPE_LIMIT = 0;
const KIND = { BUY_YES: 0, BUY_NO: 2 };
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const COUNT = Number(process.env.COUNT ?? 10);
const STAKE = Number(process.env.STAKE ?? 2);
const DRY_RUN = process.env.DRY_RUN === "1";
const EXPLORER = "https://shannon-explorer.somnia.network/tx";

function snap(human: number, step: bigint): bigint {
  const perOne = Number(ONE / step);
  return BigInt(Math.max(0, Math.round(human * perOne))) * step;
}

async function main() {
  // Accept PRIVATE_KEY or PK, with or without the 0x prefix.
  const rawInput = (process.env.PRIVATE_KEY ?? process.env.PK ?? "").trim();
  const raw = rawInput && !rawInput.startsWith("0x") ? `0x${rawInput}` : rawInput;
  const hasKey = /^0x[0-9a-fA-F]{64}$/.test(raw);

  // A dry run plans orders without a key; only a live run needs to sign.
  if (!hasKey && !DRY_RUN) {
    console.error("Set PRIVATE_KEY (or PK) to 64 hex chars in backend/.env. Nothing was sent.");
    process.exit(1);
  }

  const account = hasKey ? privateKeyToAccount(raw as `0x${string}`) : null;
  const pub = createPublicClient({ chain: somniaTestnet, transport: http() });
  const wallet = account ? createWalletClient({ account, chain: somniaTestnet, transport: http() }) : null;

  console.log(`account   ${account ? account.address : "none, dry run"}`);
  console.log(`mode      ${DRY_RUN ? "DRY RUN, nothing is signed" : "LIVE"}`);

  if (account) {
    const gas = await pub.getBalance({ address: account.address });
    console.log(`gas       ${formatUnits(gas, 18)} STT`);
  }

  // Two lanes so a rolling window never leaves the script with nothing to do.
  const markets = [...(await liveMarkets(300, 30)), ...(await liveMarkets(60, 15))];
  if (markets.length === 0) {
    console.error("No live markets right now. Windows roll every minute, try again.");
    process.exit(1);
  }

  const collateral = markets[0].collateral as Address;
  if (account) {
    const balance = await pub.readContract({ abi: erc20Abi, address: collateral, functionName: "balanceOf", args: [account.address] });
    console.log(`collateral ${formatUnits(balance, 6)} tUSDC`);
  }
  console.log(`markets   ${markets.length} live\n`);

  let placed = 0;
  let failed = 0;

  for (let i = 0; i < COUNT; i += 1) {
    const market = markets[i % markets.length];
    // Alternate sides and walk the price so the orders do not self-match.
    const direction = i % 2 === 0 ? "up" : "down";
    const own = 0.4 + (i % 5) * 0.03;
    const ownPrice = snap(own, TICK);
    const priceYes = direction === "up" ? ownPrice : ONE - ownPrice;
    const rawQty = BigInt(Math.floor((STAKE / own) * Number(ONE)));
    const quantity = (rawQty / LOT) * LOT;
    if (quantity <= 0n) { console.log(`${i + 1}. skipped, size rounds below one lot`); continue; }

    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(nowSec + 3600, market.expiry);
    if (expiresAt <= nowSec + 5) {
      console.log(`${i + 1}. skipped, ${market.asset} window closing`);
      continue;
    }

    const label = `${market.asset} ${market.intervalSec}s ${direction.toUpperCase()} @ ${(own * 100).toFixed(0)}c size ${(Number(quantity) / 1e6).toFixed(2)}`;
    if (DRY_RUN || !wallet || !account) {
      console.log(`${i + 1}. would place ${label}`);
      continue;
    }

    try {
      const pool = market.poolAddress as Address;
      const allowance = await pub.readContract({ abi: erc20Abi, address: collateral, functionName: "allowance", args: [account.address, pool] });
      const escrow = (ownPrice * quantity) / ONE;

      if (allowance < escrow) {
        const approveHash = await wallet.writeContract({ abi: erc20Abi, address: collateral, functionName: "approve", args: [pool, maxUint256] });
        await pub.waitForTransactionReceipt({ hash: approveHash });
        console.log(`   approved pool ${pool.slice(0, 10)}`);
      }

      const hash = await wallet.writeContract({
        abi: binaryPoolAbi,
        address: pool,
        functionName: "placeBinaryOrder",
        args: [direction === "up" ? KIND.BUY_YES : KIND.BUY_NO, priceYes, quantity, BigInt(expiresAt) * 1_000_000_000n, ORDER_TYPE_LIMIT, 0, ZERO, 0n, 0n],
      });

      // A reverted binary write does not always throw, so read the receipt.
      const receipt = await pub.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        placed += 1;
        console.log(`${i + 1}. ok      ${label}\n   ${EXPLORER}/${hash}`);
      } else {
        failed += 1;
        console.log(`${i + 1}. REVERTED ${label}\n   ${EXPLORER}/${hash}`);
      }
    } catch (err) {
      failed += 1;
      console.log(`${i + 1}. failed  ${label}\n   ${(err as Error).message.split("\n")[0].slice(0, 160)}`);
    }
  }

  console.log(`\nplaced ${placed}, failed ${failed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
