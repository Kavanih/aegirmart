type Props = { probability: number | null; size?: number };

// Polymarket style radial read. Neutral track, accent arc, percentage inside.
export function ProbabilityRing({ probability, size = 52 }: Props) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = probability === null ? 0 : probability * circumference;

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth="4" />
        {probability !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={probability >= 0.5 ? "var(--up)" : "var(--down)"}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-label">
        {probability === null ? "--" : `${Math.round(probability * 100)}%`}
        <span className="ring-sub">Up</span>
      </span>
    </div>
  );
}
