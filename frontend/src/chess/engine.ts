import { Chess, type Move } from "chess.js";
import type { CandidateMove, GameSnapshot, MaterialBalance, MaterialEval } from "../types";

// Section 10/23 of PROJECT.md: all deterministic chess logic (legality, FEN,
// material, game state) lives here and never touches Laya. This is the single
// source of truth the UI and the Laya API adapter both read from.

const PIECE_VALUES: Record<string, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export function computeMaterial(fen: string): MaterialBalance {
  const board = new Chess(fen).board();
  let white = 0;
  let black = 0;
  for (const row of board) {
    for (const cell of row) {
      if (!cell) continue;
      const value = PIECE_VALUES[cell.type] ?? 0;
      if (cell.color === "w") white += value;
      else black += value;
    }
  }
  return { white, black, diff: white - black };
}

function toCandidateMove(move: Move): CandidateMove {
  const promoSuffix = move.promotion ? move.promotion : "";
  return {
    id: `${move.from}${move.to}${promoSuffix}`,
    from: move.from,
    to: move.to,
    san: move.san,
    isCapture: move.flags.includes("c") || move.flags.includes("e"),
    isCheck: move.san.includes("+") || move.san.includes("#"),
    isPromotion: Boolean(move.promotion),
    promotion: move.promotion,
  };
}

/** Legal moves for the position, exactly what layer 1 filtering (section 12) hands onward. */
export function getLegalMoves(fen: string, fromSquare?: string): CandidateMove[] {
  const chess = new Chess(fen);
  const moves = fromSquare
    ? chess.moves({ square: fromSquare as any, verbose: true })
    : chess.moves({ verbose: true });
  return (moves as Move[]).map(toCandidateMove);
}

export function getSnapshot(fen: string, history: string[] = []): GameSnapshot {
  const chess = new Chess(fen);
  return {
    fen,
    turn: chess.turn(),
    legalMoves: getLegalMoves(fen),
    material: computeMaterial(fen),
    isCheck: chess.inCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isGameOver: chess.isGameOver(),
    history,
  };
}

/** Applies a move by candidate id ("e2e4", "e7e8q", ...) and returns the new snapshot. */
export function applyMove(fen: string, history: string[], candidateId: string): GameSnapshot {
  const chess = new Chess(fen);
  const from = candidateId.slice(0, 2);
  const to = candidateId.slice(2, 4);
  const promotion = candidateId.length > 4 ? candidateId.slice(4) : undefined;
  // chess.js v1 throws on illegal moves instead of returning null, so wrap
  // it to keep a single, position-aware error type for the UI.
  try {
    const result = chess.move({ from, to, promotion });
    if (!result) {
      throw new Error(`Illegal move attempted: ${candidateId} on ${fen}`);
    }
    return getSnapshot(chess.fen(), [...history, result.san]);
  } catch (err) {
    if ((err as Error).message.startsWith("Illegal move attempted")) throw err;
    throw new Error(`Illegal move attempted: ${candidateId} on ${fen}`);
  }
}

export function startingSnapshot(): GameSnapshot {
  const chess = new Chess();
  return getSnapshot(chess.fen(), []);
}

/**
 * Section 9 / calibration panel: one-ply material evaluation for every legal
 * candidate move, computed with zero AI involvement. This is what Laya's
 * claimed confidence gets checked against.
 */
export function evaluateCandidatesByMaterial(
  fen: string,
  candidates: CandidateMove[]
): MaterialEval[] {
  const chess = new Chess(fen);
  const sideToMove = chess.turn(); // "w" | "b"
  const beforeMaterial = computeMaterial(fen);
  const before = sideToMove === "w" ? beforeMaterial.white - beforeMaterial.black
                                     : beforeMaterial.black - beforeMaterial.white;

  const evals: Omit<MaterialEval, "rank">[] = candidates.map((c) => {
    const probe = new Chess(fen);
    const promotion = c.promotion;
    probe.move({ from: c.from, to: c.to, promotion });
    const afterMaterial = computeMaterial(probe.fen());
    const after = sideToMove === "w" ? afterMaterial.white - afterMaterial.black
                                      : afterMaterial.black - afterMaterial.white;
    return { candidateId: c.id, materialDelta: after - before };
  });

  const sorted = [...evals].sort((a, b) => b.materialDelta - a.materialDelta);
  const rankById = new Map(sorted.map((e, i) => [e.candidateId, i + 1]));

  return evals.map((e) => ({ ...e, rank: rankById.get(e.candidateId)! }));
}
