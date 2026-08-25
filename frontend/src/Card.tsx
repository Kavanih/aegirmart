import { useState } from "react";
import { cents, countdown, money, title, windowLabel, windowRange, type Market, type PredictionState, type PricePoint } from "./api";
import { Sparkline } from "./Sparkline";
import { PayoutRow } from "./PayoutRow";
import { bidPrice } from "./wallet/trade";
import type { SwipeState } from "./useSwipe";

type Props = {
  market: Market;
  prediction: PredictionState;
  series: PricePoint[];
  spot: number | null;
  swipe?: SwipeState;
  now: number;
  depth: number;
  stake: number;
};

function marketProbability(state: PredictionState, market: Market): number | null {
  if (state.status === "ok" && state.evidence.marketProbability !== null) {
    return state.evidence.marketProbability;
  }
  return market.lastPrice;
}

export function Card({ market, prediction, series, spot, swipe, now, depth, stake }: Props) {
  const [expanded, setExpanded] = useState(false);

  const isTop = depth === 0;
  const dx = swipe?.dx ?? 0;
  const dy = swipe?.dy ?? 0;
  const progress = swipe?.progress ?? 0;
  const intent = swipe?.intent ?? null;

  const confidence = prediction.status === "ok" ? prediction.prediction.confidence : "unrated";
  const market_p = marketProbability(prediction, market);
  const model_p = prediction.status === "ok" ? prediction.prediction.probability : null;
  const edge = market_p !== null && model_p !== null ? model_p - market_p : null;

  const drift = spot === null ? null : spot - market.strike;

  const style = {
    transform: `translate3d(${dx}px, ${dy + depth * 10}px, 0) rotate(${swipe?.rotation ?? 0}deg) scale(${
      isTop ? 1 : 1 - depth * 0.04 + (swipe?.leaving ? 0.04 : 0)
    })`,
    zIndex: 10 - depth,
  } as React.CSSProperties;

  return (
    <article className={`card conf-${confidence} ${swipe?.dragging ? "dragging" : ""}`} style={style} aria-hidden={!isTop}>
      <div className="edge-flag left" style={{ opacity: intent === "down" ? progress : 0 }}>DOWN</div>
      <div className="edge-flag right" style={{ opacity: intent === "up" ? progress : 0 }}>UP</div>
      <div className="edge-flag top" style={{ opacity: intent === "skip" ? progress : 0 }}>SKIP</div>

      <header className="card-head">
        <div className="head-left">
          <h2 className="question">{title(market)}</h2>
          <span className="window">{windowLabel(market.intervalSec)} &middot; {windowRange(market)}</span>
        </div>
        <span className="clock" aria-label={`closes in ${countdown(market.expiry, now)}`}>
          {countdown(market.expiry, now)}
        </span>
      </header>

      <div className="levels">
        <div className="level">
          <span className="level-key">Target</span>
          <span className="level-val target">${money(market.strike)}</span>
        </div>
        <div className="level">
          <span className="level-key">Current</span>
          {spot === null ? (
            <span className="level-val">--</span>
          ) : (
            <span className={`level-val ${drift! >= 0 ? "over" : "under"}`}>
              ${money(spot)} <span className="arrow">{drift! >= 0 ? "↑" : "↓"}</span>
            </span>
          )}
        </div>
      </div>

      <Sparkline points={series} target={market.strike} />

      {prediction.status === "loading" ? (
        <div className="skeleton-block" aria-live="polite" aria-label="Loading model estimate">
          <div className="skeleton bar" />
          <div className="skeleton line short" />
        </div>
      ) : (
        <div className="readout">
          <div className="prices">
            <div className="price up">
              <span className="price-side">Up</span>
              <span className="price-val">{market_p === null ? "--" : cents(market_p)}</span>
            </div>
            <div className="price down">
              <span className="price-side">Down</span>
              <span className="price-val">{market_p === null ? "--" : cents(1 - market_p)}</span>
            </div>
          </div>

          <div className={`split ${market_p === null ? "untraded" : ""}`} role="img"
            aria-label={`Market prices the up side at ${market_p === null ? "no trades yet" : `${Math.round(market_p * 100)} cents`}`}>
            {market_p !== null && <div className="split-fill" style={{ width: `${market_p * 100}%` }} />}
            {model_p !== null && <div className="split-marker" style={{ left: `${model_p * 100}%` }} title="model estimate" />}
          </div>

          <div className="model-row">
            {model_p === null ? (
              <span className="unavailable">Model read unavailable</span>
            ) : (
              <>
                <span className="model-read">Model {cents(model_p)}</span>
                <span className={`chip chip-${confidence}`}>{confidence}</span>
                {edge !== null && Math.abs(edge) > 0.04 && (
                  <span className="edge">{edge > 0 ? "Up" : "Down"} looks {Math.abs(Math.round(edge * 100))}c cheap</span>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <PayoutRow
        stake={stake}
        price={intent === "down" ? bidPrice("down", model_p) : bidPrice("up", model_p)}
        probability={intent === "down" && model_p !== null ? 1 - model_p : model_p}
        side={intent === "down" ? "down" : "up"}
      />

      {prediction.status === "ok" && (
        <button className="reasoning-toggle" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "Hide reasoning" : "Why"}
        </button>
      )}

      {prediction.status === "ok" && expanded && (
        <div className="reasoning">
          <p>{prediction.prediction.reasoning}</p>
          <ul>{prediction.prediction.key_factors.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}

      {prediction.status === "rate_limited" && (
        <p className="notice">Too many reads at once. Next estimate in {prediction.retryAfter}s. You can still swipe.</p>
      )}
      {prediction.status === "unavailable" && (
        <p className="notice">Estimate unavailable. Market odds still apply and this card is still tradable.</p>
      )}

      <p className="resolution">Settles on the Somnia oracle price at close.</p>
    </article>
  );
}
