import { useState } from "react";
import { SwipeDeck } from "./SwipeDeck";
import { MarketGrid } from "./MarketGrid";
import { Leaderboard } from "./Leaderboard";
import { Portfolio } from "./Portfolio";
import { Accuracy } from "./Accuracy";
import { MarketDetail } from "./MarketDetail";
import { Sidebar, type View } from "./Sidebar";
import { ThemeToggle } from "./Theme";
import { ConnectWallet } from "./wallet/ConnectWallet";
import "./styles.css";

const LANES = [
  { label: "5 min", intervalSec: 300 },
  { label: "1 min", intervalSec: 60 },
];

const HEADING: Record<View, string> = {
  markets: "Markets",
  swipe: "Swipe",
  accuracy: "AI Scoreboard",
  leaderboard: "Leaderboard",
  portfolio: "Positions",
};

export function App() {
  const [view, setView] = useState<View>("markets");
  const [intervalSec, setIntervalSec] = useState(LANES[0].intervalSec);
  const [navOpen, setNavOpen] = useState(false);
  const [focusMarketId, setFocusMarketId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  // A card in the grid opens the deck on that exact contract; the hero opens
  // the lane it advertises.
  const openSwipe = (lane: number, marketId?: string) => {
    setIntervalSec(lane);
    setFocusMarketId(marketId ?? null);
    setView("swipe");
  };

  const select = (next: View) => {
    setView(next);
    setDetailId(null);
    setNavOpen(false);
  };

  const openDetail = (marketId: string) => {
    setDetailId(marketId);
    setView("markets");
    setNavOpen(false);
  };

  return (
    <div className={navOpen ? "shell nav-open" : "shell"}>
      <Sidebar view={view} onSelect={select} />

      {/* Tapping the dimmed content closes the drawer on small screens. */}
      <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />

      <div className="content">
        <header className="topbar">
          <button className="icon-btn nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Toggle navigation">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>

          <h1 className="page-title">{HEADING[view]}</h1>

          <div className="topbar-right">
            <ThemeToggle />
            <ConnectWallet onNavigate={select} />
          </div>
        </header>

        <main className={view === "swipe" ? "main narrow" : "main"}>
          {view === "markets" &&
            (detailId ? (
              <MarketDetail marketId={detailId} onBack={() => setDetailId(null)} />
            ) : (
              <MarketGrid onSwipe={openSwipe} onOpen={openDetail} />
            ))}
          {view === "accuracy" && <Accuracy />}
          {view === "leaderboard" && <Leaderboard />}
          {view === "portfolio" && <Portfolio />}
          {view === "swipe" && (
            <>
              <div className="lane-row">
                <nav className="lanes" aria-label="Contract window">
                  {LANES.map((lane) => (
                    <button
                      key={lane.intervalSec}
                      className={lane.intervalSec === intervalSec ? "lane on" : "lane"}
                      aria-pressed={lane.intervalSec === intervalSec}
                      onClick={() => {
                        setIntervalSec(lane.intervalSec);
                        setFocusMarketId(null);
                      }}
                    >
                      {lane.label}
                    </button>
                  ))}
                </nav>
              </div>
              <SwipeDeck key={intervalSec} intervalSec={intervalSec} focusMarketId={focusMarketId} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}
