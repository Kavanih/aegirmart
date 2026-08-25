import type { PricePoint } from "./api";

type Props = { points: PricePoint[]; target: number; width?: number; height?: number };

// Inline SVG rather than a chart library: it redraws under drag without cost.
export function Sparkline({ points, target, width = 300, height = 64 }: Props) {
  if (points.length < 2) return <div className="spark-empty" style={{ height }} aria-hidden="true" />;

  const prices = points.map((p) => p.price).concat(target);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const span = hi - lo || 1;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (price: number) => height - ((price - lo) / span) * height;

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ");
  const area = `${path} L${width},${height} L0,${height} Z`;

  const last = points[points.length - 1].price;
  const above = last >= target;
  const stroke = above ? "var(--up)" : "var(--down)";

  return (
    <svg className="spark" style={{ height }} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={stroke} opacity="0.1" />
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" />
      <line x1="0" y1={y(target)} x2={width} y2={y(target)} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="2.5" fill={stroke} />
    </svg>
  );
}
