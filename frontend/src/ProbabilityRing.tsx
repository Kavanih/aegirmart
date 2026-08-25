export type Confidence = "low" | "medium" | "high";

type Props = {
  probability: number | null;
  /** Drives the arc colour. Omitted for a market price, which has no confidence. */
  confidence?: Confidence;
  size?: number;
  /** What the number is: the model's read, or the book's. */
  caption?: string;
  /** True while a read is expected but has not arrived. */
  pending?: boolean;
};

// Radial read. Per the ramp in styles.css the arc keys to CONFIDENCE, not to
// which side leads, so a bold 80% on a low confidence read cannot look safe.
export function ProbabilityRing({ probability, confidence, size = 52, caption = "Up", pending = false }: Props) {
  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = probability === null ? 0 : probability * circumference;
  const arc = confidence ? `var(--conf-${confidence})` : "var(--accent)";

  return (
    <div className={pending && probability === null ? "ring pending" : "ring"} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--line)" strokeWidth="4" />
        {probability !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={arc}
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <span className="ring-label">
        {probability === null ? <span className="ring-dash">--</span> : `${Math.round(probability * 100)}%`}
        <span className="ring-sub">{caption}</span>
      </span>
    </div>
  );
}
