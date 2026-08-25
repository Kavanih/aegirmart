import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./Card";
import { fetchMarkets, fetchPrediction, title, type Market, type PredictionState, type PricePoint } from "./api";
import { useSwipe, type Direction } from "./useSwipe";
import { useAccount } from "wagmi";
import { useTrade } from "./wallet/useTrade";
import { useToast } from "./Toast";

const PREFETCH_DEPTH = 3;

type Placed = { market: Market; direction: Direction };

export function SwipeDeck({ intervalSec }: { intervalSec: number }) {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [series, setSeries] = useState<Record<string, PricePoint[]>>({});
  const [spot, setSpot] = useState<Record<string, number | null>>({});
  const [index, setIndex] = useState(0);
  const [predictions, setPredictions] = useState<Record<string, PredictionState>>({});
  const [online, setOnline] = useState(navigator.onLine);
  const [feedError, setFeedError] = useState(false);
  const [pending, setPending] = useState<Placed | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const undoTimer = useRef<number | null>(null);
  const [stake, setStake] = useState(5);
  const { isConnected } = useAccount();
  const { state: trade, place, reset: resetTrade } = useTrade();
  const toast = useToast();
  const lastPhase = useRef<string>("idle");

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Poll for freshly minted windows. The venue only ever holds a few at once.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const deckData = await fetchMarkets(intervalSec);
        if (!alive) return;
        setFeedError(false);
        setSeries(deckData.series ?? {});
        setSpot(deckData.spot ?? {});
        setMarkets((prev) => {
          const seen = new Set(prev.map((m) => m.marketId));
          const added = deckData.markets.filter((m) => !seen.has(m.marketId));
          return added.length ? [...prev, ...added] : prev;
        });
      } catch {
        // A dead service must not read as an empty window. Say which it is.
        if (alive) setFeedError(true);
      }
    };
    load();
    const poll = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(poll);
    };
  }, [intervalSec]);

  const deck = useMemo(
    () => markets.filter((m) => m.expiry > now).slice(index, index + PREFETCH_DEPTH),
    [markets, index, now],
  );

  // Resolve the top card and the next two so the estimate is ready on arrival.
  useEffect(() => {
    deck.forEach((market) => {
      if (predictions[market.marketId]) return;
      setPredictions((p) => ({ ...p, [market.marketId]: { status: "loading" } }));
      fetchPrediction(market)
        .then((state) => setPredictions((p) => ({ ...p, [market.marketId]: state })))
        .catch(() =>
          setPredictions((p) => ({ ...p, [market.marketId]: { status: "unavailable", reason: "network" } })),
        );
    });
  }, [deck, predictions]);

  const top = deck[0];
  const topPrediction = top ? predictions[top.marketId] ?? { status: "loading" as const } : null;

  useEffect(() => {
    if (!top || !topPrediction) return;
    const read =
      topPrediction.status === "ok"
        ? `Model estimate ${Math.round(topPrediction.prediction.probability * 100)} percent, ${topPrediction.prediction.confidence} confidence.`
        : topPrediction.status === "loading"
          ? "Estimate loading."
          : "Estimate unavailable.";
    setAnnouncement(`${title(top)}. ${read}`);
  }, [top, topPrediction]);

  const advance = useCallback(
    (direction: Direction) => {
      const market = deck[0];
      if (!market) return;

      setIndex((i) => i + 1);

      if (direction === "skip") {
        setAnnouncement(`Skipped ${title(market)}.`);
        return;
      }

      // Commit optimistically and give a short window to take it back.
      setPending({ market, direction });
      setAnnouncement(`${direction === "up" ? "Up" : "Down"} selected on ${title(market)}. Undo available for three seconds.`);
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
      undoTimer.current = window.setTimeout(() => {
        setPending(null);
        const read = predictions[market.marketId];
        const fair = read?.status === "ok" ? read.prediction.probability : null;
        if (isConnected) place(market, direction, stake, fair);
      }, 3000);
    },
    [deck, isConnected, place, stake, predictions],
  );

  const { state, reduced, handlers, commitByKey } = useSwipe(advance, Boolean(top) && online);

  const undo = useCallback(() => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    setPending(null);
    setIndex((i) => Math.max(0, i - 1));
    setAnnouncement("Swipe undone.");
  }, []);

  // Mirror each transaction phase into a toast without duplicating on rerender.
  useEffect(() => {
    if (trade.phase === lastPhase.current) return;
    lastPhase.current = trade.phase;
    if (trade.phase === "approving") toast.push("pending", "Approving tUSDC for this pool");
    else if (trade.phase === "placing") toast.push("pending", "Placing order");
    else if (trade.phase === "done") {
      toast.push("success", `Resting ${trade.shares.toFixed(2)} ${trade.direction === "up" ? "UP" : "DOWN"} at ${Math.round(trade.price * 100)}c`,
        `https://shannon-explorer.somnia.network/tx/${trade.hash}`);
      resetTrade();
    } else if (trade.phase === "error") {
      toast.push("error", trade.message);
      resetTrade();
    }
  }, [trade, toast, resetTrade]);

  const nextMint = useMemo(() => {
    const future = markets.filter((m) => m.expiry > now).slice(index);
    return future.length === 0 ? intervalSec - (now % intervalSec) : 0;
  }, [markets, index, now, intervalSec]);

  return (
    <div className={`deck-wrap ${reduced ? "reduced" : ""}`}>
      {!online && <div className="banner offline">Offline. Cards and estimates are paused until the connection returns.</div>}
      {online && feedError && <div className="banner offline">Cannot reach the market service. Retrying every ten seconds.</div>}

      <div className="deck" role="group" aria-roledescription="card deck">
        {top ? (
          <div
            className="top-slot"
            tabIndex={0}
            role="button"
            aria-label="Prediction card. Arrow right for up, arrow left for down, arrow up to skip."
            {...handlers}
          >
            {deck
              .map((market, depth) => (
                <Card
                  key={market.marketId}
                  market={market}
                  prediction={predictions[market.marketId] ?? { status: "loading" }}
                  series={series[market.asset] ?? []}
                  spot={spot[market.asset] ?? null}
                  swipe={depth === 0 ? state : undefined}
                  now={now}
                  depth={depth}
                  stake={stake}
                />
              ))
              .reverse()}
          </div>
        ) : (
          <div className="empty">
            <p className="empty-title">{feedError ? "Market service unreachable" : "Waiting for the next window"}</p>
            <p className="empty-sub">
              {feedError ? "Reconnecting. Cards return as soon as the feed responds." : `New contracts mint in ${nextMint}s`}
            </p>
          </div>
        )}
      </div>

      <div className="controls">
        <button className="ctl down" onClick={() => commitByKey("down")} disabled={!top || !online}>
          Down
        </button>
        <button className="ctl skip" onClick={() => commitByKey("skip")} disabled={!top || !online}>
          Skip
        </button>
        <button className="ctl up" onClick={() => commitByKey("up")} disabled={!top || !online}>
          Up
        </button>
      </div>

      <div className="stake-row">
        <span className="stake-label">Stake</span>
        {[1, 5, 25].map((amount) => (
          <button
            key={amount}
            className={amount === stake ? "stake on" : "stake"}
            aria-pressed={amount === stake}
            onClick={() => setStake(amount)}
          >
            {amount}
          </button>
        ))}
        <span className="stake-unit">tUSDC</span>
        {!isConnected && <span className="stake-note">Paper mode until a wallet connects</span>}
      </div>

      {pending && (
        <div className="undo-bar" role="status">
          <span>
            {pending.direction === "up" ? "Up" : "Down"} {stake} on {title(pending.market)}
          </span>
          <button onClick={undo}>Undo</button>
        </div>
      )}

      {trade.phase !== "idle" && !pending && (
        <div className={`trade-bar ${trade.phase}`} role="status">
          {trade.phase === "approving" && <span>Approving tUSDC for this pool</span>}
          {trade.phase === "placing" && <span>Placing order</span>}
          {trade.phase === "done" && <span>Filled {trade.shares.toFixed(2)} {trade.direction === "up" ? "UP" : "DOWN"}</span>}
          {trade.phase === "error" && <span>{trade.message}</span>}
          {(trade.phase === "done" || trade.phase === "error") && <button onClick={resetTrade}>Dismiss</button>}
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
