import { readFileSync } from "node:fs";
const now = () => Math.floor(Date.now() / 1000);
const books = await (await fetch("http://localhost:8787/api/books")).json();
const all = Array.isArray(books) ? books : books.books || [];
const reads = JSON.parse(readFileSync("./predictions.json", "utf8"));
const bots = JSON.parse(readFileSync("./bots.json", "utf8"));
const bot = Object.values(bots).find((x) => x.id === "e8f84e4a-2d3b-424d-a539-31d277499cc5");
const t = new Date().toISOString().slice(11, 19);
const SLIP = 0.02, MAX = 0.9;

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
  else if (fair > 0.5) v = `>>> BUY UP limit ${Math.min(MAX, ask !== null ? ask + SLIP : fair).toFixed(2)} (ask ${ask})`;
  else v = `>>> BUY DOWN limit ${Math.min(MAX, bid !== null ? 1 - bid + SLIP : 1 - fair).toFixed(2)} (bid ${bid})`;
  console.log(`[${t}] ${m.asset} p=${String(fair).padEnd(5)} ${r.side.padEnd(4)} age=${String(age).padStart(3)}s -> ${v}`);
}
console.log(`          ${bot.status} | reads ${bot.readsToday}/${bot.dailyReads} | trades ${bot.tradesToday}/${bot.dailyTrades}`);
