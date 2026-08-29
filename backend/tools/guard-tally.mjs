import { buildEvidence } from "../src/quant.js";
import { liveMarkets, liveBooks } from "../src/markets.js";

const tally = new Map();
const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rounds = Number(process.argv[2] ?? 20);
for (let i = 0; i < rounds; i++) {
  const now = Math.floor(Date.now() / 1000);
  const markets = (await liveMarkets(300, 10)).filter((m) => m.expiry > now);
  const books = await liveBooks().catch(() => []);
  const byId = new Map(books.map((b) => [b.marketId, b]));
  for (const m of markets) {
    const ev = await buildEvidence(m).catch(() => null);
    if (!ev) { bump("no evidence"); continue; }
    const p = ev.modelProbability;
    const b = byId.get(m.marketId);
    const bid = b?.bids[0]?.price ?? null, ask = b?.asks[0]?.price ?? null;
    const up = p > 0.5, worth = up ? p : 1 - p;
    const offer = up ? ask : (bid === null ? null : 1 - bid);
    const elapsed = (m.intervalSec - (m.expiry - now)) / m.intervalSec;
    if (Math.abs(p - 0.5) < 0.05) bump("1 no call");
    else if (elapsed < 0.3) bump("2 too early");
    else if (elapsed > 0.62) bump("3 too late");
    else if (offer === null) bump("4 no offer");
    else if (offer > worth) bump("5 dearer than worth");
    else if (offer < 0.4) bump("6 below the floor");
    else bump("7 WOULD TRADE");
  }
  await sleep(15000);
}
console.log(`${rounds} samples, 15s apart:\n`);
const total = [...tally.values()].reduce((a, b) => a + b, 0);
for (const k of [...tally.keys()].sort())
  console.log("  " + k.padEnd(22), String(tally.get(k)).padStart(4), (Math.round(tally.get(k) / total * 100) + "%").padStart(5));
