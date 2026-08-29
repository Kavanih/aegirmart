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

/**
 * Most confidence this model has earned the right to act on.
 *
 * The bot pays up to what it claims a leg is worth, so this is really a price
 * ceiling. Live trades, grouped by the price actually paid:
 *
 *   45-60c   5 trades, 80% won against 52% needed   +109.43
 *   60-75c  14 trades, 50% won against 69% needed   -128.40
 *   75-100c  6 trades, 50% won against 83% needed    -76.71
 *
 * Real skill at moderate prices, none at high ones - above 60c the win rate is
 * a coin flip while the price demands two thirds. That is the same lesson the
 * whole venue keeps teaching: a confident book is a well informed one, and
 * disagreeing with it is where the money goes.
 *
 * Raised from 0.60 to 0.75 deliberately, to buy volume. On its own that walks
 * back into the 60-75c band that lost, so it is paired with a minimum edge in
 * the runner: a higher ceiling is only safe if the trades taken up there are
 * clear mispricings rather than marginal ones.
 */
const MAX_CONFIDENCE = Number(process.env.MAX_CONFIDENCE ?? 0.75);

/**
 * Fold the observed base rate into the lognormal estimate.
 *
 * The digital assumes no drift. This venue has one: settled windows have run
 * about 56% up, and near the money the local rate has read as high as 65%. The
 * estimate was reported beside the model and never used, and the cost of
 * ignoring it was one-sided - over 34 settled trades, UP calls won 68% and made
 * +73, while DOWN calls won 33% and lost 198. The model was betting against a
 * drift it had already measured and then discarded.
 *
 * Weighted by how much history the rate is built on, so a thin sample barely
 * moves the estimate and a full one counts.
 */
function blend(digital: number, rate: { probability: number; sampleSize: number }): number {
  const weight = Math.min(rate.sampleSize / BASE_RATE_FULL_WEIGHT, 1);
  return digital * (1 - weight) + rate.probability * weight;
}

/** Sample size at which the base rate carries as much weight as the digital. */
const BASE_RATE_FULL_WEIGHT = Number(process.env.BASE_RATE_FULL_WEIGHT ?? 60);

/** Stretch a probability away from 0.5, without claiming more than was measured. */
export function calibrate(p: number, gain = CONFIDENCE_GAIN): number {
  const stretched = 0.5 + (p - 0.5) * gain;
  return Math.min(MAX_CONFIDENCE, Math.max(1 - MAX_CONFIDENCE, stretched));
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
    modelProbability: calibrate(blend(digitalProbability(spot, market.strike, vol, tauSeconds), rate)),
    baseRateProbability: rate.probability,
    baseRateSample: rate.sampleSize,
    marketProbability: market.lastPrice,
  };
}
