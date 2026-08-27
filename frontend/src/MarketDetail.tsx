import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import {
  countdown, fetchBooks, fetchMarketDetail, money, shortAddress, stamp, title, windowLabel, windowRange,
  type MarketBook, type MarketDetail as Detail,
} from "./api";
import { AssetMark } from "./AssetMark";
import { Sparkline } from "./Sparkline";
import { StakePanel } from "./StakePanel";
import { useTrade } from "./wallet/useTrade";
import { quoteFor } from "./wallet/trade";
import { TUSDC } from "./wallet/config";
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
  const [sidePicked, setSidePicked] = useState(false);
  const [stake, setStake] = useState(5);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [book, setBook] = useState<MarketBook | null>(null);

  const { address, isConnected } = useAccount();

  // The wallet's collateral, so an order that cannot be escrowed is stopped
  // here rather than reverting on chain.
  const { data: collateral } = useReadContract({
    abi: erc20Abi,
    address: TUSDC.address,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });

  // The resting book, for what a leg actually costs rather than what it last
  // traded at. Polled with the page.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchBooks()
        .then((all) => alive && setBook(all.find((b) => b.marketId === marketId) ?? null))
        .catch(() => undefined);
    load();
    const poll = window.setInterval(load, 8_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [marketId]);
  const { place } = useTrade();
  const toast = useToast();

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchMarketDetail(marketId, address).then((d) => {
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
  }, [marketId, address]);

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
  /**
   * What can actually be bought on a leg at or under a limit.
   *
   * Buying NO is selling YES, so the offers for DOWN are the YES bids read
   * upside down: a bid for YES at b is an offer of NO at 1 - b.
   */
  const fillableAt = (leg: "up" | "down", limit: number) => {
    const levels = leg === "up"
      ? (book?.asks ?? []).map((l) => ({ price: l.price, size: l.size }))
      : (book?.bids ?? []).map((l) => ({ price: 1 - l.price, size: l.size }));

    return levels
      .filter((l) => l.price <= limit + 1e-9)
      .reduce((acc, l) => ({ shares: acc.shares + l.size, cost: acc.cost + l.size * l.price }), { shares: 0, cost: 0 });
  };

  /** The cheapest offer on a leg, which is the lowest limit that fills anything. */
  const bestOfferOn = (leg: "up" | "down") => {
    const levels = leg === "up"
      ? (book?.asks ?? []).map((l) => l.price)
      : (book?.bids ?? []).map((l) => 1 - l.price);
    return levels.length ? Math.min(...levels) : null;
  };

  const bestBidUp = book?.bids[0]?.price ?? null;
  const bestAskUp = book?.asks[0]?.price ?? null;
  const depth = (book?.bids.length ?? 0) + (book?.asks.length ?? 0);
  // Size resting on each leg, which is what "can I actually get filled" means.
  const upDepth = (book?.asks ?? []).reduce((n, l) => n + l.size, 0);
  const downDepth = (book?.bids ?? []).reduce((n, l) => n + l.size, 0);
  const held = (leg: "up" | "down") => data.holdings.find((h) => h.outcomeIndex === (leg === "up" ? 0 : 1)) ?? null;

  // The order the ticket would place: the model's price where there is a read,
  // otherwise the book's own offer on that leg.
  // The model's price where there is a read, then the offer on that leg, then
  // the best bid as a last resort. A leg with nothing offered can still be bid
  // for, so leaving the ticket blank there told the operator nothing.
  const ticketPrice = side === "up"
    ? modelUp ?? bestAskUp ?? bestBidUp
    : modelUp !== null
      ? 1 - modelUp
      : bestBidUp !== null
        ? 1 - bestBidUp
        : bestAskUp !== null
          ? 1 - bestAskUp
          : null;
  // Read from the same helper the order uses, so the preview cannot promise a
  // size or an escrow the placement will not honour.
  const quote = ticketPrice && ticketPrice > 0 && stake > 0 ? quoteFor(stake, ticketPrice) : null;
  const shares = quote?.shares ?? null;
  // An order fills now only when something is already offered at or under it.
  const legAsk = bestOfferOn(side);
  const fillsNow = ticketPrice !== null && legAsk !== null && ticketPrice >= legAsk;

  // How much of this order the book can actually absorb at the chosen price.
  const fill = ticketPrice === null ? { shares: 0, cost: 0 } : fillableAt(side, ticketPrice);
  const wanted = shares ?? 0;
  const shortfall = Math.max(0, wanted - fill.shares);
  const balance = Number(formatUnits(collateral ?? 0n, TUSDC.decimals));
  const overBalance = quote !== null && quote.escrow > balance;

  // Refuse only what cannot work: no price, nothing to buy at it, or more
  // collateral than the wallet holds. A partial fill is a real outcome, so it
  // is warned about rather than blocked.
  const blocked =
    !live || stake <= 0 || ticketPrice === null || overBalance || fill.shares <= 0;

  const onBuy = () => {
    if (!isConnected) return toast.push("error", "Connect a wallet first");
    if (stake <= 0) return toast.push("error", "Enter an amount first");

    if (ticketPrice === null) return toast.push("error", "No price to work with on this side yet");

    const id = toast.push(
      "pending",
      `Placing ${side === "up" ? "UP" : "DOWN"} on ${title(market)} at ${Math.round(ticketPrice * 100)}c`,
    );
    // The same price the ticket just showed, so the order cannot differ from
    // what was agreed to on screen.
    void place(market, side, stake, modelUp, (phase, detail) => {
      if (phase === "approving") toast.update(id, "pending", "Approving tUSDC for this pool");
      else if (phase === "placing") toast.update(id, "pending", "Waiting for your signature");
      else if (phase === "sent") toast.update(id, "pending", "Sent. Waiting for confirmation", `${EXPLORER}/${detail}`);
      else if (phase === "error") toast.update(id, "error", detail);
      else if (phase === "done") {
        const [hash, shares, price, dir] = detail.split("|");
        toast.update(id, "success", `Resting ${shares} ${dir === "up" ? "UP" : "DOWN"} at ${price}c. It fills only if someone crosses it.`, `${EXPLORER}/${hash}`);
      }
    }, ticketPrice);
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

        <div className="detail-pills">
          <span className={live ? "detail-pill open" : "detail-pill"}>{live ? "Open" : "Closed"}</span>
          <span className="detail-pill">tUSDC</span>
          <span className="detail-pill">{market.tradeCount === 0 ? "No trades" : `${market.tradeCount} trades`}</span>
          <span className="detail-pill">
            {depth === 0 ? "No resting orders" : `${depth} resting`}
          </span>
        </div>

        <section className="detail-chart">
          <div className="chart-legend">
            <span><span className="key-line target" /> Target ${money(market.strike)}</span>
            <span><span className="key-line spot" /> {market.asset} {spot === null ? "--" : `$${money(spot)}`}</span>
          </div>
          {/* The underlying against the strike, because that is what decides
              this contract. The book is too thin to draw a price history from. */}
          {path.length >= 2 ? (
            <Sparkline points={path} target={market.strike} height={306} />
          ) : (
            <p className="read-idle">
              The price path for this window is no longer retained. Only the last hour of strikes is kept.
            </p>
          )}
        </section>

        <section className="outcomes">
          <h3>Outcomes</h3>
          <p className="section-hint">What each side costs to buy right now, and what it pays if it wins.</p>
          {(["up", "down"] as const).map((leg) => {
            const marketPrice = leg === "up" ? upMarket : downMarket;
            const model = modelUp === null ? null : leg === "up" ? modelUp : 1 - modelUp;
            // The last print is history. What a buyer pays is the best offer
            // resting on that leg right now.
            const ask = leg === "up" ? bestAskUp : bestBidUp === null ? null : 1 - bestBidUp;
            return (
              <div key={leg} className={`outcome-row ${leg}`}>
                <span className={`pos-side ${leg}`}>{leg.toUpperCase()}</span>

                <span className="outcome-lead">
                  {ask === null ? (
                    <em className="read-idle">nothing offered</em>
                  ) : (
                    <>
                      <span className="outcome-price">{Math.round(ask * 100)}c</span>
                      <span className="outcome-sub">pays {(1 / ask).toFixed(2)}x</span>
                    </>
                  )}
                </span>

                <span className="outcome-figure">
                  {model === null ? <em className="read-idle">no read</em> : `${Math.round(model * 100)}%`}
                  <span className="outcome-sub">model</span>
                </span>

                <span className="outcome-figure">
                  {(leg === "up" ? upDepth : downDepth).toFixed(2)}
                  <span className="outcome-sub">available</span>
                </span>

                <span className="outcome-figure">
                  {held(leg) ? held(leg)!.shares.toFixed(2) : "0.00"}
                  <span className="outcome-sub">you hold</span>
                </span>

                <button
                  className={`mini ${leg}`}
                  disabled={!live}
                  onClick={() => {
                    setSide(leg);
                    setSidePicked(true);
                  }}
                  title={live ? `Take the ${leg} side` : "This window has closed"}
                >
                  Buy {leg === "up" ? "Up" : "Down"}
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

        {data.myOrders.length > 0 && (
          <section className="detail-orders">
            <h3>Your orders here</h3>
            <p className="section-hint">
              A limit order rests until someone crosses it. Until then it holds your collateral and shows no position.
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Side</th>
                  <th className="num">Price</th>
                  <th className="num">Size</th>
                  <th className="num">Filled</th>
                  <th className="num">Escrow</th>
                  <th className="num">Status</th>
                  <th className="num">Placed</th>
                </tr>
              </thead>
              <tbody>
                {data.myOrders.map((o) => (
                  <tr key={o.orderId}>
                    <td>
                      <span className={`pos-side ${o.outcomeIndex === 0 ? "up" : "down"}`}>
                        {o.outcomeIndex === 0 ? "UP" : "DOWN"}
                      </span>
                    </td>
                    <td className="num">{Math.round(o.price * 100)}c</td>
                    <td className="num">{o.quantity.toFixed(2)}</td>
                    <td className={`num ${o.filled === 0 ? "muted-cell" : ""}`}>{o.filled.toFixed(2)}</td>
                    <td className="num muted-cell">{(o.remaining * o.price).toFixed(2)}</td>
                    <td className={`num order-status ${o.status.toLowerCase()}`}>{o.status}</td>
                    <td className="num muted-cell">{stamp(o.placedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="detail-prints">
          <h3>Trades</h3>
          <p className="section-hint">Every fill on this contract, newest last.</p>
          {trades.length === 0 ? (
            <p className="read-idle">Nothing has traded on this contract yet.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Side</th>
                  <th className="num">Price</th>
                  <th className="num">Size</th>
                  <th className="num">Value</th>
                  <th>Buyer</th>
                  <th>Seller</th>
                </tr>
              </thead>
              <tbody>
                {[...trades].reverse().map((t, i) => (
                  <tr key={`${t.t}-${i}`}>
                    <td className="muted-cell">{stamp(t.t)}</td>
                    <td>
                      <span className={`pos-side ${t.takerSide.includes("NO") ? "down" : "up"}`}>
                        {t.takerSide.replace("_", " ")}
                      </span>
                    </td>
                    <td className="num">{Math.round(t.price * 100)}c</td>
                    <td className="num">{t.size.toFixed(2)}</td>
                    <td className="num muted-cell">{(t.size * t.price).toFixed(2)}</td>
                    <td className="addr-cell">{t.buyer ? shortAddress(t.buyer) : "--"}</td>
                    <td className="addr-cell">{t.seller ? shortAddress(t.seller) : "--"}</td>
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

        <p className="ticket-label">Pick a side</p>
        <div className="ticket-sides">
          {(["up", "down"] as const).map((leg) => {
            const price = leg === "up" ? bestAskUp : bestBidUp === null ? null : 1 - bestBidUp;
            return (
              <button
                key={leg}
                className={side === leg ? `ticket-side ${leg} on` : `ticket-side ${leg}`}
                onClick={() => {
                  setSide(leg);
                  setSidePicked(true);
                }}
                aria-pressed={side === leg}
              >
                <span className="ticket-side-name">{leg === "up" ? "Up" : "Down"}</span>
                <span className="ticket-side-price">
                  {price === null ? "no offers" : `${Math.round(price * 100)}c`}
                </span>
              </button>
            );
          })}
        </div>

        <p className="ticket-label">Amount</p>
        <StakePanel stake={stake} onChange={setStake} percentOfBalance />

        <p className="ticket-label">Your order</p>
        {/* What the order actually does, before it is signed. */}
        <dl className="ticket-preview">
          <div>
            <dt>Price</dt>
            <dd>{quote === null ? "--" : `${Math.round(quote.price * 100)}c`}</dd>
          </div>
          <div>
            <dt>Shares</dt>
            <dd>{shares === null ? "--" : shares.toFixed(2)}</dd>
          </div>
          <div className="ticket-preview-wide">
            <dt>You commit</dt>
            <dd className="commit">
              {quote === null ? "--" : `${quote.escrow.toFixed(2)} tUSDC`}
              {quote !== null && Math.abs(quote.escrow - stake) >= 0.01 && (
                <span className="commit-note"> of the {stake.toFixed(2)} entered, after rounding to a whole lot</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Pays if right</dt>
            <dd className="pays">{shares === null ? "--" : shares.toFixed(2)}</dd>
          </div>
          <div>
            <dt>Available here</dt>
            <dd className={fill.shares <= 0 ? "warn" : ""}>
              {fill.shares <= 0 ? "none" : `${fill.shares.toFixed(2)} shares`}
            </dd>
          </div>
          <div className="ticket-preview-wide">
            <dt>Fills</dt>
            <dd className={fill.shares <= 0 ? "warn" : shortfall > 0.005 ? "" : "pays"}>
              {fill.shares <= 0
                ? legAsk === null
                  ? "Nothing is offered on this side"
                  : `Nothing at ${Math.round(ticketPrice! * 100)}c — the cheapest offer is ${Math.round(legAsk * 100)}c`
                : shortfall > 0.005
                  ? `${fill.shares.toFixed(2)} of ${wanted.toFixed(2)} shares now, the rest rests until someone sells`
                  : "All of it, immediately"}
            </dd>
          </div>
          <div>
            <dt>You hold</dt>
            <dd>{held(side) ? `${held(side)!.shares.toFixed(2)} already` : "nothing yet"}</dd>
          </div>
        </dl>

        <button className="ticket-cta" onClick={onBuy} disabled={blocked}>
          {!live
            ? "Window closed"
            : stake <= 0
              ? "Enter an amount"
              : overBalance
                ? "More than your balance"
                : fill.shares <= 0
                  ? "Nothing to buy at this price"
                  : `Buy ${side === "up" ? "Up" : "Down"}`}
        </button>

        {/* A blocked order usually has one obvious fix, so offer it. */}
        {live && stake > 0 && !overBalance && fill.shares <= 0 && legAsk !== null && (
          <button className="ticket-fix" onClick={() => setSidePicked(true)}>
            Cheapest offer is {Math.round(legAsk * 100)}c
          </button>
        )}
        {live && overBalance && (
          <button className="ticket-fix" onClick={() => setStake(Math.floor(balance * 100) / 100)}>
            Use your balance, {balance.toFixed(2)} tUSDC
          </button>
        )}
        {live && shortfall > 0.005 && fill.shares > 0 && (
          <button className="ticket-fix" onClick={() => setStake(Math.max(0.01, Math.floor(fill.cost * 100) / 100))}>
            Size it to what is available, {fill.cost.toFixed(2)} tUSDC
          </button>
        )}

        <p className="ticket-fine">
          Places a resting limit order at the model's price. It fills only if someone crosses it, and expires with the
          window if nobody does.
        </p>
      </aside>
    </div>
  );
}
