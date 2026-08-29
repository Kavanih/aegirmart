import { liveMarkets, liveBooks, type Market } from "./markets.js";
import {
  runningBots, keyedBots, openBotKey, recordBotFill, AI_MIN_INTERVAL, QUANT_MIN_INTERVAL, type Bot,
} from "./bots.js";
import { buildEvidence } from "./quant.js";
import { recordBotTrade } from "./stats.js";
import { recordDecision } from "./decisions.js";
import { positionsFor, ordersFor } from "./markets.js";
import { cachedPrediction } from "./tracker.js";
import { placeQuote, redeemWin, collateralBalance } from "./chain.js";

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
 * Hard ceiling on what any directional order will pay, under everything else.
 */
/**
 * Dearest a directional bot will pay, whatever its model believes.
 *
 * This is the same 75c ceiling the quant carries, moved to where it covers both
 * strategies. It was fitted inside the quant's calibration, so an AI bot - whose
 * fair value comes straight from a model read and is never calibrated - could
 * still pay up to 97c on a confident read. That is the band the record is
 * clearest about: 75-100c went four of seven and lost 72.67, because a price
 * that high means the book has already decided and the payoff no longer covers
 * being wrong.
 */
const MAX_PRICE = Number(process.env.MAX_PRICE ?? 0.75);
/**
 * How far below its worth a leg must be before it is worth buying.
 *
 * Accuracy is what pays, not volume, and accuracy fell as price rose: 71% in
 * the 45-60c band, 50% above it. Raising the ceiling for volume therefore needs
 * a second filter that selects for conviction rather than price, or it simply
 * re-enters the band that lost.
 *
 * A marginal edge is mostly noise in the estimate. Requiring a clear gap keeps
 * the trades that the model is actually sure about, which is where a 70-80% hit
 * rate has to come from.
 */
const MIN_EDGE = Number(process.env.MIN_EDGE ?? 0.08);

/**
 * Cheapest offer a directional bot will take.
 *
 * Losing is symmetric around a confident book, not one-sided. Over 32 settled
 * trades, grouped by the price paid:
 *
 *    0-30c   0 of 3 won   -58.37
 *   30-45c   0 of 1 won   -11.95
 *   45-60c   5 of 7 won  +104.57
 *   60-75c   7 of 14 won -128.40
 *  75-100c   4 of 7 won   -72.67
 *
 * Read the other way: trades where the market sat within 15c of a coin flip
 * made +53, and everything further out lost. A price far from 50c means the
 * book has an opinion, and disagreeing with an opinionated book is where this
 * bot's money goes - in BOTH directions. A 12c offer is the market saying it
 * will not happen, and it has been right.
 *
 * With the ceiling above, this brackets trading to the band where the market
 * is genuinely unsure. Fitted on 32 trades, so it is a working rule, not a law.
 */
const MIN_PRICE = Number(process.env.MIN_PRICE ?? 0.4);

/**
 * The stretch of a window a directional bot may enter.
 *
 * Too early and spot still sits on the strike, so there is nothing to see. Too
 * late and the book has already worked out the answer, and a bot arriving then
 * is buying a decided contract. Over 34 settled trades:
 *
 *   entered under 90s in   17 trades, 59% won,  -68.26
 *   entered 90-180s in     10 trades, 60% won,  +89.04
 *   entered after 180s      7 trades, 29% won, -145.70
 *
 * The middle of the window is the only stretch that has paid, which is the same
 * window the tracker was already told to read in for the same reason.
 */
const ENTER_FROM = Number(process.env.ENTER_FROM ?? 0.3);
const ENTER_UNTIL = Number(process.env.ENTER_UNTIL ?? 0.62);

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
  // The quant's spot tape ticks once a minute, so a sixty second window is one
  // tick long and nothing can move inside it.
  if (bot.kind === "quant" && market.intervalSec < QUANT_MIN_INTERVAL) return false;
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

/**
 * A leg to buy: side, limit price, and the price to size the stake against.
 *
 * The limit and the sizing price differ because a taking order fills at the
 * resting offer, not at its own limit. Sizing on the limit spent less than the
 * operator asked for; sizing on the offer spends what they asked.
 */
type Leg = readonly ["yes" | "no", number, number];

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
  return [["yes", bid, bid], ["no", 1 - offer, 1 - offer]];
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

  // Back the call, paying up to what the model says the leg is worth.
  //
  // No discount is required: a price equal to fair value is taken. But a price
  // ABOVE it cannot be, because the break-even price for a call IS its
  // probability. Paying 90c for a leg the model gives 68% risks 90 to win 10 on
  // something that fails a third of the time, which loses 22c a share on
  // average however often the call is right.
  const [leg, worth, offer] = fair > 0.5
    ? (["yes", fair, bestAsk] as const)
    // Buying NO costs the complement of the YES bid and is worth 1 - fair.
    : (["no", 1 - fair, bestBid === null ? null : 1 - bestBid] as const);

  // With no book there is nothing to cross, so the read's own number stands.
  // No resting offer, no trade.
  //
  // There is nothing to cross, so the order rests and usually expires unfilled.
  // Worse, the only price available to bid is the read's own value, and paying
  // exactly what you believe something is worth earns nothing by construction:
  // it profits only if the model is BETTER than its stated confidence. At 94c
  // that needs a 95% hit rate against a measured 65-74%, which loses about
  // 1,300 per hundred bets.
  if (offer === null) return [];
  if (offer > worth) return [];
  // Not merely cheap - clearly cheap. See MIN_EDGE.
  if (worth - offer < MIN_EDGE) return [];
  // Too cheap means the book is confident it will not happen, which is the same
  // disagreement as too dear, pointing the other way.
  if (offer < MIN_PRICE) return [];
  return [[leg, Math.min(MAX_PRICE, worth, offer + SLIPPAGE), offer]];
}

/**
 * Turn a bot's settled wins back into collateral.
 *
 * A won position is outcome tokens, not money. Left alone the wallet balance
 * never rises, so a bot can win steadily and still run out of the collateral it
 * needs to keep trading. Redeemed once per cycle, one position at a time, so a
 * slow chain cannot stall the quoting loop.
 */
async function sweepWins(bot: Bot, key: string): Promise<void> {
  let rows;
  try {
    rows = await positionsFor(bot.key!.address, 200);
  } catch {
    return;
  }

  const won = rows.find(
    (p) => p.finalized && p.winningOutcome === p.outcomeIndex && p.size > 0 && p.poolAddress && p.outcomeId,
  );
  if (!won) return;

  const result = await redeemWin(key, won.poolAddress as `0x${string}`, BigInt(won.outcomeId), won.size);
  if ("error" in result) {
    log(`${bot.name} redeem ${won.asset}: ${result.error}`);
    return;
  }
  log(`${bot.name} redeemed ${won.size.toFixed(2)} ${won.asset} shares`);
}

/** Bots already reported as out of collateral, so it is said once, not every cycle. */
const broke = new Set<string>();

async function cycle(): Promise<void> {
  // Winnings first, for every bot that holds a key. A paused bot places no
  // orders but its settled wins are still its money, and they only become
  // spendable collateral once redeemed.
  for (const bot of keyedBots()) {
    const key = openBotKey(bot.id);
    if (key) await sweepWins(bot, key);
  }

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

    // Markets this bot already has an order in, read from the venue rather than
    // from memory. The in-memory guard died with every restart, and this
    // session restarted often: the same window was entered three times in four
    // minutes, tripling a loss that should have been taken once.
    const held = await ordersFor(bot.key!.address, 100)
      .then((rows) => new Set(rows.map((o) => o.marketId)))
      .catch(() => new Set<string>());


    // A bot with less collateral than its stake cannot place anything. Check
    // once per cycle rather than sending transactions that must revert, and
    // say so, because a bot that has quietly run dry looks identical to one
    // that simply has no view.
    const collateral = markets[0]?.collateral;
    if (collateral && bot.key) {
      const balance = await collateralBalance(
        bot.key.address as `0x${string}`,
        collateral as `0x${string}`,
      ).catch(() => Infinity);
      if (balance < bot.stake) {
        if (!broke.has(bot.id)) {
          broke.add(bot.id);
          log(`${bot.name} is out of collateral: ${balance.toFixed(2)} left, stake is ${bot.stake}`);
        }
        continue;
      }
      broke.delete(bot.id);
    }

    for (const market of markets) {
      if (!wants(bot, market)) continue;

      const mark = `${bot.id}:${market.marketId}`;
      if (quoted.has(mark) || held.has(market.marketId)) continue;
      // Claimed here, before any await. Claiming after pricing left a window
      // wide enough for a second pass to slip through.
      quoted.set(mark, market.expiry);
      let placed = false;

      try {
      // Only the middle of a window. A directional bot has nothing to see at
      // the open and nothing left to win at the close.
      if (bot.kind !== "standard") {
        const elapsed = (market.intervalSec - (market.expiry - now)) / market.intervalSec;
        if (elapsed < ENTER_FROM || elapsed > ENTER_UNTIL) continue;
      }
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

      for (const [side, price, sizeAt] of legs) {
        // Checked per ORDER, not per market. A market places two, so testing
        // once outside this loop let the cap overshoot by one every time.
        if (bot.dailyTrades > 0 && bot.tradesToday >= bot.dailyTrades) break;

        const result = await placeQuote(key, {
          pool: market.poolAddress as `0x${string}`,
          collateral: market.collateral as `0x${string}`,
          side,
          price,
          sizeAt,
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
        // Written next to the fill so the two can be joined later.
        recordDecision({
          botId: bot.id,
          marketId: market.marketId,
          asset: market.asset,
          intervalSec: market.intervalSec,
          side,
          worth: fair > 0.5 ? fair : 1 - fair,
          offer: sizeAt,
          edge: (fair > 0.5 ? fair : 1 - fair) - sizeAt,
          elapsed: (market.intervalSec - (market.expiry - now)) / market.intervalSec,
          placedAt: Math.floor(Date.now() / 1000),
        });
        recordBotFill(bot.id, market.marketId);
        // Attribution by strategy, which the chain cannot give: several bots
        // may share one key and look like a single trader. A maker is recorded
        // too, so its trade count is right; only its win RATE is meaningless,
        // and that is handled where the table is built.
        recordBotTrade(bot.id, bot.kind, market.marketId, side === "yes" ? 0 : 1);
        placed = true;
        log(`${bot.name} ${market.asset} ${market.intervalSec}s ${side} ${result.shares.toFixed(2)}@${Math.round(result.price * 100)}c`);
      }
      } finally {
        // Sitting out this pass must not lock the window for the rest of its
        // life: the price that was wrong at 35% is often right at 50%. The
        // claim is only kept once an order actually exists.
        if (!placed) quoted.delete(mark);
      }
    }
  }
}

export function startRunner(): void {
  if (process.env.RUNNER_ENABLED !== "true") {
    console.log("runner disabled, set RUNNER_ENABLED=true to let bots trade");
    return;
  }

  // A cycle prices markets and waits on receipts, so it can outlast its own
  // interval. Left to overlap, two cycles both read a market as unclaimed
  // before either claimed it, and the bot entered the same window twice three
  // seconds apart. A tick that arrives while one is still running is skipped.
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    cycle()
      .catch((err) => log(`cycle failed: ${(err as Error).message}`))
      .finally(() => { running = false; });
  };
  void tick();
  setInterval(tick, CYCLE_MS);
  console.log(`runner active, cycling every ${CYCLE_MS / 1000}s`);
}
