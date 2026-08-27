import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "./Card";
import { fetchBooks, fetchMarkets, fetchPrediction, fetchPredictions, recordToState, title, type Market, type MarketBook, type PredictionState, type PricePoint } from "./api";
import { useSwipe, type Direction } from "./useSwipe";
import { bidPrice, quoteFor } from "./wallet/trade";
import { useAccount, useReadContract } from "wagmi";
import { erc20Abi, formatUnits } from "viem";
import { TUSDC } from "./wallet/config";
import { useTrade } from "./wallet/useTrade";
import { useToast } from "./Toast";
import { StakePanel } from "./StakePanel";

const PREFETCH_DEPTH = 3;

const noop = () => {};

type Placed = { market: Market; direction: Direction };

type DeckProps = {
  intervalSec: number;
  /** Opens the deck on this contract, for arriving from a card in the grid. */
  focusMarketId?: string | null;
};

export function SwipeDeck({ intervalSec, focusMarketId }: DeckProps) {
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
  // Sends the swipe currently sitting in its undo window, if there is one.
  const flushPending = useRef<() => void>(noop);
  const [stake, setStake] = useState(5);
  const { address, isConnected } = useAccount();
  const [books, setBooks] = useState<Record<string, MarketBook>>({});

  // The wallet's collateral. An order it cannot escrow reverts on chain, so
  // the swipe is stopped here instead.
  const { data: collateral } = useReadContract({
    abi: erc20Abi,
    address: TUSDC.address,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const balance = Number(formatUnits(collateral ?? 0n, TUSDC.decimals));

  // The resting book, so a card can say how much is actually for sale.
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
  const { place } = useTrade();
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

  const live = useMemo(() => markets.filter((m) => m.expiry > now), [markets, now]);
  const deck = useMemo(() => live.slice(index, index + PREFETCH_DEPTH), [live, index]);

  // Jump to the requested contract once it arrives in the feed. Applied once
  // per request so it cannot fight the user's own swiping afterwards.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMarketId || focused.current === focusMarketId) return;
    const at = live.findIndex((m) => m.marketId === focusMarketId);
    if (at === -1) return;
    focused.current = focusMarketId;
    setIndex(at);
  }, [focusMarketId, live]);

  // Stored reads only. Asking the model for every card that scrolls past is
  // what drains the daily allowance, so a card arrives idle and the read is
  // requested by hand.
  useEffect(() => {
    const ids = deck.map((m) => m.marketId).filter((id) => !predictions[id]);
    if (ids.length === 0) return;

    let alive = true;
    setPredictions((p) => {
      const next = { ...p };
      for (const id of ids) next[id] ??= { status: "idle" };
      return next;
    });

    fetchPredictions(ids).then((records) => {
      if (!alive || records.length === 0) return;
      setPredictions((p) => {
        const next = { ...p };
        for (const r of records) next[r.marketId] = recordToState(r);
        return next;
      });
    });

    return () => {
      alive = false;
    };
  }, [deck, predictions]);

  /** Spends one call from the daily allowance, for this contract only. */
  const requestRead = useCallback((market: Market) => {
    setPredictions((p) => ({ ...p, [market.marketId]: { status: "loading" } }));
    fetchPrediction(market)
      .then((state) => setPredictions((p) => ({ ...p, [market.marketId]: state })))
      .catch(() =>
        setPredictions((p) => ({ ...p, [market.marketId]: { status: "unavailable", reason: "network" } })),
      );
  }, []);

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

      // An order the wallet cannot escrow reverts on chain, so refuse it here
      // rather than spending gas to be told. Skipping still moves the deck on.
      const read = predictions[market.marketId];
      const fair = read?.status === "ok" ? read.prediction.probability : null;
      const priced = quoteFor(stake, bidPrice(direction, fair));
      if (isConnected && priced && priced.escrow > balance) {
        toast.push("error", `That needs ${priced.escrow.toFixed(2)} tUSDC and the wallet holds ${balance.toFixed(2)}`);
        setIndex((i) => Math.max(0, i - 1));
        return;
      }

      // Commit optimistically and give a short window to take it back. Undo
      // only ever applies to the newest swipe, so a second swipe inside the
      // window must SEND the previous order rather than cancel its timer:
      // clearing it silently dropped the first of two quick swipes.
      flushPending.current();

      setPending({ market, direction });
      setAnnouncement(`${direction === "up" ? "Up" : "Down"} selected on ${title(market)}. Undo available for three seconds.`);

      const send = () => {
        setPending(null);
        if (!isConnected) return;

        // One toast per order, updated in place. Pending toasts never expire on
        // their own, so every path below has to land on a final state.
        const id = toast.push("pending", `Placing ${direction === "up" ? "UP" : "DOWN"} on ${title(market)}`);
        void place(market, direction, stake, fair, (phase, detail) => {
          const tx = `https://shannon-explorer.somnia.network/tx/${detail}`;
          if (phase === "approving") toast.update(id, "pending", "Approving tUSDC for this pool");
          else if (phase === "placing") toast.update(id, "pending", "Waiting for your signature");
          else if (phase === "sent") toast.update(id, "pending", "Sent. Waiting for confirmation", tx);
          else if (phase === "error") toast.update(id, "error", detail);
          else if (phase === "done") {
            const [hash, shares, cents, side] = detail.split("|");
            toast.update(
              id,
              "success",
              `Resting ${shares} ${side === "up" ? "UP" : "DOWN"} at ${cents}c. It fills only if someone crosses it.`,
              `https://shannon-explorer.somnia.network/tx/${hash}`,
            );
          }
        });
      };

      flushPending.current = () => {
        if (undoTimer.current) window.clearTimeout(undoTimer.current);
        undoTimer.current = null;
        flushPending.current = noop;
        send();
      };

      undoTimer.current = window.setTimeout(() => {
        undoTimer.current = null;
        flushPending.current = noop;
        send();
      }, 3000);
    },
    [deck, isConnected, place, stake, predictions, balance, toast],
  );

  const { state, reduced, handlers, commitByKey } = useSwipe(advance, Boolean(top) && online);

  const undo = useCallback(() => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = null;
    flushPending.current = noop;
    setPending(null);
    setIndex((i) => Math.max(0, i - 1));
    setAnnouncement("Swipe undone.");
  }, []);

  const nextMint = useMemo(() => {
    return live.slice(index).length === 0 ? intervalSec - (now % intervalSec) : 0;
  }, [live, index, now, intervalSec]);

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
                  prediction={predictions[market.marketId] ?? { status: "idle" }}
                  series={series[market.asset] ?? []}
                  spot={spot[market.asset] ?? null}
                  swipe={depth === 0 ? state : undefined}
                  now={now}
                  depth={depth}
                  stake={stake}
                  book={books[market.marketId] ?? null}
                  onRead={depth === 0 ? () => requestRead(market) : undefined}
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

      <StakePanel stake={stake} onChange={setStake} />

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

      {pending && (
        <div className="undo-bar" role="status">
          <span>
            {pending.direction === "up" ? "Up" : "Down"} {stake} on {title(pending.market)}
          </span>
          <button onClick={undo}>Undo</button>
        </div>
      )}

      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
