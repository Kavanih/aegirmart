// Deterministic identicon derived from the address itself: every wallet gets a
// stable picture with no upload, no external request, and no default avatar
// that makes two different accounts look like the same person.

function hash(seed: string): number[] {
  const out: number[] = [];
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
    out.push(h);
  }
  return out;
}

type Props = { address: string; size?: number };

export function Avatar({ address, size = 32 }: Props) {
  const seed = address.toLowerCase();
  const h = hash(seed);
  const at = (i: number) => h[i % h.length] ?? 0;

  const hue = at(3) % 360;
  const bg = `hsl(${hue} 58% 32%)`;
  const fg = `hsl(${(hue + 42) % 360} 72% 68%)`;

  // Five rows, three columns, mirrored: the classic identicon block layout.
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (at(y * 3 + x + 7) % 100 < 47) continue;
      cells.push({ x, y });
      if (x < 2) cells.push({ x: 4 - x, y });
    }
  }

  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 5 5" role="img"
      aria-label={`Identicon for ${address.slice(0, 6)}`}>
      <rect width="5" height="5" fill={bg} />
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" fill={fg} />
      ))}
    </svg>
  );
}
