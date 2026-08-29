import { strikeSeries, settledHistory } from "./markets.js";

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/**
 * Oldest spot that may still be priced against.
 *
 * A new sixty second window mints every minute, so three missed mints means the
 * venue has stopped rather than merely lagged. Pricing a five minute contract
 * against an hour old price is a guess wearing a probability's clothes.
 */
const MAX_SPOT_AGE = Number(process.env.MAX_SPOT_AGE ?? 240);

/**
 * How far to push a raw estimate away from a coin flip.
 *
 * The lognormal digital is directionally right here but far too timid.
 * Backtested over 47 settled five minute windows, taken halfway through:
 *
 *   said 55-65% up  ->  BTC finished up 69% of the time, ETH 80%
 *   said 35-55% up  ->  BTC finished up 17% of the time, ETH 25%
 *
 * Right every time, and understated every time. Left raw it prices its own
 * calls below what they are worth, so the ceiling refuses trades it should
 * take and the bot sits out almost everything.
 *
 * Fitted on 47 windows, which is few. Deliberately set below what the sample
 * suggests: half the correction rather than all of it.
 */
const CONFIDENCE_GAIN = Number(process.env.CONFIDENCE_GAIN ?? 1.8);

/** Stretch a probability away from 0.5, keeping it a probability. */
export function calibrate(p: number, gain = CONFIDENCE_GAIN): number {
  return Math.min(0.98, Math.max(0.02, 0.5 + (p - 0.5) * gain));
}

// Abramowitz and Stegun 7.1.26. Accurate to ~1e-7, enough for a display probability.
function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-z * z)));
}

// Annualised realised volatility from close to close log returns.
export function realisedVol(closes: number[], barSeconds: number): number {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) returns.push(r);
  }
  if (returns.length < 2) return 0.6;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const perBar = Math.sqrt(variance);
  const barsPerYear = SECONDS_PER_YEAR / barSeconds;
  const annual = perBar * Math.sqrt(barsPerYear);

  return Math.min(Math.max(annual, 0.05), 5);
}

// Probability a digital call finishes in the money under lognormal spot.
export function digitalProbability(spot: number, strike: number, vol: number, tauSeconds: number): number {
  if (tauSeconds <= 0 || spot <= 0 || strike <= 0) return 0.5;
  const tau = tauSeconds / SECONDS_PER_YEAR;
  const denom = vol * Math.sqrt(tau);
  if (denom <= 0) return spot >= strike ? 1 : 0;
  const d2 = (Math.log(spot / strike) - (vol * vol * tau) / 2) / denom;
  return normalCdf(d2);
}

// Share of past settled windows at similar moneyness that resolved up.
export function baseRate(history: { strike: number; wentUp: boolean }[], spot: number, strike: number) {
  const target = Math.log(spot / strike);
  const width = 0.0015;

  let near = history.filter((h) => Math.abs(Math.log(spot / h.strike) - target) <= width);
  if (near.length < 12) near = history;
  if (near.length === 0) return { probability: 0.5, sampleSize: 0 };

  const ups = near.filter((h) => h.wentUp).length;
  return { probability: ups / near.length, sampleSize: near.length };
}

export type Evidence = {
  asset: string;
  spot: number;
  strike: number;
  tauSeconds: number;
  vol: number;
  modelProbability: number;
  baseRateProbability: number;
  baseRateSample: number;
  marketProbability: number | null;
};

// Assembles everything the model is allowed to reason over. It never guesses price.
export async function buildEvidence(market: {
  asset: string;
  strike: number;
  expiry: number;
  intervalSec: number;
  lastPrice: number | null;
}): Promise<Evidence> {
  // The sixty second lane mints at the money every minute, so its strikes are a
  // per-minute record of spot. The five minute window being priced keeps the
  // strike it was minted at, and the gap between the two is the whole signal.
  const [closes, history] = await Promise.all([
    strikeSeries(market.asset, 120).catch(() => []),
    settledHistory(market.asset, market.intervalSec, 400).catch(() => []),
  ]);

  // A price is only evidence while it is current.
  const latest = closes.length ? closes[closes.length - 1] : null;
  const spotAge = latest ? Math.floor(Date.now() / 1000) - latest.t : Infinity;
  if (!latest || spotAge > MAX_SPOT_AGE) {
    throw new Error(`spot is ${latest ? `${spotAge}s old` : "unavailable"}; refusing to price`);
  }
  const spot = latest.price;
  const vol = realisedVol(closes.map((c) => c.price), 60);
  const tauSeconds = Math.max(0, market.expiry - Math.floor(Date.now() / 1000));

  const rate = baseRate(history, spot, market.strike);

  return {
    asset: market.asset,
    spot,
    strike: market.strike,
    tauSeconds,
    vol,
    modelProbability: calibrate(digitalProbability(spot, market.strike, vol, tauSeconds)),
    baseRateProbability: rate.probability,
    baseRateSample: rate.sampleSize,
    marketProbability: market.lastPrice,
  };
}
