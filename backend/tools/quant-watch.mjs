import { buildEvidence } from "../src/quant.js";
import { liveMarkets, liveBooks } from "../src/markets.js";
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
  // Mirrors every guard in directionalLeg, so the watcher never reports a
  // trade the runner would refuse.
  const left = m.expiry - now;
  const elapsed = (m.intervalSec - left) / m.intervalSec;
  let v;
  if (Math.abs(p - 0.5) < 0.05) v = "sit out - no call";
  else if (elapsed < 0.3) v = `sit out - only ${Math.round(elapsed * 100)}% into the window`;
  else if (elapsed > 0.62) v = `sit out - ${Math.round(elapsed * 100)}% in, too late`;
  else if (offer === null) v = "sit out - no offer to cross";
  else if (offer > worth) v = `sit out - costs ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
  else if (offer < 0.4) v = `sit out - ${offer.toFixed(3)} is the book saying no`;
  else v = `>>> BUY ${up ? "UP" : "DOWN"} at ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
  console.log(`  ${m.asset} ${left}s left (${Math.round(elapsed * 100)}% in) | quant p=${p.toFixed(3)} | bid=${bid} ask=${ask} -> ${v}`);
}
