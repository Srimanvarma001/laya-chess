import { SETTLE_MATE } from "../chess/engine";
import type { SettledMaterial } from "../types";

interface EvalBarProps {
  /** Material once the available captures play out (white - black). */
  settled: SettledMaterial;
  /** Material on the board right now (white - black), for the hover text. */
  staticDiff: number;
}

const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;

/**
 * Quick-glance material bar next to the board. Zero AI: it shows the
 * capture-search result from engine.ts evaluateSettledMaterial, so a piece
 * that can be won right now moves the bar before it is actually taken.
 * The plain on-board count stays in the status line under the board.
 */
export function EvalBar({ settled, staticDiff }: EvalBarProps) {
  const { diff, complete } = settled;
  const isMate = Math.abs(diff) >= SETTLE_MATE;
  // Squash the (unbounded) material diff into a 0-100% fill, centered at 50%.
  const clamped = Math.max(-12, Math.min(12, diff));
  const whitePct = 50 + (clamped / 12) * 50;
  // "~" marks a search that hit its limit: the number is a bound, not settled.
  const label = isMate ? "#" : `${complete ? "" : "~"}${signed(diff)}`;
  const title = isMate
    ? `Checkmate: ${diff > 0 ? "white" : "black"} wins.`
    : `Material after captures play out: ${signed(diff)}${complete ? "" : " (search cut short)"}. ` +
      `On the board now: ${signed(staticDiff)}. No AI involved.`;

  return (
    <div className="eval-bar-wrap" title={title}>
      <div className="eval-bar">
        <div className="eval-bar-fill" style={{ height: `${whitePct}%` }} />
      </div>
      <div className="eval-bar-label">{label}</div>
    </div>
  );
}
