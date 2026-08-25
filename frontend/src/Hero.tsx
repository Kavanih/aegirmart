import { useCallback, useEffect, useMemo, useState } from "react";
import apeImg from "./img/ape31.jpg";
import btcImg from "./img/btc32.jpg";
import ethCityImg from "./img/eth.jpg";
import ethPredictImg from "./img/eth-42.jpg";

type Slide = {
  image: string;
  eyebrow: string;
  title: string;
  body: string;
  /** Anchors the gradient so the art stays visible behind the copy. */
  focus: string;
};

const SLIDES: Slide[] = [
  {
    image: btcImg,
    eyebrow: "Sixty second markets",
    title: "Every window mints at the money",
    body: "BTC and ETH contracts open at spot and settle on the Somnia oracle. There is no spread to guess at: the strike is the price at the moment the window opened.",
    focus: "center 40%",
  },
  {
    image: ethCityImg,
    eyebrow: "Read against live data",
    title: "A model prices every contract",
    body: "Realised volatility, a lognormal digital estimate and the venue's own settled history, reconciled into a single probability that states its own confidence.",
    focus: "center 55%",
  },
  {
    image: ethPredictImg,
    eyebrow: "Scored, not claimed",
    title: "Every call is graded when it settles",
    body: "Predictions are recorded before the window closes, then scored against what actually happened. Accuracy and Brier score, per model, in the open.",
    // Only the vertical part of this bites: every slide is cropped to the
    // panel's width, so horizontal framing has nothing left to move.
    focus: "center 45%",
  },
  {
    image: apeImg,
    eyebrow: "One gesture to a position",
    title: "Swipe up, down, or pass",
    body: "Take a side on a contract without a form. Every trade is signed by you and settles non-custodially on Somnia testnet.",
    focus: "center 30%",
  },
];

const ADVANCE_MS = 7000;

type Props = {
  liveCount: number;
  tradeCount: number;
  onSwipe: (intervalSec: number, marketId?: string) => void;
};

export function Hero({ liveCount, tradeCount, onSwipe }: Props) {
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);

  const go = useCallback((next: number) => {
    setIndex((next + SLIDES.length) % SLIDES.length);
  }, []);

  // Readers who asked for less motion get the slides, just not on a timer.
  const still = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    if (held || still) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), ADVANCE_MS);
    return () => window.clearInterval(id);
  }, [held, still]);

  const slide = SLIDES[index];

  return (
    <section
      className="hero"
      aria-roledescription="carousel"
      aria-label="What AEGIRMART does"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocusCapture={() => setHeld(true)}
      onBlurCapture={() => setHeld(false)}
    >
      {/* Every slide stays mounted so switching never re-decodes an image.
          Opacity is inline rather than a class: it is the one thing that must
          track state exactly, and an inline value cannot be lost to the cascade. */}
      {SLIDES.map((s, i) => (
        <img
          key={s.image}
          className="hero-img"
          src={s.image}
          alt=""
          aria-hidden="true"
          style={{ objectPosition: s.focus, opacity: i === index ? 1 : 0 }}
          loading={i === 0 ? "eager" : "lazy"}
        />
      ))}
      <div className="hero-wash" />

      <div className="hero-inner">
        <div className="hero-badges">
          <span className="hero-pill accent">{liveCount} live now</span>
          <span className="hero-pill">60s fastest window</span>
          <span className="hero-pill">{tradeCount === 0 ? "No trades yet" : `${tradeCount} trades`}</span>
        </div>

        <div className="hero-copy" aria-live="polite">
          <p className="hero-eyebrow">{slide.eyebrow}</p>
          <h2>{slide.title}</h2>
          <p className="hero-body">{slide.body}</p>
          <div className="hero-actions">
            <button className="cta" onClick={() => onSwipe(60)}>
              Start swiping
            </button>
            <span className="hero-note">Somnia testnet</span>
          </div>
        </div>

        <div className="hero-controls">
          <button className="hero-arrow" onClick={() => go(index - 1)} aria-label="Previous slide">
            <Chevron dir="left" />
          </button>

          <div className="hero-dots">
            {SLIDES.map((s, i) => (
              <button
                key={s.image}
                className={i === index ? "hero-dot on" : "hero-dot"}
                onClick={() => go(i)}
                aria-label={`Slide ${i + 1}: ${s.title}`}
                aria-current={i === index}
              />
            ))}
          </div>

          <button className="hero-arrow" onClick={() => go(index + 1)} aria-label="Next slide">
            <Chevron dir="right" />
          </button>
        </div>
      </div>
    </section>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}
