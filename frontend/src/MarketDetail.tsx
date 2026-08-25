import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import {
  cents, countdown, fetchMarketDetail, money, stamp, title, windowLabel, windowRange,
  type MarketDetail as Detail,
} from "./api";
import { AssetMark } from "./AssetMark";
import { Sparkline } from "./Sparkline";
import { StakePanel } from "./StakePanel";
import { useTrade } from "./wallet/useTrade";
import { useToast } from "./Toast";
import { EmptyState } from "./Table";

const EXPLORER = "https://shannon-explorer.somnia.network/tx";

type Props = { marketId: string; onBack: () => void };

/** Market price for a leg, from the last print. Null when nothing has traded. */
function legPrice(yesPrice: number | null, side: "up" | "down"): number | null {
  if (yesPrice === null) return null;
  return side === "up" ? yesPrice : 1 - yesPrice;
}

export function MarketDetail({ marketId, onBack }: Props) {
  const [data, setData] = useState<Detail | null>(null);
  const [missing, setMissing] = useState(false);
  const [side, setSide] = useState<"up" | "down">("up");
  const [stake, setStake] = useState(5);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const { isConnected } = useAccount();
  const { place } = useTrade();
  const toast = useToast();

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchMarketDetail(marketId).then((d) => {
        if (!alive) return;
        if (d) setData(d);
        else setMissing(true);
      });
    load();
    const poll = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [marketId]);

  // Only the path up to this window's close belongs on this contract's chart.
  // Drawing today's price against a strike set hours ago says nothing true.
  const path = useMemo(() => {
    const points = data?.series ?? [];
    const expiry = data?.market.expiry ?? 0;
    return points.filter((p) => p.t <= expiry).slice(-48);
  }, [data]);

  const spot = path.length ? path[path.length - 1].price : null;

  if (missing) return <EmptyState title="Contract not found" hint="It may belong to a retired venue." />;
  if (!data) return <div className="detail-loading" aria-busy="true">Loading contract…</div>;

  const { market, read, trades } = data;
  const live = market.expiry > now && !market.finalized;
  const upMarket = legPrice(market.lastPrice, "up");
  const downMarket = legPrice(market.lastPrice, "down");
  const modelUp = read ? read.probability : null;

  const onBuy = () => {
    if (!isConnected) return toast.push("error", "Connect a wallet first");
    if (stake <= 0) return toast.push("error", "Enter an amount first");

    const id = toast.push("pending", `Placing ${side === "up" ? "UP" : "DOWN"} on ${title(market)}`);
    void place(market, side, stake, modelUp, (phase, detail) => {
      if (phase === "approving") toast.update(id, "pending", "Approving tUSDC for this pool");
      else if (phase === "placing") toast.update(id, "pending", "Waiting for your signature");
      else if (phase === "sent") toast.update(id, "pending", "Sent. Waiting for confirmation", `${EXPLORER}/${detail}`);
      else if (phase === "error") toast.update(id, "error", detail);
      else if (phase === "done") {
        const [hash, shares, price, dir] = detail.split("|");
        toast.update(id, "success", `Resting ${shares} ${dir === "up" ? "UP" : "DOWN"} at ${price}c. It fills only if someone crosses it.`, `${EXPLORER}/${hash}`);
      }
    });
  };

  return (
    <div className="detail">
      <div className="detail-main">
        <header className="detail-head">
          <button className="back" onClick={onBack} aria-label="Back to markets">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 5l-7 7 7 7" />
            </svg>
            Markets
          </button>

          <div className="detail-title">
            <AssetMark asset={market.asset} size={40} />
            <div>
              <h2>{title(market)}</h2>
              <p>
                {windowLabel(market.intervalSec)} · {windowRange(market)} · settles on the Somnia oracle
              </p>
            </div>
          </div>

          <span className={live ? "detail-clock live" : "detail-clock"}>
            {market.finalized
              ? market.wentUp === null ? "Settled" : `Settled ${market.wentUp ? "UP" : "DOWN"}`
              : live ? countdown(market.expiry, now) : "Closed"}
          </span>
        </header>

        <section className="detail-chart">
          <div className="chart-legend">
            <span><span className="key-line target" /> Target ${money(market.strike)}</span>
            <span><span className="key-line spot" /> {market.asset} {spot === null ? "--" : `$${money(spot)}`}</span>
          </div>
          {/* The underlying against the strike, because that is what decides
              this contract. The book is too thin to draw a price history from. */}
          {path.length >= 2 ? (
            <Sparkline points={path} target={market.strike} height={190} />
          ) : (
            <p className="read-idle">
              The price path for this window is no longer retained. Only the last hour of strikes is kept.
            </p>
          )}
        </section>

        <section className="outcomes">
          <h3>Outcomes</h3>
          {(["up", "down"] as const).map((leg) => {
            const marketPrice = leg === "up" ? upMarket : downMarket;
            const model = modelUp === null ? null : leg === "up" ? modelUp : 1 - modelUp;
            return (
              <div key={leg} className={`outcome-row ${leg}`}>
                <span className={`pos-side ${leg}`}>{leg.toUpperCase()}</span>
                <span className="outcome-figure">
                  {model === null ? <em className="read-idle">no model read</em> : `${Math.round(model * 100)}%`}
                  <span className="outcome-sub">model</span>
                </span>
                <span className="outcome-figure">
                  {marketPrice === null ? <em className="read-idle">no book</em> : cents(marketPrice)}
                  <span className="outcome-sub">market</span>
                </span>
                <button
                  className={`mini ${leg}`}
                  disabled={!live}
                  onClick={() => setSide(leg)}
                  title={live ? `Take the ${leg} side` : "This window has closed"}
                >
                  Take {leg === "up" ? "Up" : "Down"}
                </button>
              </div>
            );
          })}
        </section>

        {read && (
          <section className="detail-read">
            <h3>Model read</h3>
            <p className="read-body">{read.reasoning}</p>
            <p className="read-meta">
              <span className={`conf ${read.confidence}`}>{read.confidence}</span>
              <span>{read.model.replace(/:free$/, "").split("/").pop()}</span>
              {read.correct !== null && (
                <span className={read.correct ? "settled-model hit" : "settled-model miss"}>
                  {read.correct ? "Called it" : "Missed"}
                </span>
              )}
            </p>
          </section>
        )}

        <section className="detail-prints">
          <h3>Prints</h3>
          {trades.length === 0 ? (
            <p className="read-idle">Nothing has traded on this contract yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th className="num">YES price</th>
                  <th className="num">Size</th>
                  <th className="num">Taker</th>
                </tr>
              </thead>
              <tbody>
                {[...trades].reverse().map((t, i) => (
                  <tr key={`${t.t}-${i}`}>
                    <td className="muted-cell">{stamp(t.t)}</td>
                    <td className="num">{cents(t.price)}</td>
                    <td className="num">{t.size.toFixed(2)}</td>
                    <td className="num muted-cell">{t.takerSide.replace("_", " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <aside className="ticket" aria-label="Trade ticket">
        <div className="ticket-head">
          <AssetMark asset={market.asset} size={26} />
          <span>{title(market)}</span>
        </div>

        <div className="ticket-sides">
          {(["up", "down"] as const).map((leg) => {
            const price = leg === "up" ? upMarket : downMarket;
            return (
              <button
                key={leg}
                className={side === leg ? `ticket-side ${leg} on` : `ticket-side ${leg}`}
                onClick={() => setSide(leg)}
                aria-pressed={side === leg}
              >
                {leg === "up" ? "Up" : "Down"} {price === null ? "--" : cents(price)}
              </button>
            );
          })}
        </div>

        <StakePanel stake={stake} onChange={setStake} />

        <button className="ticket-cta" onClick={onBuy} disabled={!live || stake <= 0}>
          {!live ? "Window closed" : `Buy ${side === "up" ? "Up" : "Down"}`}
        </button>

        <p className="ticket-fine">
          Places a resting limit order at the model's price. It fills only if someone crosses it, and expires with the
          window if nobody does.
        </p>
      </aside>
    </div>
  );
}
