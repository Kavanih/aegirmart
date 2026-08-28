import { readFileSync } from "node:fs";
const now = () => Math.floor(Date.now() / 1000);
const books = await (await fetch("http://localhost:8787/api/books")).json();
const all = Array.isArray(books) ? books : books.books || [];
const reads = JSON.parse(readFileSync("./predictions.json", "utf8"));
const bots = JSON.parse(readFileSync("./bots.json", "utf8"));
const bot = Object.values(bots).find((x) => x.id === "e8f84e4a-2d3b-424d-a539-31d277499cc5");
const t = new Date().toISOString().slice(11, 19);

for (const m of all.filter((x) => x.intervalSec === 300)) {
  const r = reads.find((z) => z.marketId === m.marketId);
  if (!r) { console.log(`[${t}] ${m.asset} no read yet (${m.expiry - now()}s left)`); continue; }
  const age = now() - r.predictedAt, fair = r.probability;
  const bid = m.bids?.[0]?.price ?? null, ask = m.asks?.[0]?.price ?? null;
  let v;
  if (Math.abs(fair - 0.5) < 0.05) v = `SIT OUT - no call (p=${fair})`;
  else if (age > m.intervalSec * 0.34) v = `SIT OUT - read ${age}s stale`;
  else if (ask !== null && fair - ask >= 0.05) v = fair - ask > 0.35 ? `SIT OUT - edge ${(fair-ask).toFixed(2)} implausible` : `>>> BUY UP at ${ask}`;
  else if (bid !== null && bid - fair >= 0.05) v = bid - fair > 0.35 ? `SIT OUT - edge ${(bid-fair).toFixed(2)} implausible` : `>>> BUY DOWN at ${(1-bid).toFixed(3)}`;
  else v = "SIT OUT - no edge";
  console.log(`[${t}] ${m.asset} p=${String(fair).padEnd(5)} ${r.side.padEnd(4)} age=${String(age).padStart(3)}s bid=${bid} ask=${ask} -> ${v}`);
}
console.log(`          reads ${bot.readsToday}/${bot.dailyReads} | trades ${bot.tradesToday}/${bot.dailyTrades}`);
