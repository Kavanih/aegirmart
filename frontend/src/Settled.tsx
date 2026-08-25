import { useEffect, useMemo, useState } from "react";
import { ago, cents, fetchSettled, money, title, windowLabel, type PricePoint, type SettledMarket } from "./api";
import { Sparkline } from "./Sparkline";

type Props = { now: number };

/**
 * Price path per asset, reconstructed from the windows themselves: the venue
 * mints at the money, so each window's settle price is a spot sample. Gives a
 * settled card the same shape as a live one without a second data source.
 */
function seriesByAsset(rows: SettledMarket[]): Map<string, PricePoint[]> {
  const out = new Map<string, PricePoint[]>();
  for (const row of rows) {
    const price = row.settlePrice ?? row.strike;
    const points = out.get(row.asset) ?? [];
    points.push({ t: row.expiry, price });
    out.set(row.asset, points);
  }
  for (const points of out.values()) points.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Resolved windows, newest first. Deliberately not interactive: these markets
 * are closed, so the card carries a result where a live one carries controls.
 */
export function Settled({ now }: Props) {
  const [rows, setRows] = useState<SettledMarket[] | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchSettled(24).then((list) => {
        if (alive) setRows(list);
      });
    };
    load();
    const poll = window.setInterval(load, 20_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, []);

  const series = useMemo(() => seriesByAsset(rows ?? []), [rows]);

  if (rows !== null && rows.length === 0) return null;

  return (
    <section className="settled-section">
      <div className="grid-head">
        <h3>Recently settled</h3>
        <span className="settled-note">Closed windows. Results only, nothing to trade.</span>
      </div>

      {rows === null ? (
        <div className="market-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="market-card is-loading" aria-hidden="true" />
          ))}
        </div>
      ) : (
        <div className="market-grid">
          {rows.map((row) => {
            const drift = row.settlePrice === null ? null : row.settlePrice - row.strike;
            // Only the part of the path that had happened when this window closed.
            const points = (series.get(row.asset) ?? []).filter((p) => p.t <= row.expiry).slice(-14);

            return (
              <article key={row.marketId} className="market-card settled-card">
                <header>
                  <span className={`token ${row.asset.toLowerCase()}`}>{row.asset}</span>
                  <div className="market-title">
                    <h4>{title(row)}</h4>
                    <span className="market-sub">{windowLabel(row.intervalSec)} · {ago(row.expiry, now)}</span>
                  </div>
                  <span className={row.wentUp ? "settled-out up" : "settled-out down"}>
                    {row.wentUp ? "UP" : "DOWN"}
                  </span>
                </header>

                <Sparkline points={points} target={row.strike} height={40} />

                <div className="market-levels">
                  <span>Target ${money(row.strike)}</span>
                  {drift !== null && (
                    <span className={drift >= 0 ? "over" : "under"}>
                      {drift >= 0 ? "↑" : "↓"} ${money(Math.abs(drift))}
                    </span>
                  )}
                </div>

                <div className="market-read">
                  <span className="read-cell">
                    <span className="read-key">Settled</span>
                    <span className="read-val">
                      {row.settlePrice === null ? <em className="read-idle">unknown</em> : `$${money(row.settlePrice)}`}
                    </span>
                  </span>
                  <span className="read-cell">
                    <span className="read-key">Close</span>
                    <span className="read-val">
                      {row.lastPrice === null ? <em className="read-idle">no book</em> : cents(row.lastPrice)}
                    </span>
                  </span>
                </div>

                {/* Where a live card puts Up and Down. A closed window offers a
                    verdict instead, so the two can never be confused. */}
                <div className={row.wentUp ? "settled-bar up" : "settled-bar down"}>
                  {row.wentUp ? "Closed above target" : "Closed below target"}
                </div>

                <footer>
                  <span className="market-clock">Settled</span>
                  {row.modelCorrect === null ? (
                    <span className="settled-model idle">No read</span>
                  ) : (
                    <span className={row.modelCorrect ? "settled-model hit" : "settled-model miss"}>
                      {row.modelCorrect ? "Model called it" : "Model missed"}
                    </span>
                  )}
                  <span className="market-vol">{row.tradeCount === 0 ? "No trades" : `${row.tradeCount} trades`}</span>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
