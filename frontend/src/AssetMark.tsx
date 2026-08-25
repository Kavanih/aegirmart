import { FaBitcoin, FaEthereum } from "react-icons/fa";

/**
 * The coin's own mark rather than a text monogram. Keyed off the asset symbol
 * with a lettered fallback, so a venue listing a third asset still renders
 * something rather than an empty circle.
 */
export function AssetMark({ asset, size = 32 }: { asset: string; size?: number }) {
  const key = asset.toLowerCase();
  const Glyph = key === "btc" ? FaBitcoin : key === "eth" ? FaEthereum : null;

  return (
    <span className={`token ${key}`} style={{ width: size, height: size }} title={asset} aria-label={asset} role="img">
      {Glyph ? <Glyph size={Math.round(size * 0.62)} aria-hidden="true" /> : asset.slice(0, 3)}
    </span>
  );
}
