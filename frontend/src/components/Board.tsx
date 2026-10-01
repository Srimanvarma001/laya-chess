import { useEffect, useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Chess } from "chess.js";
import type { CandidateMove, GhostInfo } from "../types";
import { getLegalMoves } from "../chess/engine";
import { getSquareSizePx, isKnightJump, knightCorner, squareCenter } from "./MoveTrails";

/** Piece artwork set under frontend/public/pieces/. Change one line to try another set. */
export const PIECE_SET = "cburnett";

/** "wp" / "bN" (any case) -> "/pieces/cburnett/wP.svg" (files use uppercase type). */
function pieceSrc(pieceKey: string): string {
  const color = pieceKey[0];
  const type = pieceKey.slice(1).toUpperCase();
  return `/pieces/${PIECE_SET}/${color}${type}.svg`;
}

/** Slide durations — keep in sync with .move-anim / .move-knight in styles.css. */
export const MOVE_SLIDE_MS = 380;
export const MOVE_KNIGHT_MS = 620;

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"];

interface BoardProps {
  fen: string;
  disabled?: boolean;
  /** Optional overlay (e.g. <MoveTrails/>) layered exactly on top of the grid. */
  overlay?: ReactNode;
  /** Ghost previews keyed by destination square: translucent glowing mover. */
  ghostPieces?: Map<string, GhostInfo>;
  /** Pulse ghosts in sync with the considering trails animation. */
  ghostPulse?: boolean;
  /** Squares whose ghosts stay pinned (no blink) while the piece hops to them. */
  landingSquares?: Set<string>;
  /** Last played move: square tint (from+to) + glyph slides from->to once, then rests. */
  lastMove?: { from: string; to: string; pieceKey: string; key: number } | null;
  /** Decision top pick: its from/to squares get the same cyan tint even when
   * no fresh slide just played there (e.g. the illegal-pick error path). */
  topPick?: { from: string; to: string } | null;
  /** Called with the candidate move the user picked. This is the ONLY way a
   * move reaches the game state — there is no free-text or coordinate input,
   * so illegal moves are unreachable through the UI by construction. */
  onMove: (candidate: CandidateMove) => void;
}

export function Board({
  fen,
  disabled,
  onMove,
  overlay,
  ghostPieces,
  ghostPulse,
  landingSquares,
  lastMove,
  topPick,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // Active slide animation: hides the static destination glyph while the
  // animated copy glides ALONG its trail line (MOVE_SLIDE_MS straight,
  // MOVE_KNIGHT_MS knight L-hop). Keyed so each new move re-triggers.
  // useLayoutEffect, not useEffect: the new FEN already has the piece on its
  // destination, so the swap to the sliding copy must happen before the
  // browser paints, or the piece flashes at the destination for a frame and
  // then jumps back to its origin to start the slide.
  const [anim, setAnim] = useState<typeof lastMove>(null);
  useLayoutEffect(() => {
    if (!lastMove) {
      setAnim(null);
      return;
    }
    setAnim(lastMove);
    // Slightly past the CSS duration: the copy holds its end pose
    // (animation-fill-mode: forwards) exactly over the static glyph, so the
    // hand-off back to the real piece is invisible.
    const t = window.setTimeout(() => setAnim(null), MOVE_KNIGHT_MS + 60);
    return () => window.clearTimeout(t);
  }, [lastMove]);

  // A new position (move made, game reset) invalidates the old selection.
  useEffect(() => {
    setSelected(null);
  }, [fen]);

  const board = useMemo(() => new Chess(fen).board(), [fen]);
  // King square of the side to move when it is in check -> soft red glow.
  const checkSquare = useMemo(() => {
    try {
      const chess = new Chess(fen);
      if (!chess.inCheck()) return null;
      const turn = chess.turn();
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          const cell = board[r][f];
          if (cell && cell.type === "k" && cell.color === turn) {
            return `${FILES[f]}${RANKS[r]}`;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }, [fen, board]);
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
    <div className="board-stack">
      <div className="board" role="grid" aria-label="Chess board">
      {RANKS.map((rank, rankIdx) =>
        FILES.map((file, fileIdx) => {
          const square = `${file}${rank}`;
          const cell = board[rankIdx][fileIdx];
          const isDark = (rankIdx + fileIdx) % 2 === 1;
          const isSelected = selected === square;
          const isDestination = destinationSquares.has(square);
          const isLastMove = lastMove != null && (square === lastMove.from || square === lastMove.to);
          const isTopPick = topPick != null && (square === topPick.from || square === topPick.to);
          const isCheck = checkSquare === square;
          const isCapture = isDestination && cell != null;

          const ghost = ghostPieces?.get(square);

          return (
            <button
              key={square}
              className={[
                "square",
                isDark ? "dark" : "light",
                isSelected ? "selected" : "",
                isDestination ? "destination" : "",
                isLastMove || isTopPick ? "last-move" : "",
                isCheck ? "in-check" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => handleSquareClick(square)}
              aria-label={square}
            >
              {/* chess.com-style inside-edge coordinates: ranks down the
                  a-file (top-left), files along rank 1 (bottom-right), in
                  the opposite color of the square. */}
              {fileIdx === 0 && (
                <span className="coord coord-rank" aria-hidden="true">
                  {rank}
                </span>
              )}
              {rank === "1" && (
                <span className="coord coord-file" aria-hidden="true">
                  {file}
                </span>
              )}
              {cell ? (
                <span
                  className={`piece${
                    anim && square === anim.to ? " piece-hidden" : ""
                  }`}
                >
                  <img
                    className="piece-img"
                    src={pieceSrc(`${cell.color}${cell.type}`)}
                    alt=""
                    draggable={false}
                  />
                </span>
              ) : (
                isDestination && <span className="dot" aria-hidden="true" />
              )}
              {isCapture && <span className="capture-ring" aria-hidden="true" />}
              {ghost && (() => {
                // Landing ghost: pinned solid at the destination while the
                // piece hops to it — no blink, dissolves on arrival.
                const isLanding = landingSquares?.has(square) ?? false;
                return (
                  <span
                    className={[
                      "ghost",
                      ghost.tier >= 0 ? `ghost-tier-${ghost.tier}` : "",
                      isLanding ? "ghost-landing" : ghostPulse ? "ghost-pulse" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-hidden="true"
                  >
                    <img
                      className="ghost-img"
                      src={pieceSrc(ghost.pieceKey)}
                      alt=""
                      draggable={false}
                    />
                  </span>
                );
              })()}
            </button>
          );
        })
      )}
      </div>
      {overlay}
      {anim && (() => {
        const a = squareCenter(anim.from);
        const b = squareCenter(anim.to);
        const half = getSquareSizePx() / 2;
        // Knights hop the L (long leg first) to their waiting ghost —
        // same corner as the trail polyline so glyph rides the line.
        const knight = isKnightJump(anim.from, anim.to);
        const mid = knight ? knightCorner(a, b) : null;
        const style = {
          "--move-fx": `${a.x - half}px`,
          "--move-fy": `${a.y - half}px`,
          "--move-tx": `${b.x - half}px`,
          "--move-ty": `${b.y - half}px`,
          ...(mid
            ? {
                "--move-mx": `${mid.x - half}px`,
                "--move-my": `${mid.y - half}px`,
              }
            : {}),
        } as CSSProperties;
        return (
          <span
            key={anim.key}
            className={`move-anim${knight ? " move-knight" : ""}`}
            style={style}
            aria-hidden="true"
          >
            <img
              className="move-anim-img"
              src={pieceSrc(anim.pieceKey)}
              alt=""
              draggable={false}
            />
          </span>
        );
      })()}
    </div>
  );
}
