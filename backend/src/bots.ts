import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { seal, open as openSealed, normalizeKey, keyStorageReady, type SealedKey } from "./keys.js";
import { subscriptionFor, tierSpec, type Subscription } from "./plans.js";

/**
 * Bot definitions and plan state.
 *
 * These are CONFIGURATIONS, not running processes. Executing a strategy needs
 * the account's private key, and this server has no business holding one, so a
 * bot here describes what to run and the operator runs it. Wiring execution is
 * a deliberate decision about custody, not something to slip in.
 */
const BOTS = new URL("../bots.json", import.meta.url).pathname;

export const MAX_BOTS = 5;
export const PRO_PRICE = 20;
export const ASSETS = ["BTC", "ETH", "BOTH"] as const;
export const KINDS = ["standard", "quant", "ai"] as const;
/** A model read takes tens of seconds, which a sixty second window cannot wait for. */
export const AI_MIN_INTERVAL = 300;
/**
 * Shortest window a quant bot can price.
 *
 * Spot comes from the sixty second lane's at-the-money mints, one price a
 * minute. A sixty second window is exactly one tick of that tape long, so spot
 * cannot move inside it: the estimate is 0.500 for the whole window, or worse,
 * it catches the NEXT mint and prices against a number that already decided the
 * contract. Neither is a view.
 */
export const QUANT_MIN_INTERVAL = 300;

export type BotKind = (typeof KINDS)[number];

export type Bot = {
  id: string;
  address: string;
  name: string;
  kind: BotKind;
  asset: (typeof ASSETS)[number];
  /** Collateral committed per quote, in tUSDC. */
  stake: number;
  /** Ceiling on orders per UTC day. Zero means no cap. */
  dailyTrades: number;
  /** Half spread around fair value, as a probability. Market maker only. */
  spread: number;
  /**
   * Floor on the chance of winning before a directional bot will act.
   *
   * Separate from edge: edge asks whether the book is WRONG, this asks whether
   * the side is LIKELY. A cheap coin toss can carry plenty of edge and still
   * lose half the time.
   */
  minProbability: number;
  /** Only meaningful for an ai bot: which model prices it. */
  model: string | null;
  status: "running" | "paused";
  createdAt: number;
  updatedAt: number;
  /** Never serialised to a client. See publicBot(). */
  key?: SealedKey;
  /** Orders placed today, against the daily cap. Rolls on the UTC date. */
  tradesToday: number;
  tradeDay: string;
  /**
   * Model reads this bot may spend in a day. AI bots only, and the real budget
   * for one: it cannot trade a window it has not read.
   */
  dailyReads: number;
  readsToday: number;
  /** Markets this bot has quoted, so the owner's profile can exclude them. */
  markets?: string[];
};

/** A bot as the client may see it: the sealed key is replaced by its address. */
export type PublicBot = Omit<Bot, "key"> & { keyAddress: string | null };

export function publicBot(bot: Bot): PublicBot {
  const { key, ...rest } = bot;
  return { ...rest, keyAddress: key?.address ?? null };
}

export type Plan = Subscription;

function load<T>(path: string): Record<string, T> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

let bots: Record<string, Bot> = load<Bot>(BOTS);

// Bots written before the win chance floor existed have no value for it.
// Left undefined, every comparison against it is NaN and quietly false, so the
// floor would read as set on the card and do nothing in the runner.
for (const bot of Object.values(bots)) {
  if (typeof bot.minProbability !== "number") bot.minProbability = 0;
  if (typeof bot.dailyReads !== "number") bot.dailyReads = bot.kind === "ai" ? 10 : 0;
  if (typeof bot.readsToday !== "number") bot.readsToday = 0;
}

function persist(): void {
  try {
    // Only the bots file. This module also used to write plans.json from a
    // copy it loaded at startup and never updated, so every bot edit rolled
    // subscriptions back to whatever they were when the process booted - a
    // paid upgrade was destroyed by the next unrelated bot save. plans.ts owns
    // that file; subscriptionFor is the way to read it.
    writeFileSync(BOTS, JSON.stringify(bots));
  } catch {
    // A lost write costs a definition, never the request in flight.
  }
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Every bot holding a key, running or not.
 *
 * Collecting winnings is not trading. Pausing a bot stops it taking new
 * positions; it must not strand the collateral from positions it already won.
 */
export function keyedBots(): Bot[] {
  return Object.values(bots).filter((b) => b.key);
}

/** Bots that are switched on AND hold a key, so the runner can act for them. */
export function runningBots(): Bot[] {
  const day = utcDay();
  return Object.values(bots)
    .filter((b) => b.status === "running" && b.key)
    .map((b) => {
      // Roll the day over ON the stored bot, not on a copy of it. Handing the
      // runner a copy gave it a second, throwaway allowance: the cap it tested
      // and the count it read both belonged to an object nothing persisted.
      if (b.tradeDay !== day) {
        b.tradesToday = 0;
        b.readsToday = 0;
        b.tradeDay = day;
      }
      return b;
    });
}

/**
 * The plaintext key for one bot. Only the runner calls this, and it holds the
 * result no longer than a cycle.
 */
export function openBotKey(id: string): string | null {
  const bot = bots[id];
  return bot?.key ? openSealed(bot.key) : null;
}

/**
 * Charge one model read to a bot, if it has the allowance for it.
 *
 * The operator now controls model spend by switching bots on and off, so the
 * allowance has to be checked where the read is about to happen rather than
 * paced centrally.
 */
export function claimBotRead(id: string): boolean {
  const bot = bots[id];
  if (!bot) return false;
  const day = utcDay();
  if (bot.tradeDay !== day) {
    bot.tradesToday = 0;
    bot.readsToday = 0;
    bot.tradeDay = day;
  }
  if (bot.dailyReads > 0 && bot.readsToday >= bot.dailyReads) return false;
  bot.readsToday += 1;
  persist();
  return true;
}

/** Hand a read back when the provider gave nothing for it. */
export function refundBotRead(id: string): void {
  const bot = bots[id];
  if (!bot || bot.readsToday <= 0) return;
  bot.readsToday -= 1;
  persist();
}

export function recordBotFill(id: string, marketId?: string): void {
  const bot = bots[id];
  if (!bot) return;
  const day = utcDay();
  bot.tradesToday = bot.tradeDay === day ? bot.tradesToday + 1 : 1;
  bot.tradeDay = day;

  // Stop at the cap rather than idling against it. A bot showing "running" at
  // 40/40 is doing nothing but burning cycles, and reads as active when it is
  // finished for the day. The counter resets at midnight UTC; the switch does
  // not, so tomorrow is a deliberate restart.
  if (bot.dailyTrades > 0 && bot.tradesToday >= bot.dailyTrades && bot.status === "running") {
    bot.status = "paused";
  }

  // Remembered so the owner's profile can drop what the bot did, which is the
  // only separation available when a bot signs with the owner's own wallet.
  if (marketId) {
    bot.markets = [...new Set([...(bot.markets ?? []), marketId])].slice(-400);
  }
  persist();
}

/**
 * Markets quoted by this owner's bots that sign AS this owner. A bot with its
 * own key needs no filtering: its positions were never in the profile.
 */
export function botMarketsFor(addressRaw: string): Set<string> {
  const address = addressRaw.toLowerCase();
  const out = new Set<string>();
  for (const bot of Object.values(bots)) {
    if (bot.address !== address) continue;
    if (bot.key?.address !== address) continue;
    for (const m of bot.markets ?? []) out.add(m);
  }
  return out;
}

export function planFor(addressRaw: string): Plan {
  return subscriptionFor(addressRaw);
}

export function botsFor(addressRaw: string): PublicBot[] {
  const address = addressRaw.toLowerCase();
  const day = utcDay();
  return Object.values(bots)
    .filter((b) => b.address === address)
    .sort((a, b) => a.createdAt - b.createdAt)
    // Only the runner rolled the day over, so a bot that spent its allowance
    // and was then paused showed yesterday's tally until it ran again. Report
    // what is actually available now.
    .map((b) => (b.tradeDay === day ? b : { ...b, tradesToday: 0, readsToday: 0, tradeDay: day }))
    .map(publicBot);
}

/**
 * Store a signing key against one bot. The plaintext is sealed immediately and
 * never retained, so a caller cannot hold it by accident.
 */
export function setBotKey(addressRaw: string, id: string, rawKey: string): { bot: PublicBot } | { error: string } {
  const address = addressRaw.toLowerCase();
  const current = bots[id];
  if (!current || current.address !== address) return { error: "bot not found" };
  if (!keyStorageReady()) {
    return { error: "Key storage is not configured on this server (KEY_ENCRYPTION_SECRET)" };
  }

  const normalized = normalizeKey(rawKey);
  if (!normalized) return { error: "A private key is 64 hex characters" };

  const sealed = seal(normalized);
  if (!sealed) return { error: "That key could not be read" };

  bots[id] = { ...current, key: sealed, updatedAt: Date.now() };
  persist();
  return { bot: publicBot(bots[id]) };
}

export function clearBotKey(addressRaw: string, id: string): boolean {
  const address = addressRaw.toLowerCase();
  const current = bots[id];
  if (!current || current.address !== address) return false;
  const { key, ...rest } = current;
  bots[id] = { ...rest, updatedAt: Date.now() };
  persist();
  return true;
}

export type BotDraft = Partial<
  Pick<
    Bot,
    "name" | "kind" | "asset" | "stake" | "dailyTrades" | "dailyReads" | "spread" | "minProbability" | "model" | "status"
  >
>;

type BotFields = Pick<
  Bot,
  "name" | "kind" | "asset" | "stake" | "dailyTrades" | "dailyReads" | "spread" | "minProbability" | "model" | "status"
>;

function clean(draft: BotDraft, plan: Plan, address: string, current?: Bot): { bot: BotFields } | { error: string } {
  const kind = draft.kind ?? current?.kind ?? "standard";
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
  const spec = tierSpec(plan.plan);
  if (kind !== "standard" && !spec.strategyBots) {
    return { error: `${kind === "ai" ? "An AI" : "A quant"} bot needs the Starter plan or better` };
  }

  const asset = draft.asset ?? current?.asset ?? "BOTH";
  if (!ASSETS.includes(asset)) return { error: "asset must be BTC, ETH or BOTH" };

  const name = (draft.name ?? current?.name ?? "").trim();
  if (name.length === 0 || name.length > 40) return { error: "name must be 1 to 40 characters" };

  const stake = Number(draft.stake ?? current?.stake ?? 5);
  if (!Number.isFinite(stake) || stake <= 0 || stake > 10_000) return { error: "stake must be between 0 and 10,000" };

  const dailyTrades = Math.floor(Number(draft.dailyTrades ?? current?.dailyTrades ?? 50));
  if (!Number.isFinite(dailyTrades) || dailyTrades < 0 || dailyTrades > 10_000) {
    return { error: "daily trades must be between 0 and 10,000" };
  }
  // A tier's ceiling is enforced here, not just shown in the pricing table.
  if (spec.dailyTrades > 0 && (dailyTrades === 0 || dailyTrades > spec.dailyTrades)) {
    return { error: `The ${spec.name} plan allows ${spec.dailyTrades} trades a day` };
  }

  // Reads are what an AI bot actually spends. Anything else has no use for
  // them, so the field is fixed at zero rather than quietly carrying a value.
  const asked = draft.dailyReads !== undefined;
  const wantedReads = Number(draft.dailyReads ?? current?.dailyReads ?? spec.dailyReads);
  if (!Number.isFinite(wantedReads) || wantedReads < 0) return { error: "reads a day must be zero or more" };
  // Only refuse a value the caller is actually setting. A stored value over the
  // ceiling - left by an earlier plan or an earlier version of this check - is
  // clamped instead, because rejecting it made every later edit of the bot
  // fail on a field the caller had not touched.
  if (asked && kind === "ai" && spec.dailyReads > 0 && wantedReads > spec.dailyReads) {
    return { error: `The ${spec.name} plan allows ${spec.dailyReads} model reads a day` };
  }
  const ceiling = spec.dailyReads > 0 ? spec.dailyReads : wantedReads;
  const dailyReads = kind === "ai" ? Math.min(wantedReads, ceiling) : 0;

  const spread = Number(draft.spread ?? current?.spread ?? 0.02);
  if (!Number.isFinite(spread) || spread <= 0 || spread >= 0.5) return { error: "spread must be between 0 and 0.5" };

  // Defaults to off. A floor is variance control, not edge control: at 50 it
  // silently refuses about half the signals on an instrument that is close to
  // a coin flip, which reads as a broken bot rather than a careful one.
  const minProbability = Number(draft.minProbability ?? current?.minProbability ?? 0);
  if (!Number.isFinite(minProbability) || minProbability < 0 || minProbability >= 1) {
    return { error: "the minimum chance must be between 0 and 100" };
  }

  const status = draft.status ?? current?.status ?? "paused";
  if (status !== "running" && status !== "paused") return { error: "status must be running or paused" };

  // Saved and running are separate ceilings: a wallet may keep a shelf of
  // strategies and switch between them, but only run a few at once.
  if (status === "running" && current?.status !== "running") {
    const live = Object.values(bots).filter(
      (b) => b.address === address && b.status === "running" && b.id !== current?.id,
    ).length;
    if (live >= spec.maxRunning) {
      return { error: `The ${spec.name} plan runs ${spec.maxRunning} bot${spec.maxRunning === 1 ? "" : "s"} at once. Pause one first.` };
    }
  }

  // Only an AI bot names a model; storing one elsewhere would imply it is used.
  const model = kind === "ai" ? (draft.model ?? current?.model ?? null) : null;

  return { bot: { name, kind, asset, stake, dailyTrades, dailyReads, spread, minProbability, model, status } };
}

export function createBot(addressRaw: string, draft: BotDraft): { bot: PublicBot } | { error: string } {
  const address = addressRaw.toLowerCase();
  const plan = planFor(address);
  const spec = tierSpec(plan.plan);
  if (botsFor(address).length >= spec.maxBots) {
    return { error: `The ${spec.name} plan holds ${spec.maxBots} bots` };
  }

  const checked = clean(draft, plan, address);
  if ("error" in checked) return checked;

  const now = Date.now();
  const bot: Bot = {
    ...checked.bot,
    id: randomUUID(), address, createdAt: now, updatedAt: now,
    tradesToday: 0, tradeDay: utcDay(), readsToday: 0,
  };
  bots[bot.id] = bot;
  persist();
  return { bot: publicBot(bot) };
}

export function updateBot(addressRaw: string, id: string, draft: BotDraft): { bot: PublicBot } | { error: string } {
  const address = addressRaw.toLowerCase();
  const current = bots[id];
  if (!current || current.address !== address) return { error: "bot not found" };

  const checked = clean(draft, planFor(address), address, current);
  if ("error" in checked) return checked;

  const bot: Bot = { ...current, ...checked.bot, updatedAt: Date.now() };
  bots[id] = bot;
  persist();
  return { bot: publicBot(bot) };
}

export function deleteBot(addressRaw: string, id: string): boolean {
  const address = addressRaw.toLowerCase();
  const current = bots[id];
  if (!current || current.address !== address) return false;
  delete bots[id];
  persist();
  return true;
}
