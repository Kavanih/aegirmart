import { useState } from "react";
import { SwipeDeck } from "./SwipeDeck";
import { MarketGrid } from "./MarketGrid";
import { Leaderboard } from "./Leaderboard";
import { Portfolio } from "./Portfolio";
import { Accuracy } from "./Accuracy";
import { Logo } from "./Logo";
import { ConnectWallet } from "./wallet/ConnectWallet";
import "./styles.css";

const LANES = [
  { label: "5 min", intervalSec: 300 },
  { label: "1 min", intervalSec: 60 },
];

type View = "markets" | "swipe" | "accuracy" | "leaderboard" | "portfolio";

const TABS: { id: View; label: string }[] = [
  { id: "markets", label: "Markets" },
  { id: "swipe", label: "Swipe" },
  { id: "accuracy", label: "AI Scoreboard" },
  { id: "leaderboard", label: "Leaderboard" },
  { id: "portfolio", label: "Portfolio" },
];

export function App() {
  const [view, setView] = useState<View>("markets");
  const [intervalSec, setIntervalSec] = useState(LANES[0].intervalSec);

  const openSwipe = (lane: number) => {
    setIntervalSec(lane);
    setView("swipe");
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Logo onClick={() => setView("markets")} />
          <nav className="tabs" aria-label="Sections">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                className={view === tab.id ? "tab on" : "tab"}
                aria-pressed={view === tab.id}
                onClick={() => setView(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <ConnectWallet />
        </div>
      </header>

      <main className={view === "swipe" ? "main narrow" : "main"}>
        {view === "markets" && <MarketGrid onSwipe={openSwipe} />}
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
                    onClick={() => setIntervalSec(lane.intervalSec)}
                  >
                    {lane.label}
                  </button>
                ))}
              </nav>
            </div>
            <SwipeDeck key={intervalSec} intervalSec={intervalSec} />
          </>
        )}
      </main>

      <footer className="disclosure">
        Somnia testnet. Model estimates are generated from live venue data and have no verified track record. They are
        guidance, not advice. Market price is the real odd.
      </footer>
    </div>
  );
}
