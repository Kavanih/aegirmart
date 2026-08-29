import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STORE = new URL("../decisions.json", import.meta.url).pathname;
const MAX = 2000;

/**
 * Why a bot took a trade, recorded at the moment it did.
 *
 * Every tuning decision in this project has been made by grouping settled
 * trades after the fact, and the inputs had to be guessed from the order rows:
 * the price paid is on chain, but what the model believed and how big the gap
 * was are not. Guessing them is how a ceiling ends up fitted to the wrong
 * variable. This records the actual inputs so accuracy can be cut by
 * conviction, not by price standing in for it.
 */
export type Decision = {
  botId: string;
  marketId: string;
  asset: string;
  intervalSec: number;
  side: "yes" | "no";
  /** The model's probability for the leg being bought. */
  worth: number;
  /** What the book was asking for it. */
  offer: number;
  /** worth - offer, the reason the trade was taken. */
  edge: number;
  /** Fraction of the window elapsed at entry. */
  elapsed: number;
  placedAt: number;
};

let records: Decision[] = load();

function load(): Decision[] {
  if (!existsSync(STORE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(STORE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordDecision(d: Decision): void {
  records.unshift(d);
  if (records.length > MAX) records = records.slice(0, MAX);
  try {
    writeFileSync(STORE, JSON.stringify(records));
  } catch {
    // Losing a note must never cost the trade it describes.
  }
}

export function allDecisions(): Decision[] {
  return records;
}
