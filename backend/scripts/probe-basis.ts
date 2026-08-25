import "dotenv/config";
import { costBasisFor } from "../src/fills.js";
import { positionsFor } from "../src/markets.js";

const A = "0xbe61a15b91676d019090e63190dc49d73044e202";
try {
  const basis = await costBasisFor(A);
  const keys = Object.keys(basis);
  console.log("basis markets:", keys.length);
  for (const k of keys.slice(0, 5)) console.log("  ", k.slice(-8), JSON.stringify(basis[k]));

  const positions = await positionsFor(A, 100);
  console.log("\nposition marketIds:");
  for (const p of positions.slice(0, 6)) console.log("  ", p.marketId.slice(-8), "outcome", p.outcomeIndex, "size", p.size, "-> basis?", Boolean(basis[p.marketId]?.[p.outcomeIndex]));
} catch (e) {
  console.error("costBasisFor THREW:", (e as Error).message);
}
