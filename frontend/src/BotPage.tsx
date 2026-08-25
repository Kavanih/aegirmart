import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { cents, countdown, fetchBooks, money, windowLabel, type MarketBook } from "./api";
import { AssetMark } from "./AssetMark";
import { TableScroll, EmptyState } from "./Table";

/** Best bid, best ask and the gap, or nulls where that side is empty. */
function top(book: MarketBook) {
  const bid = book.bids[0]?.price ?? null;
  const ask = book.asks[0]?.price ?? null;
  return { bid, ask, spread: bid !== null && ask !== null ? ask - bid : null };
}

export function BotPage() {
  const [books, setBooks] = useState<MarketBook[] | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { address } = useAccount();
  const mine = address?.toLowerCase() ?? null;

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () => fetchBooks().then((b) => alive && setBooks(b));
    load();
    const poll = window.setInterval(load, 5_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  const stats = useMemo(() => {
    const rows = books ?? [];
    const twoSided = rows.filter((b) => b.bids.length > 0 && b.asks.length > 0);
    const spreads = twoSided.map((b) => top(b).spread!).filter((n) => Number.isFinite(n));
    // "Mine" is only meaningful once a wallet is connected; the bot quotes from
    // the same account, so its resting orders are the ones owned by it.
    const ours = mine
      ? rows.reduce((n, b) => n + [...b.bids, ...b.asks].filter((l) => l.owner === mine).length, 0)
      : null;

    return {
      live: rows.length,
      twoSided: twoSided.length,
      ours,
      avgSpread: spreads.length ? spreads.reduce((a, b) => a + b, 0) / spreads.length : null,
    };
  }, [books, mine]);

  const quoting = stats.twoSided > 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Maker bot</h2>
          <p>
            Resting quotes on the live book. Cards read <code>--</code> until something is quoting, so this is where to
            check before recording anything.
          </p>
        </div>
        <span className={quoting ? "bot-pill on" : "bot-pill"}>
          <span className="bot-dot" aria-hidden="true" />
          {books === null ? "Checking" : quoting ? "Book is quoted" : "Book is empty"}
        </span>
      </div>

      <div className="stat-grid">
        <StatCard label="Live markets" value={books === null ? "--" : String(stats.live)} />
        <StatCard
          label="Two sided"
          value={books === null ? "--" : `${stats.twoSided}/${stats.live}`}
          tone={books === null ? undefined : stats.twoSided === stats.live && stats.live > 0 ? "good" : "bad"}
        />
        <StatCard
          label="Average spread"
          value={stats.avgSpread === null ? "--" : `${Math.round(stats.avgSpread * 100)}c`}
        />
        <StatCard label="Your resting orders" value={stats.ours === null ? "connect" : String(stats.ours)} />
      </div>

      <h3 className="section-head">Book by contract</h3>

      {books === null ? (
        <p className="read-idle">Reading the book…</p>
      ) : books.length === 0 ? (
        <EmptyState
          title="Nothing is quoting"
          hint="No live contract has a resting order. Start ec-maker and this fills within a cycle or two."
        />
      ) : (
        <TableScroll label="Live books">
          <table className="table">
            <thead>
              <tr>
                <th>Contract</th>
                <th className="num">Target</th>
                <th className="num">Bid</th>
                <th className="num">Ask</th>
                <th className="num">Spread</th>
                <th className="num">Depth</th>
                <th className="num">Yours</th>
                <th className="num">Closes</th>
              </tr>
            </thead>
            <tbody>
              {books.map((b) => {
                const { bid, ask, spread } = top(b);
                const ours = mine ? [...b.bids, ...b.asks].filter((l) => l.owner === mine).length : null;
                return (
                  <tr key={b.marketId}>
                    <td>
                      <span className="asset-cell">
                        <AssetMark asset={b.asset} size={18} />
                        {b.asset} <span className="market-sub">{windowLabel(b.intervalSec)}</span>
                      </span>
                    </td>
                    <td className="num">${money(b.strike)}</td>
                    <td className="num">{bid === null ? <em className="read-idle">--</em> : cents(bid)}</td>
                    <td className="num">{ask === null ? <em className="read-idle">--</em> : cents(ask)}</td>
                    <td className={`num ${spread === null ? "muted-cell" : ""}`}>
                      {spread === null ? "--" : `${Math.round(spread * 100)}c`}
                    </td>
                    <td className="num muted-cell">{b.bids.length}/{b.asks.length}</td>
                    <td className="num">{ours === null ? "--" : ours}</td>
                    <td className="num muted-cell">{countdown(b.expiry, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      <p className="footnote">
        Depth counts resting orders per side, not size. A contract with a bid and no ask is half quoted: it can be sold
        into but not bought from, so its card still shows a price while being untradeable in one direction.
      </p>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className="stat-card">
      <span className="stat-label">{label}</span>
      <span className={`stat-value ${tone ?? ""}`}>{value}</span>
    </div>
  );
}
