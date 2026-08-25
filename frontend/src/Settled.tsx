import { useEffect, useState } from "react";
import { ago, fetchSettled, money, windowLabel, type SettledMarket } from "./api";

type Props = { now: number };

/**
 * Resolved windows, newest first. Deliberately not interactive: these markets
 * are closed, so the tile carries an outcome rather than a pair of side buttons.
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

  if (rows !== null && rows.length === 0) return null;

  return (
    <section className="settled-section">
      <div className="grid-head">
        <h3>Recently settled</h3>
        <span className="settled-note">Closed windows. Results only, nothing to trade.</span>
      </div>

      {rows === null ? (
        <div className="settled-grid">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="settled-tile is-loading" aria-hidden="true" />
          ))}
        </div>
      ) : (
        <div className="settled-grid">
          {rows.map((row) => (
            <article key={row.marketId} className="settled-tile">
              <header>
                <span className={`token ${row.asset.toLowerCase()}`}>{row.asset}</span>
                <span className="settled-window">{windowLabel(row.intervalSec)}</span>
                <span className={row.wentUp ? "settled-out up" : "settled-out down"}>
                  {row.wentUp ? "UP" : "DOWN"}
                </span>
              </header>

              <p className="settled-target">Target ${money(row.strike)}</p>

              <footer>
                <span>{ago(row.expiry, now)}</span>
                {/* Shown only where the model actually read the window: a row
                    of identical "no read" labels is noise, not information. */}
                {row.modelCorrect !== null && (
                  <span className={row.modelCorrect ? "settled-model hit" : "settled-model miss"}>
                    {row.modelCorrect ? "Model called it" : "Model missed"}
                  </span>
                )}
              </footer>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
