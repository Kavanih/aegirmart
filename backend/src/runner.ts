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
/**
 * How far from a coin flip a read has to be before it counts as a view.
 *
 * A model answering 0.50 is saying it does not know. Treated as a fair value
 * it manufactures enormous edge against any cheap price, and the bot then bets
 * the maximum on the model's own ignorance. Measured over the first sessions:
 * seven of thirteen settled trades came from a read within 5c of a coin flip,
 * and every one of them lost.
 */
const MIN_VIEW = Number(process.env.MIN_VIEW ?? 0.05);
/**
 * Headroom over the resting offer, so the order actually crosses.
 *
 * A limit set exactly at the ask misses whenever the book ticks between the
 * decision and the write.
 */
const SLIPPAGE = Number(process.env.SLIPPAGE ?? 0.02);
/**
 * Most a directional bot will ever pay for a share.
 *
 * Not a value test: the bot buys the called side at the market. This only stops
 * it paying so close to 1.00 that a correct call still cannot cover a wrong
 * one, which no hit rate can survive.
 */
const MAX_PRICE = Number(process.env.MAX_PRICE ?? 0.9);
/** Fraction of a window after which its read no longer describes the price. */
const MAX_READ_AGE = Number(process.env.MAX_READ_AGE ?? 0.34);
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
    if (!read) return null;

    // A read is a snapshot of the price when it was taken. Spot moves, so past
    // a fraction of the window it describes a market that no longer exists,
    // and the gap it opens against the book reads as edge when it is staleness.
    const age = Math.floor(Date.now() / 1000) - read.predictedAt;
    if (age > market.intervalSec * MAX_READ_AGE) return null;

    return read.probability;
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
 * The side the read called, bought at the market.
 *
 * Whether the price is a bargain plays no part. The only questions are whether
 * the read made a call at all, and which way.
 */
function directionalLeg(fair: number, bestBid: number | null, bestAsk: number | null): Leg[] {
  // No view, no bet. Without this the bot reads its own uncertainty as edge.
  if (Math.abs(fair - 0.5) < MIN_VIEW) return [];

  // Back the call, at whatever the market is asking.
  //
  // No discount is required. Requiring one meant the bot only traded where it
  // disagreed with the book, and disagreement turned out to be the losing half
  // of the signal: fading the call won one trade in six while the calls
  // themselves were right 74% of the time. Direction is the whole signal here,
  // so the price is something to pay rather than something to wait for.
  if (fair > 0.5) {
    const price = bestAsk !== null ? bestAsk + SLIPPAGE : fair;
    return [["yes", Math.min(MAX_PRICE, price)]];
  }
  // Buying NO costs the complement of the YES bid. With no book on either
  // side there is no offer to cross, so the read's own number is the price.
  const downPrice = bestBid !== null ? 1 - bestBid + SLIPPAGE : 1 - fair;
  return [["no", Math.min(MAX_PRICE, downPrice)]];
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

        // recordBotFill already counts the trade and persists it. Counting it
        // again here billed every order twice against the daily allowance, and
        // unevenly: the second increment landed after the write, so a restart
        // dropped it and the total sat somewhere between real and double.
        recordBotFill(bot.id, market.marketId);
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
