type Props = { size?: number; withWordmark?: boolean; onClick?: () => void };

// A stepped line drawn as geometry rather than type, so it renders identically
// on every platform and stays legible down to favicon size.
export function Logo({ size = 30, withWordmark = true, onClick }: Props) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag className="logo" onClick={onClick} {...(onClick ? { type: "button" as const, "aria-label": "Go to markets" } : {})}>
      {/* A stepped line: the shape a settled window actually traces, held to a
          strict grid so it stays sharp at favicon size. Mitred rather than
          rounded, and one flat colour, so it survives being scaled down and
          printed in a single ink. */}
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="Aegirmart">
        <path
          d="M6 50 H20 V16 H40 V38 H58"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="11"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit="4"
        />
      </svg>
      {withWordmark && (
        <span className="wordmark">
          AEGIR<span>MART</span>
        </span>
      )}
    </Tag>
  );
}
