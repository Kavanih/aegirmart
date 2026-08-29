import { buildEvidence } from "../src/quant.js";
import { liveMarkets } from "../src/markets.js";
const now = Math.floor(Date.now() / 1000);
for (const lane of [60, 300]) {
  const ms = (await liveMarkets(lane, 10)).filter((m) => m.asset === "BTC" && m.expiry > now);
  if (!ms.length) { console.log(`${lane}s: no live window`); continue; }
  const m = ms.sort((a, b) => a.expiry - b.expiry)[0];
  try {
    const ev = await buildEvidence(m);
    const into = lane - (m.expiry - now);
    console.log(`${lane}s window, ${into}s in: spot ${ev.spot} strike ${ev.strike} gap ${(ev.spot - ev.strike).toFixed(2)} -> p=${ev.modelProbability.toFixed(3)}`);
  } catch (e) { console.log(`${lane}s: ${(e as Error).message}`); }
}
console.log("\nthe spot tape is the 60s lane, one price a minute.");
console.log("a 60s window is exactly one tape tick long, so nothing can move inside it.");
