import { liveMarkets, liveBooks, type Market } from "./markets.js";
import { runningBots, openBotKey, recordBotFill, AI_MIN_INTERVAL, type Bot } from "./bots.js";
import { buildEvidence } from "./quant.js";
import { recordBotTrade } from "./stats.js";
import { cachedPrediction } from "./tracker.js";
import { placeQuote } from "./chain.js";

/**
 * Executes the bot definitions.
 *
 * Deliberate limits, each for a reason:
 *   - Both sides are BIDS (buy YES, buy NO). That is a bid and an offer on YES
 *     without holding outcome tokens, so the runner never mints a set and never
 *     pulls the faucet in.
 *   - Orders expire with their window, so nothing has to be cancelled and a
 *     crash cannot leave a stale quote resting.
 *   - An AI bot reads only STORED predictions. Asking the model on a timer is
 *     how the daily allowance disappears, so a bot with no read simply sits out.
 *   - One quote per bot per market per window, and a daily cap per bot.
 */
const CYCLE_MS = Number(process.env.RUNNER_CYCLE_MS ?? 20_000);
const LANES = [60, 300];
/** How far a price must sit from fair before a directional bot will act. */
const MIN_EDGE = Number(process.env.MIN_EDGE ?? 0.05);
/** The venue's price grid, so a back off lands on a legal price. */
const TICK = 0.001;

/** botId:marketId already quoted. Cleared as windows expire. */
const quoted = new Map<string, number>();

function log(message: string): void {
  console.log(`${new Date().toISOString()} runner ${message}`);
}

/** Mid of the resting book on the YES leg, or null when a side is missing. */
function bookMid(bids: { price: number }[], asks: { price: number }[]): number | null {
  if (bids.length === 0 || asks.length === 0) return null;
  return (bids[0].price + asks[0].price) / 2;
}

function wants(bot: Bot, market: Market): boolean {
  if (bot.asset !== "BOTH" && bot.asset !== market.asset) return false;
  // A model read takes tens of seconds. On a sixty second window the answer
  // arrives against a spot that has already moved, so an AI bot sits those out.
  if (bot.kind === "ai" && market.intervalSec < AI_MIN_INTERVAL) return false;
  return true;
}

/**
 * What the bot thinks the UP side is worth.
 *
 * A market maker has no view and follows the book. A quant bot prices the
 * contract itself from spot, strike, time left and realised volatility. An AI
 * bot uses its stored read and sits out where it has none.
 */
async function fairValue(bot: Bot, market: Market, mid: number | null): Promise<number | null> {
  if (bot.kind === "ai") {
    const read = cachedPrediction(market.marketId);
    return read ? read.probability : null;
  }

  if (bot.kind === "quant") {
    try {
      const evidence = await buildEvidence(market);
      return evidence.modelProbability;
    } catch {
      // No spot or no history: nothing to price against, so do not guess.
      return null;
    }
  }

  return mid ?? market.lastPrice ?? 0.5;
}

type Leg = readonly ["yes" | "no", number];

/**
 * A two sided quote around fair, backed off so it rests instead of crossing.
 * Post only refuses anything through the touch, so pricing there just burns
 * gas; a tick inside the book is the widest that will actually rest.
 */
function makerLegs(fair: number, spread: number, bestBid: number | null, bestAsk: number | null): Leg[] {
  let bid = Math.min(0.97, Math.max(0.02, fair - spread));
  let offer = Math.min(0.97, Math.max(0.02, fair + spread));
  if (bestAsk !== null) bid = Math.min(bid, bestAsk - TICK);
  if (bestBid !== null) offer = Math.max(offer, bestBid + TICK);

  // Backing off can invert the quote where the book is tighter than the bot's
  // spread. There is nothing to add there, so sit the market out.
  if (bid <= 0.02 || offer >= 0.98 || bid >= offer) return [];
  return [["yes", bid], ["no", 1 - offer]];
}

/**
 * One side, and only when the book is wrong by enough to be worth acting on.
 *
 * If YES can be bought for less than it is worth, buy YES. If YES is being bid
 * ABOVE what it is worth then NO is the cheap side, so buy that instead. Where
 * the book already agrees with fair there is no bet here, only fees.
 */
function directionalLeg(fair: number, bestBid: number | null, bestAsk: number | null): Leg[] {
  if (bestAsk !== null && fair - bestAsk >= MIN_EDGE) {
    return [["yes", Math.min(0.97, fair)]];
  }
  if (bestBid !== null && bestBid - fair >= MIN_EDGE) {
    // Buying NO at its own price, which is the complement of the YES bid.
    return [["no", Math.min(0.97, 1 - fair)]];
  }
  // With no book to disagree with, back the side fair itself favours, but only
  // when the read is decisive rather than a coin toss.
  if (bestBid === null && bestAsk === null) {
    if (fair >= 0.5 + MIN_EDGE) return [["yes", Math.min(0.97, fair)]];
    if (fair <= 0.5 - MIN_EDGE) return [["no", Math.min(0.97, 1 - fair)]];
  }
  return [];
}

async function cycle(): Promise<void> {
  const bots = runningBots();
  if (bots.length === 0) return;

  const [markets, books] = await Promise.all([
    Promise.all(LANES.map((lane) => liveMarkets(lane, 20))).then((rows) => rows.flat()),
    liveBooks().catch(() => []),
  ]);
  if (markets.length === 0) return;

  const bookByMarket = new Map(books.map((b) => [b.marketId, b]));
  const now = Math.floor(Date.now() / 1000);

  for (const [key, expiry] of quoted) if (expiry < now) quoted.delete(key);

  for (const bot of bots) {
    const key = openBotKey(bot.id);
    if (!key) continue;

    for (const market of markets) {
      if (!wants(bot, market)) continue;

      const mark = `${bot.id}:${market.marketId}`;
      if (quoted.has(mark)) continue;
      if (bot.dailyTrades > 0 && bot.tradesToday >= bot.dailyTrades) break;

      const book = bookByMarket.get(market.marketId);
      const bestBid = book?.bids[0]?.price ?? null;
      const bestAsk = book?.asks[0]?.price ?? null;
      const fair = await fairValue(bot, market, bookMid(book?.bids ?? [], book?.asks ?? []));
      if (fair === null) continue;

      const legs = bot.kind === "standard"
        ? makerLegs(fair, bot.spread, bestBid, bestAsk)
        : directionalLeg(fair, bestBid, bestAsk);
      if (legs.length === 0) continue;

      // Edge says the book is wrong; this says the side is likely. A bot can
      // be handed a genuine mispricing on a coin toss and still want no part
      // of it, so the floor is checked on the leg actually being bought.
      if (bot.kind !== "standard") {
        const chance = legs[0][0] === "yes" ? fair : 1 - fair;
        if (chance < bot.minProbability) continue;
      }

      // Claim the slot before awaiting, so a slow cycle cannot double quote.
      quoted.set(mark, market.expiry);

      for (const [side, price] of legs) {
        // Checked per ORDER, not per market. A market places two, so testing
        // once outside this loop let the cap overshoot by one every time.
        if (bot.dailyTrades > 0 && bot.tradesToday >= bot.dailyTrades) break;

        const result = await placeQuote(key, {
          pool: market.poolAddress as `0x${string}`,
          collateral: market.collateral as `0x${string}`,
          side,
          price,
          stake: bot.stake,
          expiry: market.expiry,
          // A market maker rests and never takes. A directional bot is buying
          // something it thinks is cheap, so it is allowed to cross for it.
          taking: bot.kind !== "standard",
        });

        if ("error" in result) {
          // PostOnlyWouldCross means the quote would have taken, so it was
          // refused. That is the guard doing its job, not a failure.
          if (!/PostOnly|WouldCross/i.test(result.error)) {
            log(`${bot.name} ${market.asset} ${side}: ${result.error}`);
          }
          continue;
        }

        recordBotFill(bot.id, market.marketId);
        bot.tradesToday += 1;
        // Attribution by strategy, which the chain cannot give: several bots
        // may share one key and look like a single trader. A maker is recorded
        // too, so its trade count is right; only its win RATE is meaningless,
        // and that is handled where the table is built.
        recordBotTrade(bot.id, bot.kind, market.marketId, side === "yes" ? 0 : 1);
        log(`${bot.name} ${market.asset} ${market.intervalSec}s ${side} ${result.shares.toFixed(2)}@${Math.round(result.price * 100)}c`);
      }
    }
  }
}

export function startRunner(): void {
  if (process.env.RUNNER_ENABLED !== "true") {
    console.log("runner disabled, set RUNNER_ENABLED=true to let bots trade");
    return;
  }

  const tick = () => {
    cycle().catch((err) => log(`cycle failed: ${(err as Error).message}`));
  };
  void tick();
  setInterval(tick, CYCLE_MS);
  console.log(`runner active, cycling every ${CYCLE_MS / 1000}s`);
}
