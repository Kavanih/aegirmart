import { buildEvidence } from "./src/quant.js";
import { liveMarkets, liveBooks } from "./src/markets.js";
const markets = (await liveMarkets(300, 10)).filter((m) => m.asset === "BTC");
const books = await liveBooks().catch(() => []);
const byId = new Map(books.map((b) => [b.marketId, b]));
const now = Math.floor(Date.now() / 1000);
for (const m of markets.slice(0, 2)) {
  const ev = await buildEvidence(m).catch((e) => null);
  if (!ev) { console.log(m.asset, "evidence unavailable"); continue; }
  const p = ev.modelProbability;
  const b = byId.get(m.marketId);
  const bid = b?.bids[0]?.price ?? null, ask = b?.asks[0]?.price ?? null;
  const up = p > 0.5, worth = up ? p : 1 - p;
  const offer = up ? ask : (bid === null ? null : 1 - bid);
  let v;
  if (Math.abs(p - 0.5) < 0.05) v = "sit out - no call";
  else if (offer === null) v = `BUY ${up ? "UP" : "DOWN"} at own value ${worth.toFixed(3)}`;
  else if (offer > worth) v = `sit out - costs ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
  else v = `>>> BUY ${up ? "UP" : "DOWN"} at ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
  console.log(`  ${m.asset} ${m.expiry - now}s left | quant p=${p.toFixed(3)} | bid=${bid} ask=${ask} -> ${v}`);
}
