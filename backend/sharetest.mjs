const before = JSON.parse((await import("node:fs")).readFileSync("./quota.json", "utf8")).spent;
const books = await (await fetch("http://localhost:8787/api/books")).json();
const all = Array.isArray(books) ? books : books.books || [];
const now = Math.floor(Date.now() / 1000);
// A window nobody has read yet, with time left.
const reads = JSON.parse((await import("node:fs")).readFileSync("./predictions.json", "utf8"));
const seen = new Set(reads.map((r) => r.marketId));
const m = all.find((x) => x.intervalSec === 300 && x.expiry - now > 100 && !seen.has(x.marketId));
if (!m) { console.log("no unread window available right now"); process.exit(0); }

console.log(`three users ask about the same ${m.asset} window at the same moment...`);
const t0 = Date.now();
const rs = await Promise.all([1, 2, 3].map((n) =>
  fetch("http://localhost:8787/api/prediction", {
    method: "POST",
    headers: { "content-type": "application/json", "x-session-id": `user-${n}` },
    body: JSON.stringify({ market: m }),
  }).then((r) => r.json()).then((j) => ({ n, status: j.status, p: j.prediction?.probability, cached: j.cached, model: j.model })),
));
for (const r of rs) console.log(`  user-${r.n}: ${r.status} p=${r.p} ${r.cached ? "(cached)" : "(fresh)"} ${(r.model||"").split("/").pop()||""}`);
console.log(`took ${((Date.now()-t0)/1000).toFixed(0)}s`);

const after = JSON.parse((await import("node:fs")).readFileSync("./quota.json", "utf8")).spent;
console.log(`\nallowance spent: ${before} -> ${after}  (${after - before} request${after-before===1?"":"s"} for 3 users)`);
