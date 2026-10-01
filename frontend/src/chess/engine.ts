import { Chess, type Move } from "chess.js";
import type {
  CandidateMove,
  GameSnapshot,
  MaterialBalance,
  MaterialEval,
  MaterialVerdict,
  SettledMaterial,
} from "../types";

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

/** Piece sitting on a square ({ type: "p"|"n"|..., color: "w"|"b" }), or null. */
export function getPieceAt(fen: string, square: string): { type: string; color: string } | null {
  const piece = new Chess(fen).get(square as any);
  return piece ? { type: piece.type, color: piece.color } : null;
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

  // Tied moves share a rank (1 + how many moves are strictly better). Most
  // quiet moves tie at delta 0, and the heuristic has no preference among
  // them, so giving them distinct ranks by move order would invent one.
  return evals.map((e) => ({
    ...e,
    rank: 1 + evals.filter((o) => o.materialDelta > e.materialDelta).length,
  }));
}

/**
 * What the one-ply material check can say about a pick:
 *   "agree"     -- the pick is tied for the best material delta
 *   "disagree"  -- some other move wins more material in one ply
 *   "no_signal" -- every candidate ties (or the pick is not a candidate), so
 *                  the check cannot tell moves apart and must not be scored
 */
export function materialVerdict(
  evals: MaterialEval[],
  pickId: string | null
): MaterialVerdict {
  const pick = evals.find((e) => e.candidateId === pickId);
  if (!pick) return "no_signal";
  const deltas = evals.map((e) => e.materialDelta);
  const best = Math.max(...deltas);
  if (Math.min(...deltas) === best) return "no_signal";
  return pick.materialDelta === best ? "agree" : "disagree";
}

/** Depth cap (plies of captures) and node budget for evaluateSettledMaterial. */
const SETTLE_MAX_PLIES = 20;
const SETTLE_MAX_NODES = 500;
/** Score for a forced mate found inside the capture search (side to move is mated). */
export const SETTLE_MATE = 100;

/**
 * Material balance once the captures on the board have played out, with zero
 * AI: a capture-only (quiescence) search over the same piece values as
 * computeMaterial. Static material only changes after a piece is taken, so a
 * queen left hanging reads "+0"; this reads "-9" as soon as it can be won.
 *
 * The side to move may also decline every capture (stand pat), so a piece
 * that is attacked but can still be moved away is not counted as lost. In
 * check there is no standing pat: every evasion is searched.
 *
 * `diff` is white minus black. `complete` is false when the depth cap or node
 * budget cut the search short, so the number is a bound, not the settled value.
 */
export function evaluateSettledMaterial(fen: string): SettledMaterial {
  const chess = new Chess(fen);
  const start = computeMaterial(fen);
  const fromMover = chess.turn() === "w" ? start.diff : -start.diff;
  let nodes = 0;
  let complete = true;

  // Moves are read as SAN strings, not verbose Move objects: chess.js builds
  // two FENs per verbose move, which measured ~14x slower per node and made
  // this too slow for the UI thread. A SAN has all that is needed here.
  const describe = (san: string) => {
    const target = san.match(/([a-h][1-8])(?:=[NBRQ])?[+#]?$/)?.[1];
    const promo = san.match(/=([NBRQ])/)?.[1].toLowerCase();
    let gain = promo ? PIECE_VALUES[promo] - PIECE_VALUES.p : 0;
    if (san.includes("x") && target) {
      // Empty target square on a capture = en passant, which takes a pawn.
      gain += PIECE_VALUES[chess.get(target as any)?.type ?? "p"];
    }
    const mover = /^[NBRQK]/.test(san) ? PIECE_VALUES[san[0].toLowerCase()] : PIECE_VALUES.p;
    return { san, gain, noisy: san.includes("x") || Boolean(promo), order: gain * 10 - mover };
  };

  // Negamax: `balance` and the return value are from the side to move's view.
  function search(balance: number, alpha: number, beta: number, pliesLeft: number): number {
    const inCheck = chess.inCheck();
    let best = -Infinity;
    if (!inCheck) {
      // Stand pat before generating moves: move generation is the expensive
      // part in chess.js, and most nodes cut off right here.
      best = balance;
      if (best >= beta) return best;
      alpha = Math.max(alpha, best);
    }
    if (pliesLeft === 0 || nodes >= SETTLE_MAX_NODES) {
      complete = false;
      return balance;
    }
    nodes += 1;
    const moves = chess.moves().map(describe);
    if (moves.length === 0) return inCheck ? -SETTLE_MATE : balance;
    const noisy = inCheck ? moves : moves.filter((m) => m.noisy);
    // Biggest win for the cheapest attacker first, so cutoffs come early.
    noisy.sort((a, b) => b.order - a.order);
    for (const m of noisy) {
      chess.move(m.san);
      const score = -search(-(balance + m.gain), -beta, -alpha, pliesLeft - 1);
      chess.undo();
      if (score > best) best = score;
      if (best >= beta) break;
      alpha = Math.max(alpha, best);
      if (nodes >= SETTLE_MAX_NODES) {
        complete = false;
        break;
      }
    }
    return best;
  }

  const value = search(fromMover, -Infinity, Infinity, SETTLE_MAX_PLIES);
  return { diff: chess.turn() === "w" ? value : -value, complete };
}
