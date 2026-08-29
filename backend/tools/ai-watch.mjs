import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolved against this file, so the watcher runs from any directory.
const root = (n) => fileURLToPath(new URL(`../${n}`, import.meta.url));
const now = () => Math.floor(Date.now() / 1000);
const books = await (await fetch("http://localhost:8787/api/books")).json();
const all = Array.isArray(books) ? books : books.books || [];
const reads = JSON.parse(readFileSync(root("predictions.json"), "utf8"));
const bots = JSON.parse(readFileSync(root("bots.json"), "utf8"));
const bot = Object.values(bots).find((x) => x.id === "e8f84e4a-2d3b-424d-a539-31d277499cc5");
const t = new Date().toISOString().slice(11, 19);
const SLIP = 0.02, MAX = 0.97;

for (const m of all.filter((x) => x.intervalSec === 300)) {
  const r = reads.find((z) => z.marketId === m.marketId);
  const left = m.expiry - now();
  const pct = Math.round((m.intervalSec - left) / m.intervalSec * 100);
  if (!r) { console.log(`[${t}] ${m.asset} no read yet (${pct}% through, ${left}s left)`); continue; }
  const age = now() - r.predictedAt, fair = r.probability;
  const bid = m.bids?.[0]?.price ?? null, ask = m.asks?.[0]?.price ?? null;
  let v;
  if (Math.abs(fair - 0.5) < 0.05) v = `sit out - no call (p=${fair})`;
  else if (age > m.intervalSec * 0.34) v = `sit out - read ${age}s stale`;
  else {
    const up = fair > 0.5;
    const worth = up ? fair : 1 - fair;
    const offer = up ? ask : (bid === null ? null : 1 - bid);
    if (offer === null) v = `>>> BUY ${up ? "UP" : "DOWN"} at own value ${Math.min(MAX, worth).toFixed(2)} (no book)`;
    else if (offer > worth) v = `sit out - ${up ? "UP" : "DOWN"} costs ${offer.toFixed(3)}, worth ${worth.toFixed(3)}`;
    else v = `>>> BUY ${up ? "UP" : "DOWN"} limit ${Math.min(MAX, worth, offer + SLIP).toFixed(2)} (offer ${offer.toFixed(3)}, worth ${worth.toFixed(3)})`;
  }
  console.log(`[${t}] ${m.asset} p=${String(fair).padEnd(5)} ${r.side.padEnd(4)} age=${String(age).padStart(3)}s -> ${v}`);
}
console.log(`          ${bot.status} | reads ${bot.readsToday}/${bot.dailyReads} | trades ${bot.tradesToday}/${bot.dailyTrades}`);
