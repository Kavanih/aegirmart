import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const root = (n) => fileURLToPath(new URL(`../${n}`, import.meta.url));

const TARGET_LOW = 0.70, TARGET_HIGH = 0.80;
const address = process.argv[2] ?? "0xbe61a15b91676d019090e63190dc49d73044e202";
const botId = process.argv[3] ?? "af6a19dd-b273-4313-8204-50b335abc05b";

let decisions = [];
try { decisions = JSON.parse(readFileSync(root("decisions.json"), "utf8")); } catch { /* none yet */ }

const res = await fetch(`http://localhost:8787/api/bots/${botId}/activity?address=${address}`);
const d = await res.json();
const settled = d.orders.filter((o) => o.won !== null && o.filled > 0);
const byMarket = new Map(settled.map((o) => [o.marketId, o]));

const joined = decisions
  .map((x) => ({ ...x, order: byMarket.get(x.marketId) }))
  .filter((x) => x.order);

console.log(`target: ${TARGET_LOW * 100}-${TARGET_HIGH * 100}% accurate\n`);

if (joined.length === 0) {
  console.log(`  no settled trades recorded with their inputs yet (${decisions.length} decisions logged).`);
  console.log("  every trade from here carries its model value, offer and edge,");
  console.log("  so the next cut is measured rather than inferred from price.");
} else {
  const won = joined.filter((x) => x.order.won).length;
  const rate = won / joined.length;
  console.log(`  overall: ${won}/${joined.length} = ${Math.round(rate * 100)}%`,
    rate >= TARGET_LOW ? " ON TARGET" : " BELOW TARGET");
  console.log("\n  by conviction (how far below its worth the leg was bought):");
  console.log("    edge          trades  won   rate");
  for (const [lo, hi] of [[0.08, 0.15], [0.15, 0.25], [0.25, 1]]) {
    const g = joined.filter((x) => x.edge >= lo && x.edge < hi);
    if (!g.length) continue;
    const w = g.filter((x) => x.order.won).length;
    console.log("    " + `${Math.round(lo * 100)}-${Math.round(hi * 100)}c`.padEnd(14),
      String(g.length).padStart(5), String(w).padStart(5),
      (Math.round(w / g.length * 100) + "%").padStart(6),
      w / g.length >= TARGET_LOW ? " on target" : "");
  }
}
console.log(`\n  ${settled.length} settled trades on chain, ${decisions.length} decisions recorded`);
