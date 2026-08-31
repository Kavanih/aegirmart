import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { digitalProbability, calibrate } from "../src/quant.js";
import { strikeSeries, settledHistory } from "../src/markets.js";

const root = (n: string) => fileURLToPath(new URL(`../${n}`, import.meta.url));
const reads = JSON.parse(readFileSync(root("predictions.json"), "utf8")) as any[];

// Rebuild what the FREE local maths would have said at the moment of each read.
const tape: Record<string, { t: number; price: number }[]> = {};
for (const a of ["BTC", "ETH"]) tape[a] = await strikeSeries(a, 400).catch(() => []);
const hist: Record<string, any[]> = {};
for (const a of ["BTC", "ETH"]) hist[a] = await settledHistory(a, 300, 400).catch(() => []);

const rows: { local: number; model: number; asset: string }[] = [];
for (const r of reads) {
  const t = tape[r.asset];
  if (!t?.length) continue;
  const prior = t.filter((p) => p.t <= r.predictedAt);
  if (!prior.length) continue;
  const spot = prior[prior.length - 1].price;
  if (r.predictedAt - prior[prior.length - 1].t > 240) continue;   // tape too stale
  const tau = r.expiry - r.predictedAt;
  if (tau <= 0) continue;
  const local = calibrate(digitalProbability(spot, r.strike, 0.7, tau));
  rows.push({ local, model: r.probability, asset: r.asset });
}

const near = (p: number, w: number) => Math.abs(p - 0.5) < w;
console.log(`reconstructed ${rows.length} of ${reads.length} stored reads\n`);

console.log("  when the FREE estimate was...        the MODEL came back...");
for (const [lo, hi, label] of [[0, 0.02, "within 2c of 0.5"], [0.02, 0.05, "2-5c away"], [0.05, 1, "over 5c away"]] as const) {
  const g = rows.filter((r) => Math.abs(r.local - 0.5) >= lo && Math.abs(r.local - 0.5) < hi);
  if (!g.length) continue;
  const calls = g.filter((r) => !near(r.model, 0.05)).length;
  console.log(`  ${label.padEnd(20)} ${String(g.length).padStart(3)} reads -> ${String(calls).padStart(3)} made a call (${Math.round(calls / g.length * 100)}%)`);
}

// What a gate would have saved, and cost.
for (const w of [0.02, 0.05]) {
  const skipped = rows.filter((r) => near(r.local, w));
  const lost = skipped.filter((r) => !near(r.model, 0.05)).length;
  console.log(`\n  gate at ${w * 100}c: would skip ${skipped.length} reads (${Math.round(skipped.length / rows.length * 100)}%), losing ${lost} real call${lost === 1 ? "" : "s"}`);
}
