import { liveMarkets, liveBooks, type Market } from "./markets.js";
import { runningBots, openBotKey, recordBotFill, type Bot } from "./bots.js";
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
  return bot.asset === "BOTH" || bot.asset === market.asset;
}

/**
 * What the bot thinks YES is worth. A standard bot follows the book; an AI bot
 * follows its stored read and declines to quote without one.
 */
function fairValue(bot: Bot, market: Market, mid: number | null): number | null {
  if (bot.kind === "ai") {
    const read = cachedPrediction(market.marketId);
    return read ? read.probability : null;
  }
  return mid ?? market.lastPrice ?? 0.5;
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
      const fair = fairValue(bot, market, bookMid(book?.bids ?? [], book?.asks ?? []));
      if (fair === null) continue;

      // Keep both legs off the extremes: a bid at 0 or 1 is not a quote.
      let bid = Math.min(0.97, Math.max(0.02, fair - bot.spread));
      let offer = Math.min(0.97, Math.max(0.02, fair + bot.spread));

      // Stay inside the resting book. A post only order that would cross is
      // refused on chain, so pricing through the touch just burns gas and
      // fills the log with reverts. Back off by a tick instead.
      const bestBid = book?.bids[0]?.price ?? null;
      const bestAsk = book?.asks[0]?.price ?? null;
      if (bestAsk !== null) bid = Math.min(bid, bestAsk - TICK);
      if (bestBid !== null) offer = Math.max(offer, bestBid + TICK);

      // Backing off can invert the quote when the book is tighter than the
      // bot's spread. There is nothing to add there, so sit the market out.
      if (bid <= 0.02 || offer >= 0.98 || bid >= offer) continue;

      // Claim the slot before awaiting, so a slow cycle cannot double quote.
      quoted.set(mark, market.expiry);

      for (const [side, price] of [["yes", bid], ["no", 1 - offer]] as const) {
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
