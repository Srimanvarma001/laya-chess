interface EvalBarProps {
  /** white material - black material */
  diff: number;
}

/**
 * Purely cosmetic/informational — reuses the same one-ply material numbers
 * the calibration panel already computes, just as a quick-glance bar next
 * to the board like the reference UI's side bar.
 */
export function EvalBar({ diff }: EvalBarProps) {
  // Squash the (unbounded) material diff into a 0-100% fill, centered at 50%.
  const clamped = Math.max(-12, Math.min(12, diff));
  const whitePct = 50 + (clamped / 12) * 50;

  return (
    <div className="eval-bar-wrap">
      <div className="eval-bar">
        <div className="eval-bar-fill" style={{ height: `${whitePct}%` }} />
      </div>
      <div className="eval-bar-label">{diff >= 0 ? "+" : ""}{diff}</div>
    </div>
  );
}
