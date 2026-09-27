import { useEffect, useMemo, useState } from "react";
import { Chess } from "chess.js";
import type { CandidateMove } from "../types";
import { getLegalMoves } from "../chess/engine";

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

const UNICODE_PIECES: Record<string, string> = {
  wp: "♙", wn: "♘", wb: "♗", wr: "♖", wq: "♕", wk: "♔",
  bp: "♟", bn: "♞", bb: "♝", br: "♜", bq: "♛", bk: "♚",
};

interface BoardProps {
  fen: string;
  disabled?: boolean;
  /** Called with the candidate move the user picked. This is the ONLY way a
   * move reaches the game state — there is no free-text or coordinate input,
   * so illegal moves are unreachable through the UI by construction. */
  onMove: (candidate: CandidateMove) => void;
}

export function Board({ fen, disabled, onMove }: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);

  // A new position (move made, game reset) invalidates the old selection.
  useEffect(() => {
    setSelected(null);
  }, [fen]);

  const board = useMemo(() => new Chess(fen).board(), [fen]);
  const legalFromSelected: CandidateMove[] = useMemo(
    () => (selected ? getLegalMoves(fen, selected) : []),
    [fen, selected]
  );
  const destinationSquares = new Set(legalFromSelected.map((m) => m.to));

  function handleSquareClick(square: string) {
    if (disabled) return;

    if (selected && destinationSquares.has(square)) {
      // Several promotion candidates can share one destination square
      // (knight/bishop/rook/queen). Prefer the queen entry when present so
      // the auto-queen simplification below is a no-op for the common case.
      const queenFirst = [...legalFromSelected].sort((a, b) =>
        a.to === square && b.to === square
          ? (b.promotion === "q" ? 1 : 0) - (a.promotion === "q" ? 1 : 0)
          : 0
      );
      const candidate = queenFirst.find((m) => m.to === square)!;
      // Simplification: auto-queen on promotion. A promotion picker can be
      // added later; the underlying data model already supports it
      // (CandidateMove.promotion).
      const finalCandidate =
        candidate.isPromotion && !candidate.id.match(/[a-h][1-8][a-h][1-8]q$/)
          ? { ...candidate, id: `${candidate.from}${candidate.to}q`, promotion: "q" }
          : candidate;
      onMove(finalCandidate);
      setSelected(null);
      return;
    }

    setSelected((prev) => (prev === square ? null : square));
  }

  return (
    <div className="board" role="grid" aria-label="Chess board">
      {RANKS.map((rank, rankIdx) =>
        FILES.map((file, fileIdx) => {
          const square = `${file}${rank}`;
          const cell = board[rankIdx][fileIdx];
          const isDark = (rankIdx + fileIdx) % 2 === 1;
          const isSelected = selected === square;
          const isDestination = destinationSquares.has(square);

          return (
            <button
              key={square}
              className={[
                "square",
                isDark ? "dark" : "light",
                isSelected ? "selected" : "",
                isDestination ? "destination" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => handleSquareClick(square)}
              aria-label={square}
            >
              {cell ? (
                <span className={`piece ${cell.color === "w" ? "piece-white" : "piece-black"}`}>{UNICODE_PIECES[`${cell.color}${cell.type}`]}</span>
              ) : (
                isDestination && <span className="dot" />
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
