type Props = { size?: number; withWordmark?: boolean; onClick?: () => void };

// The AE ligature, the Norse letter in Aegir, drawn as geometry rather than type
// so it stays identical across platforms and legible down to favicon size.
export function Logo({ size = 30, withWordmark = true, onClick }: Props) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag className="logo" onClick={onClick} {...(onClick ? { type: "button" as const, "aria-label": "Go to markets" } : {})}>
      <svg width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="Aegirmart">
        <defs>
          <linearGradient id="aegir-mark" gradientUnits="userSpaceOnUse" x1="6" y1="24" x2="25" y2="8">
            <stop offset="0%" stopColor="var(--accent-deep)" />
            <stop offset="100%" stopColor="var(--accent)" />
          </linearGradient>
        </defs>
        <rect x="0.75" y="0.75" width="30.5" height="30.5" rx="8.5" fill="var(--surface-2)" stroke="var(--line)" strokeWidth="1.5" />
        <g fill="none" stroke="url(#aegir-mark)" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 24 L13 8" />
          <path d="M13 8 V24" />
          <path d="M9 18.5 H13" />
          <path d="M13 8 H25" />
          <path d="M13 16 H21.5" />
          <path d="M13 24 H25" />
        </g>
      </svg>
      {withWordmark && (
        <span className="wordmark">
          AEGIR<span>MART</span>
        </span>
      )}
    </Tag>
  );
}
