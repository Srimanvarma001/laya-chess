import { useEffect, useId, useState } from "react";

export interface TrailMove {
  from: string; // e.g. "e2"
  to: string; // e.g. "e4"
  /** 0..1 confidence weight. Ignored in "considering" mode. */
  weight: number;
}

interface MoveTrailsProps {
  moves: TrailMove[];
  mode: "considering" | "resolved" | "played";
  /** When true, the overlay mounts visible then fades to 0 (slow dissolve for played, 600ms for old resolved). */
  fading?: boolean;
}

/**
 * Single source of truth for square geometry: the real rendered square size
 * from CSS `--sq-size` (see styles.css). Nothing here hardcodes a pixel
 * constant — Board animations and trail coordinates both read this, so the
 * whole board (grid, SVG overlay, slide positions) scales together.
 */
export function getSquareSizePx(): number {
  if (typeof window === "undefined" || typeof document === "undefined") return 64;
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--sq-size").trim();
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through to default */
  }
  return 64;
}

/** Full board edge length in px (8 squares). Read live — not a constant. */
export function getBoardPx(): number {
  return getSquareSizePx() * 8;
}

/** Pixel center of a square like "e4", derived from the live --sq-size. */
export function squareCenter(square: string): { x: number; y: number } {
  const S = getSquareSizePx();
  const fileIndex = square.charCodeAt(0) - 97; // 'a' -> 0 ... 'h' -> 7
  const rankValue = Number(square[1]); // '1'..'8'
  return {
    x: fileIndex * S + S / 2,
    y: (8 - rankValue) * S + S / 2,
  };
}

/** True for a knight jump (1+2 L): the only piece that moves this way. */
export function isKnightJump(from: string, to: string): boolean {
  const df = Math.abs(from.charCodeAt(0) - to.charCodeAt(0));
  const dr = Math.abs(Number(from[1]) - Number(to[1]));
  return (df === 1 && dr === 2) || (df === 2 && dr === 1);
}

/**
 * L-corner for a knight trail: travel the LONG leg first, then the short
 * one (e.g. b1->c3 goes b1->b3->c3, g1->e1->e2).
 */
export function knightCorner(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.abs(dx) > Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
}

/**
 * Faint cyan candidate lines layered exactly on top of the .board grid (see
 * .board-stack / .move-trails in styles.css). `pointer-events: none` so
 * squares stay clickable. Accent comes from --trail in CSS.
 */
export function MoveTrails({ moves, mode, fading = false }: MoveTrailsProps) {
  // Mount visible, then flip to faded so the CSS opacity transition animates
  // instead of cutting abruptly.
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (!fading) return;
    const t = window.setTimeout(() => setFaded(true), 30);
    return () => window.clearTimeout(t);
  }, [fading]);
  // Re-render once after mount (and on resize) so the live --sq-size read
  // above picks up the real stylesheet value instead of the first-paint
  // fallback. Geometry otherwise comes straight from getSquareSizePx().
  const [, setTick] = useState(0);
  useEffect(() => {
    setTick((t) => t + 1);
    const onResize = () => setTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  // Unique gradient id — several MoveTrails can be mounted at once (e.g. a
  // fading resolved overlay under a fresh considering one).
  const gradientId = useId();

  const boardPx = getBoardPx();

  // Resolved brightness normalizer: `moves` arrive sorted brightest-first,
  // so moves[0] is the top pick. Opacity/thickness scale monotonically with
  // rawConfidence relative to that top weight — the top pick is always the
  // brightest (0.9), the rest fade in proportion to their real share.
  const topWeight =
    mode === "resolved" && moves.length > 0 ? Math.max(0, moves[0].weight) : 1;

  // One glow node per unique square touched by any drawn line (origins AND
  // destinations). Brightness follows the best (lowest-index) move touching
  // the square, same tiers as the lines, so shared origins glow too.
  // "played" is always tier 0: single bright line under the sliding piece.
  // Knight trails also glow their L-corner so the bend reads clearly.
  const glows = new Map<string, { x: number; y: number; tier: number }>();
  moves.forEach((m, idx) => {
    const tier =
      mode === "played" ? 0 : mode === "resolved" ? (idx === 0 ? 0 : idx <= 2 ? 1 : 2) : -1;
    for (const sq of [m.from, m.to]) {
      const prev = glows.get(sq);
      if (!prev || tier < prev.tier) glows.set(sq, { ...squareCenter(sq), tier });
    }
    if (isKnightJump(m.from, m.to)) {
      const c = knightCorner(squareCenter(m.from), squareCenter(m.to));
      const key = `corner-${m.from}${m.to}`;
      const prev = glows.get(key);
      if (!prev || tier < prev.tier) glows.set(key, { ...c, tier });
    }
  });
  const glowStyle = (tier: number): { r: number; opacity: number } =>
    tier === 0
      ? { r: 28, opacity: 0.6 }
      : tier === 1
        ? { r: 22, opacity: 0.4 }
        : tier === 2
          ? { r: 14, opacity: 0.15 }
          : { r: 16, opacity: 0.2 };

  return (
    <svg
      className={`move-trails ${mode}${fading && faded ? " fading" : ""}`}
      width={boardPx}
      height={boardPx}
      viewBox={`0 0 ${boardPx} ${boardPx}`}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradientId}>
          <stop offset="0%" className="trail-glow-stop" stopOpacity="0.9" />
          <stop offset="100%" className="trail-glow-stop" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* Glows first = behind lines and (via .piece z-index) behind glyphs. */}
      {[...glows].map(([sq, g]) => {
        const s = glowStyle(g.tier);
        return (
          <circle
            key={`glow-${sq}`}
            cx={g.x}
            cy={g.y}
            r={s.r}
            fill={`url(#${gradientId})`}
            opacity={s.opacity}
          />
        );
      })}
      {/* `moves` must be sorted brightest-first: tier is by index so the top
        1-3 candidates pop in every position, even when raw weights are flat.
        (Stroke color lives in CSS — var() is not substituted in SVG
        presentation attributes, so stroke="var(--trail)" would render black.) */}
      {moves.map((m, idx) => {
        const a = squareCenter(m.from);
        const b = squareCenter(m.to);
        const w = Math.max(0, Math.min(1, m.weight));
        const tier =
          mode === "played" ? 0 : mode === "resolved" ? (idx === 0 ? 0 : idx <= 2 ? 1 : 2) : -1;
        // Resolved: continuous confidence weighting. norm is the move's real
        // share relative to the top pick (1 for the winner); opacity and
        // thickness both grow with it, so the bars and the trails agree.
        const norm = mode === "resolved" && topWeight > 0 ? w / topWeight : w;
        const strokeWidth =
          tier === 0 ? 3 : tier === 1 ? 1.75 + 1.25 * norm : tier === 2 ? 1 + 1.25 * norm : 1.5;
        const opacity =
          tier === 0
            ? 0.9
            : tier === 1
              ? 0.3 + 0.55 * norm
              : tier === 2
                ? 0.12 + 0.45 * norm
                : 0.15;
        // Knights hop an L: draw the bend (long leg first), never a straight cut.
        if (isKnightJump(m.from, m.to)) {
          const c = knightCorner(a, b);
          return (
            <polyline
              key={`${m.from}${m.to}`}
              points={`${a.x},${a.y} ${c.x},${c.y} ${b.x},${b.y}`}
              fill="none"
              strokeWidth={strokeWidth}
              opacity={opacity}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        }
        return (
          <line
            key={`${m.from}${m.to}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            strokeWidth={strokeWidth}
            opacity={opacity}
          />
        );
      })}
    </svg>
  );
}
