// Brand coloured monograms rather than reproduced logos: no external requests,
// no trademark artwork, and they swap cleanly for official SVGs later.
const BRAND: Record<string, { bg: string; fg: string; letter: string }> = {
  metaMask: { bg: "#f6851b", fg: "#1b1206", letter: "M" },
  rabby: { bg: "#7084ff", fg: "#0b1030", letter: "R" },
  okx: { bg: "#e9edf2", fg: "#0b0f14", letter: "O" },
  coinbase: { bg: "#0052ff", fg: "#e8f0ff", letter: "C" },
  brave: { bg: "#fb542b", fg: "#210b05", letter: "B" },
  trust: { bg: "#3375bb", fg: "#e6f0fb", letter: "T" },
};

export function WalletMark({ id, size = 28 }: { id: string; size?: number }) {
  const brand = BRAND[id] ?? { bg: "var(--surface)", fg: "var(--muted)", letter: "?" };

  return (
    <span
      className="wallet-mark"
      style={{ width: size, height: size, background: brand.bg, color: brand.fg, fontSize: size * 0.46 }}
      aria-hidden="true"
    >
      {brand.letter}
    </span>
  );
}
