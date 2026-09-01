/**
 * Wallet marks, drawn inline.
 *
 * Inline SVG rather than fetched artwork: no third-party request from a page
 * that is about to ask for a signature, nothing to fail on a slow network, and
 * both themes get the same shape. Each is a simplified geometric take on the
 * wallet's own mark, carrying its brand colour, which is what people actually
 * recognise in a list this size.
 */
type Mark = { bg: string; art: JSX.Element };

const foxFg = "#e17726";
const MARKS: Record<string, Mark> = {
  metaMask: {
    bg: "#ffe9d5",
    art: (
      <g fill={foxFg}>
        <path d="M4 5l7 5-1.6-4.2zM28 5l-7 5 1.6-4.2z" />
        <path d="M8.5 21.5l-1.7 3.4 5.6-1.1zM23.5 21.5l1.7 3.4-5.6-1.1z" />
        <path d="M11 10.2L8.7 15l5 .3-.2-4.6zM21 10.2l2.3 4.8-5 .3.2-4.6z" />
        <path d="M12.4 23.8l3.6.9 3.6-.9-1.3 2.4h-4.6z" />
      </g>
    ),
  },
  rabby: {
    bg: "#e5e9ff",
    art: (
      <g fill="#7084ff">
        <path d="M9 8c0-2 1-3 2-3s2 1 2 3v4H9zM19 8c0-2 1-3 2-3s2 1 2 3v4h-4z" />
        <path d="M16 11c5 0 9 3.2 9 7.5S21 26 16 26s-9-3.2-9-7.5S11 11 16 11z" />
        <circle cx="12.5" cy="18" r="1.4" fill="#e5e9ff" />
        <circle cx="19.5" cy="18" r="1.4" fill="#e5e9ff" />
      </g>
    ),
  },
  okx: {
    bg: "#0b0f14",
    art: (
      <g fill="#ffffff">
        <rect x="5" y="5" width="6.5" height="6.5" />
        <rect x="20.5" y="5" width="6.5" height="6.5" />
        <rect x="12.75" y="12.75" width="6.5" height="6.5" />
        <rect x="5" y="20.5" width="6.5" height="6.5" />
        <rect x="20.5" y="20.5" width="6.5" height="6.5" />
      </g>
    ),
  },
  coinbase: {
    bg: "#0052ff",
    art: (
      <g>
        <circle cx="16" cy="16" r="11" fill="#ffffff" />
        <circle cx="16" cy="16" r="9" fill="#0052ff" />
        <rect x="12.5" y="12.5" width="7" height="7" rx="1.4" fill="#ffffff" />
      </g>
    ),
  },
  brave: {
    bg: "#fb542b",
    art: (
      <g fill="#ffffff">
        <path d="M16 4l7 2.6 2 3.4-1.2 9.4L16 28l-7.8-8.6L7 10l2-3.4z" opacity="0.25" />
        <path d="M16 7.5l4.6 1.7 1.3 2.2-.8 6.4L16 23l-5.1-5.2-.8-6.4 1.3-2.2z" />
      </g>
    ),
  },
  trust: {
    bg: "#3375bb",
    art: <path d="M16 4l9 3.4v7.9c0 5.4-3.6 9.9-9 12.3-5.4-2.4-9-6.9-9-12.3V7.4z" fill="#ffffff" />,
  },
};

export function WalletMark({ id, size = 28 }: { id: string; size?: number }) {
  const mark = MARKS[id];

  if (!mark) {
    return (
      <span
        className="wallet-mark"
        style={{ width: size, height: size, background: "var(--surface-2)", color: "var(--muted)", fontSize: size * 0.44 }}
        aria-hidden="true"
      >
        ?
      </span>
    );
  }

  return (
    <span className="wallet-mark" style={{ width: size, height: size, background: mark.bg }} aria-hidden="true">
      <svg viewBox="0 0 32 32" width={size} height={size}>
        {mark.art}
      </svg>
    </span>
  );
}
