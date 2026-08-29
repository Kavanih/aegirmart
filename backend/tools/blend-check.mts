import { buildEvidence } from "../src/quant.js";
import { liveMarkets } from "../src/markets.js";
const now = Math.floor(Date.now() / 1000);
for (const asset of ["BTC", "ETH"]) {
  const ms = (await liveMarkets(300, 10)).filter((m) => m.asset === asset && m.expiry > now);
  if (!ms.length) continue;
  const m = ms.sort((a, b) => a.expiry - b.expiry)[0];
  try {
    const ev = await buildEvidence(m);
    console.log(`${asset}: spot ${ev.spot} strike ${ev.strike} | base rate ${ev.baseRateProbability.toFixed(3)} on ${ev.baseRateSample} windows -> p=${ev.modelProbability.toFixed(3)}`);
  } catch (e) { console.log(asset, (e as Error).message); }
}
