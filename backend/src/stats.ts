import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { settledOutcomes } from "./markets.js";

/**
 * Two things this keeps that the indexer will not.
 *
 * Venue totals: every query here is capped, so a count taken from one page of
 * results shrinks as history grows. These counters only ever move up, seeded
 * from what has been seen and added to as new activity is observed.
 *
 * Strategy record: which KIND of bot placed a trade and whether that market
 * went its way. Attribution cannot come from the chain, because several bots
 * can share one signing key and look like one trader.
 */
const STORE = new URL("../stats.json", import.meta.url).pathname;

export type StrategyKind = "standard" | "quant" | "ai";

type BotTrade = {
  botId: string;
  kind: StrategyKind;
  marketId: string;
  /** The leg backed: 0 is up. A maker takes both, so it records neither. */
  side: 0 | 1;
  at: number;
  outcome: number | null;
};

type Store = {
  volume: number;
  trades: number;
  traders: string[];
  /**
   * Volume per trader, accumulated.
   *
   * The leaderboard measured this from the last thousand fills, so any trader
   * whose activity had aged out showed nothing - forty three of fifty rows read
   * as a blank column, which looks like missing data rather than a window.
   */
  tradedBy: Record<string, number>;
  /** Fill ids already counted, so a re-read cannot inflate the totals. */
  seen: string[];
  botTrades: BotTrade[];
};

const EMPTY: Store = { volume: 0, trades: 0, traders: [], tradedBy: {}, seen: [], botTrades: [] };

/** A store written before a field existed still has to load. */
function withDefaults(s: Store): Store {
  return { ...EMPTY, ...s, tradedBy: s.tradedBy ?? {} };
}

function load(): Store {
  if (!existsSync(STORE)) return { ...EMPTY };
  try {
    return withDefaults(JSON.parse(readFileSync(STORE, "utf8")) as Store);
  } catch {
    return { ...EMPTY };
  }
}

let store = load();

function persist(): void {
  try {
    // Bound the tails so the file cannot grow without limit.
    store.seen = store.seen.slice(-4000);
    store.botTrades = store.botTrades.slice(-2000);
    writeFileSync(STORE, JSON.stringify(store));
  } catch {
    // Counters are a running total; losing one write costs accuracy, not data.
  }
}

/**
 * Fold observed fills into the totals. Ignores anything already counted, so
 * calling it repeatedly over overlapping pages is safe.
 */
export function observeFills(fills: { id: string; size: number; accounts: string[] }[]): void {
  const seen = new Set(store.seen);
  const traders = new Set(store.traders);
  let added = 0;

  for (const fill of fills) {
    if (seen.has(fill.id)) continue;
    seen.add(fill.id);
    store.volume += fill.size;
    store.trades += 1;
    for (const a of fill.accounts) {
      if (!a) continue;
      const key = a.toLowerCase();
      traders.add(key);
      store.tradedBy[key] = (store.tradedBy[key] ?? 0) + fill.size;
    }
    added += 1;
  }

  if (added === 0) return;
  store.seen = [...seen];
  store.traders = [...traders];
  persist();
}

/**
 * Rebuild per-trader volume from a full fill history.
 *
 * observeFills skips anything already in `seen`, which is correct for totals
 * that must not double count - but it means a field added later can never be
 * filled in from fills already counted. Volume is derived data, so it is safe
 * to recompute outright, and this is the only way the column can cover traders
 * whose activity predates the field.
 */
export function seedVolume(fills: { size: number; accounts: string[] }[]): void {
  const rebuilt: Record<string, number> = {};
  for (const fill of fills) {
    for (const a of fill.accounts) {
      if (!a) continue;
      const key = a.toLowerCase();
      rebuilt[key] = (rebuilt[key] ?? 0) + fill.size;
    }
  }
  if (Object.keys(rebuilt).length <= Object.keys(store.tradedBy).length) return;
  store.tradedBy = rebuilt;
  persist();
}

/** Accumulated volume per trader, for the leaderboard. */
export function tradedVolume(): Record<string, number> {
  return store.tradedBy;
}

export function venueStats(): { volume: number; trades: number; traders: number } {
  return { volume: store.volume, trades: store.trades, traders: store.traders.length };
}

export function recordBotTrade(botId: string, kind: StrategyKind, marketId: string, side: 0 | 1): void {
  store.botTrades.push({ botId, kind, marketId, side, at: Date.now(), outcome: null });
  persist();
}

/** Fill in outcomes for bot trades whose market has since settled. */
export async function scoreBotTrades(): Promise<void> {
  const open = store.botTrades.filter((t) => t.outcome === null);
  if (open.length === 0) return;

  const ids = [...new Set(open.map((t) => t.marketId))].slice(0, 60);
  const outcomes = await settledOutcomes(ids);
  let changed = false;

  for (const trade of store.botTrades) {
    if (trade.outcome !== null) continue;
    const winning = outcomes.get(trade.marketId);
    if (winning === undefined) continue;
    trade.outcome = winning;
    changed = true;
  }
  if (changed) persist();
}

export type StrategyRow = {
  kind: StrategyKind;
  trades: number;
  settled: number;
  won: number;
  winRate: number | null;
};

/**
 * Win rate per strategy.
 *
 * A market maker deliberately holds both legs, so "was it right" does not
 * apply: it is reported with its trade count and no rate, rather than a
 * meaningless one.
 */
export function strategyTable(): StrategyRow[] {
  const kinds: StrategyKind[] = ["standard", "quant", "ai"];
  return kinds.map((kind) => {
    const rows = store.botTrades.filter((t) => t.kind === kind);
    const settled = rows.filter((t) => t.outcome !== null);
    const won = settled.filter((t) => t.side === t.outcome).length;
    return {
      kind,
      trades: rows.length,
      settled: settled.length,
      won,
      // A market maker holds both legs, so one always wins and the rate says
      // nothing. Null reads as "not scored"; zero read as "never right".
      winRate: kind === "standard" || settled.length === 0 ? null : won / settled.length,
    };
  });
}
