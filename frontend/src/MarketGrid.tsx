import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { countdown, fetchLikes, fetchMarkets, money, title, toggleLike, windowLabel, type Deck, type Like, type Market, type PricePoint } from "./api";
import { ProbabilityRing } from "./ProbabilityRing";
import { Sparkline } from "./Sparkline";

const LANES = [60, 300];

type Props = { onSwipe: (intervalSec: number) => void };

type Row = { market: Market; series: PricePoint[]; spot: number | null };

export function MarketGrid({ onSwipe }: Props) {
  const [decks, setDecks] = useState<Record<number, Deck>>({});
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [filter, setFilter] = useState<"all" | "BTC" | "ETH">("all");
  const [likes, setLikes] = useState<Record<string, Like>>({});
  const { address } = useAccount();

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

  useEffect(() => {
    const ids = rows.map((r) => r.market.marketId);
    if (ids.length === 0) return;
    let alive = true;
    fetchLikes(ids, address ?? null).then((list) => {
      if (!alive) return;
      setLikes(Object.fromEntries(list.map((l) => [l.marketId, l])));
    });
    return () => {
      alive = false;
    };
  }, [rows.map((r) => r.market.marketId).join(","), address]);

  const onLike = async (marketId: string) => {
    if (!address) return;
    const next = await toggleLike(marketId, address).catch(() => null);
    if (next) setLikes((prev) => ({ ...prev, [marketId]: { marketId, ...next } }));
  };

  const openInterest = rows.reduce((sum, r) => sum + r.market.tradeCount, 0);

  return (
    <div className="grid-page">
      <section className="hero">
        <div className="hero-copy">
          <h2>Sixty second markets on BTC and ETH</h2>
          <p>
            Every window mints at the money and settles on the Somnia oracle. A model reads each contract against live
            volatility and its own settled history, then tells you where the market is mispriced.
          </p>
          <div className="hero-actions">
            <button className="cta" onClick={() => onSwipe(300)}>
              Start swiping
            </button>
            <span className="hero-note">Somnia testnet</span>
          </div>
        </div>
        <dl className="hero-stats">
          <div>
            <dt>Live contracts</dt>
            <dd>{rows.length}</dd>
          </div>
          <div>
            <dt>Fastest window</dt>
            <dd>60s</dd>
          </div>
          <div>
            <dt>Trades</dt>
            <dd>{openInterest}</dd>
          </div>
        </dl>
      </section>

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
            return (
              <article key={market.marketId} className="market-card">
                <header>
                  <span className={`token ${market.asset.toLowerCase()}`}>{market.asset}</span>
                  <div className="market-title">
                    <h4>{title(market)}</h4>
                    <span className="market-sub">{windowLabel(market.intervalSec)}</span>
                  </div>
                  <ProbabilityRing probability={market.lastPrice} />
                </header>

                <Sparkline points={series} target={market.strike} height={40} />

                <div className="market-levels">
                  <span>Target ${money(market.strike)}</span>
                  {drift !== null && (
                    <span className={drift >= 0 ? "over" : "under"}>
                      {drift >= 0 ? "↑" : "↓"} ${money(Math.abs(drift))}
                    </span>
                  )}
                </div>

                <div className="market-actions">
                  <button className="mini up" onClick={() => onSwipe(market.intervalSec)}>Up</button>
                  <button className="mini down" onClick={() => onSwipe(market.intervalSec)}>Down</button>
                </div>

                <footer>
                  <span className="market-clock">{countdown(market.expiry, now)}</span>
                  <button
                    className={likes[market.marketId]?.liked ? "like on" : "like"}
                    onClick={() => onLike(market.marketId)}
                    disabled={!address}
                    title={address ? "Like this market" : "Connect a wallet to like"}
                    aria-pressed={Boolean(likes[market.marketId]?.liked)}
                  >
                    {likes[market.marketId]?.liked ? "Liked" : "Like"} {likes[market.marketId]?.count ?? 0}
                  </button>
                  <span className="market-vol">{market.tradeCount} trades</span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
