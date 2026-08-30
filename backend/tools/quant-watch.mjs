import { buildEvidence } from "../src/quant.js";
import { liveMarkets, liveBooks } from "../src/markets.js";

// Mirrors the runner. A watcher that disagrees with the code it watches is the
// worst kind of instrument, since it is what the strategy gets judged by.
const MAX = 0.6, FLOOR = 0.4, EDGE = 0.15;
// Both assets. Watching only BTC hid every ETH decision on a bot that trades
// both, which is half of what it does.
const now0 = Math.floor(Date.now() / 1000);
const markets = (await liveMarkets(300, 10))
  .filter((m) => m.expiry > now0)
  .sort((a, b) => a.expiry - b.expiry);
const books = await liveBooks().catch(() => []);
const byId = new Map(books.map((b) => [b.marketId, b]));
const now = Math.floor(Date.now() / 1000);
for (const m of markets.slice(0, 4)) {
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
  else if (offer < FLOOR) v = `sit out - ${offer.toFixed(3)} is the book saying no`;
  else if (offer > MAX) v = `sit out - ${offer.toFixed(3)} is over the ${MAX} ceiling`;
  else if (worth - offer < EDGE) v = `sit out - ${((worth - offer) * 100).toFixed(1)}c edge, needs ${EDGE * 100}`;
  else v = `>>> BUY ${up ? "UP" : "DOWN"} at ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
  console.log(`  ${m.asset} ${left}s left (${Math.round(elapsed * 100)}% in) | quant p=${p.toFixed(3)} | bid=${bid} ask=${ask} -> ${v}`);
}
