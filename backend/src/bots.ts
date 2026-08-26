import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { seal, normalizeKey, keyStorageReady, type SealedKey } from "./keys.js";

/**
 * Bot definitions and plan state.
 *
 * These are CONFIGURATIONS, not running processes. Executing a strategy needs
 * the account's private key, and this server has no business holding one, so a
 * bot here describes what to run and the operator runs it. Wiring execution is
 * a deliberate decision about custody, not something to slip in.
 */
const BOTS = new URL("../bots.json", import.meta.url).pathname;
const PLANS = new URL("../plans.json", import.meta.url).pathname;

export const MAX_BOTS = 5;
export const PRO_PRICE = 20;
export const ASSETS = ["BTC", "ETH", "BOTH"] as const;
export const KINDS = ["standard", "ai"] as const;

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
  /** Half spread around fair value, as a probability. */
  spread: number;
  /** Only meaningful for an ai bot: which model prices it. */
  model: string | null;
  status: "running" | "paused";
  createdAt: number;
  updatedAt: number;
  /** Never serialised to a client. See publicBot(). */
  key?: SealedKey;
};

/** A bot as the client may see it: the sealed key is replaced by its address. */
export type PublicBot = Omit<Bot, "key"> & { keyAddress: string | null };

export function publicBot(bot: Bot): PublicBot {
  const { key, ...rest } = bot;
  return { ...rest, keyAddress: key?.address ?? null };
}

export type Plan = { address: string; plan: "free" | "pro"; since: number; expires: number | null };

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
let plans: Record<string, Plan> = load<Plan>(PLANS);

function persist(): void {
  try {
    writeFileSync(BOTS, JSON.stringify(bots));
    writeFileSync(PLANS, JSON.stringify(plans));
  } catch {
    // A lost write costs a definition, never the request in flight.
  }
}

export function planFor(addressRaw: string): Plan {
  const address = addressRaw.toLowerCase();
  const existing = plans[address];
  // An expired subscription silently reverts rather than staying pro forever.
  if (existing && existing.plan === "pro" && existing.expires !== null && existing.expires < Date.now()) {
    plans[address] = { address, plan: "free", since: Date.now(), expires: null };
    persist();
  }
  return plans[address] ?? { address, plan: "free", since: 0, expires: null };
}

export function botsFor(addressRaw: string): PublicBot[] {
  const address = addressRaw.toLowerCase();
  return Object.values(bots)
    .filter((b) => b.address === address)
    .sort((a, b) => a.createdAt - b.createdAt)
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

export type BotDraft = Partial<Pick<Bot, "name" | "kind" | "asset" | "stake" | "dailyTrades" | "spread" | "model" | "status">>;

function clean(draft: BotDraft, plan: Plan, current?: Bot): { bot: Omit<Bot, "id" | "address" | "createdAt" | "updatedAt"> } | { error: string } {
  const kind = draft.kind ?? current?.kind ?? "standard";
  if (!KINDS.includes(kind)) return { error: "kind must be standard or ai" };
  if (kind === "ai" && plan.plan !== "pro") return { error: `An AI bot needs the pro plan (${PRO_PRICE} tUSDC a month)` };

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

  const spread = Number(draft.spread ?? current?.spread ?? 0.02);
  if (!Number.isFinite(spread) || spread <= 0 || spread >= 0.5) return { error: "spread must be between 0 and 0.5" };

  const status = draft.status ?? current?.status ?? "paused";
  if (status !== "running" && status !== "paused") return { error: "status must be running or paused" };

  // A standard bot has no model to name; storing one would imply it uses it.
  const model = kind === "ai" ? (draft.model ?? current?.model ?? null) : null;

  return { bot: { name, kind, asset, stake, dailyTrades, spread, model, status } };
}

export function createBot(addressRaw: string, draft: BotDraft): { bot: PublicBot } | { error: string } {
  const address = addressRaw.toLowerCase();
  if (botsFor(address).length >= MAX_BOTS) return { error: `A wallet can hold ${MAX_BOTS} bots for now` };

  const checked = clean(draft, planFor(address));
  if ("error" in checked) return checked;

  const now = Date.now();
  const bot: Bot = { id: randomUUID(), address, createdAt: now, updatedAt: now, ...checked.bot };
  bots[bot.id] = bot;
  persist();
  return { bot: publicBot(bot) };
}

export function updateBot(addressRaw: string, id: string, draft: BotDraft): { bot: PublicBot } | { error: string } {
  const address = addressRaw.toLowerCase();
  const current = bots[id];
  if (!current || current.address !== address) return { error: "bot not found" };

  const checked = clean(draft, planFor(address), current);
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
