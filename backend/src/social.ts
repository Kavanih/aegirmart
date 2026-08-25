import { readFileSync, writeFileSync, existsSync } from "node:fs";

const STORE = new URL("../likes.json", import.meta.url).pathname;

type LikeStore = Record<string, string[]>;

function load(): LikeStore {
  if (!existsSync(STORE)) return {};
  try {
    return JSON.parse(readFileSync(STORE, "utf8")) as LikeStore;
  } catch {
    return {};
  }
}

let cache: LikeStore = load();

function persist(): void {
  try {
    writeFileSync(STORE, JSON.stringify(cache));
  } catch {
    // A failed write costs a like, never a request.
  }
}

export function likesFor(marketIds: string[], address: string | null) {
  return marketIds.map((id) => {
    const likers = cache[id] ?? [];
    return { marketId: id, count: likers.length, liked: address ? likers.includes(address) : false };
  });
}

// Idempotent per address so a double tap cannot inflate the count.
export function toggleLike(marketId: string, address: string): { count: number; liked: boolean } {
  const likers = cache[marketId] ?? [];
  const at = likers.indexOf(address);

  if (at === -1) likers.push(address);
  else likers.splice(at, 1);

  cache[marketId] = likers;
  persist();
  return { count: likers.length, liked: at === -1 };
}
