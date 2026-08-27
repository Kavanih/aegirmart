import { useEffect, useMemo, useState } from "react";
import { cents, countdown, fetchMarkets, fetchPredictions, money, spotAge, title, windowLabel, type Deck, type Market, type PredictionRecord, type PricePoint } from "./api";
import { ProbabilityRing } from "./ProbabilityRing";
import { Sparkline } from "./Sparkline";
import { AssetMark } from "./AssetMark";
import { Settled } from "./Settled";
import { fetchBooks, type MarketBook } from "./api";
import { Hero } from "./Hero";

const LANES = [60, 300];

type Props = {
  onSwipe: (intervalSec: number, marketId?: string) => void;
  onOpen: (marketId: string) => void;
};

type Row = { market: Market; series: PricePoint[]; spot: number | null };

export function MarketGrid({ onSwipe, onOpen }: Props) {
  const [decks, setDecks] = useState<Record<number, Deck>>({});
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [filter, setFilter] = useState<"all" | "BTC" | "ETH">("all");
  const [reads, setReads] = useState<Record<string, PredictionRecord>>({});
  const [books, setBooks] = useState<Record<string, MarketBook>>({});

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.all(
        LANES.map(async (lane) => [lane, await fetchMarkets(lane).catch(() => null)] as const),
      );
      if (!alive) return;
      const next: Record<number, Deck> = {};
      for (const [lane, deck] of results) if (deck) next[lane] = deck;
      setDecks(next);
    };
    load();
    const poll = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const lane of LANES) {
      const deck = decks[lane];
      if (!deck) continue;
      for (const market of deck.markets) {
        if (market.expiry <= now) continue;
        if (filter !== "all" && market.asset !== filter) continue;
        out.push({ market, series: deck.series?.[market.asset] ?? [], spot: deck.spot?.[market.asset] ?? null });
      }
    }
    return out.sort((a, b) => a.market.expiry - b.market.expiry);
  }, [decks, now, filter]);

  // The resting book, so a card quotes the price you would actually pay. Read
  // from the same source the contract page uses, or the two disagree about the
  // same market.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchBooks()
        .then((all) => alive && setBooks(Object.fromEntries(all.map((b) => [b.marketId, b]))))
        .catch(() => undefined);
    load();
    const poll = window.setInterval(load, 8_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  useEffect(() => {
    const ids = rows.map((r) => r.market.marketId);
    if (ids.length === 0) return;
    let alive = true;
    // Stored reads only, so refreshing the grid never spends model budget.
    fetchPredictions(ids).then((list) => {
      if (!alive) return;
      setReads(Object.fromEntries(list.map((r) => [r.marketId, r])));
    });
    return () => {
      alive = false;
    };
  }, [rows.map((r) => r.market.marketId).join(",")]);

  const openInterest = rows.reduce((sum, r) => sum + r.market.tradeCount, 0);

  return (
    <div className="grid-page">
      <Hero liveCount={rows.length} tradeCount={openInterest} onSwipe={onSwipe} />

      <div className="grid-head">
        <h3>Live markets</h3>
        <div className="filters">
          {(["all", "BTC", "ETH"] as const).map((f) => (
            <button key={f} className={f === filter ? "filter on" : "filter"} onClick={() => setFilter(f)} aria-pressed={f === filter}>
              {f === "all" ? "All" : f}
            </button>
          ))}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="grid-empty">Waiting for the next window to mint.</div>
      ) : (
        <div className="market-grid">
          {rows.map(({ market, series, spot }) => {
            const drift = spot === null ? null : spot - market.strike;
            const read = reads[market.marketId];
            // What UP costs to buy right now, not what it last traded at. The
            // last print can be minutes old with nothing resting behind it.
            const askUp = books[market.marketId]?.asks[0]?.price ?? null;
            const age = spotAge(series, now);
            // Only meaningful against a real book: an edge against no price is not an edge.
            const edge = read && askUp !== null ? read.probability - askUp : null;
            return (
              <article key={market.marketId} className="market-card">
                <header>
                  <AssetMark asset={market.asset} />
                  <button
                    className="market-title as-link"
                    onClick={() => onOpen(market.marketId)}
                    title={`Open ${title(market)}`}
                  >
                    <h4>{title(market)}</h4>
                    <span className="market-sub">{windowLabel(market.intervalSec)}</span>
                  </button>
                  <ProbabilityRing
                    probability={read ? read.probability : null}
                    confidence={read?.confidence}
                    caption="Model"
                    pending={!read}
                  />
                </header>

                <Sparkline points={series} target={market.strike} height={40} />

                <div className="market-levels">
                  <span title={age === null ? undefined : `Underlying priced ${Math.round(age)}s ago`}>
                    Target ${money(market.strike)}
                  </span>
                  {drift !== null && Math.abs(drift) >= 0.01 && (
                    <span className={drift >= 0 ? "over" : "under"}>
                      {drift >= 0 ? "↑" : "↓"} ${money(Math.abs(drift))}
                    </span>
                  )}
                </div>

                <div className="market-read">
                  <span className="read-cell">
                    <span className="read-key">Market</span>
                    <span className="read-val">
                      {askUp === null ? <em className="read-idle">nothing offered</em> : cents(askUp)}
                    </span>
                  </span>
                  <span className="read-cell">
                    <span className="read-key">Edge</span>
                    <span className={edge === null ? "read-val" : edge >= 0 ? "read-val over" : "read-val under"}>
                      {edge === null ? (
                        <em className="read-idle">{read ? "needs a market" : "no read yet"}</em>
                      ) : (
                        `${edge >= 0 ? "+" : ""}${Math.round(edge * 100)}c`
                      )}
                    </span>
                  </span>
                  {read && <span className={`conf ${read.confidence}`}>{read.confidence}</span>}
                </div>

                <div className="market-actions">
                  {/* Open this contract in the deck. Committing still happens
                      there, so browsing the grid cannot place an order. */}
                  <button
                    className="mini up"
                    onClick={() => onSwipe(market.intervalSec, market.marketId)}
                    title={`Open ${title(market)} to take the up side`}
                  >
                    Up
                  </button>
                  <button
                    className="mini down"
                    onClick={() => onSwipe(market.intervalSec, market.marketId)}
                    title={`Open ${title(market)} to take the down side`}
                  >
                    Down
                  </button>
                </div>

                <footer>
                  <span className="market-clock">{countdown(market.expiry, now)}</span>
                  <span className="market-vol">{market.tradeCount === 0 ? "No trades" : `${market.tradeCount} trades`}</span>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      <Settled now={now} onOpen={onOpen} />
    </div>
  );
}
