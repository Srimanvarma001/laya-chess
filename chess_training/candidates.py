"""Shared source of truth for candidate filtering, state text and option labels.

Copied verbatim from the appendix of Laya_Chess_Training_Guide.pdf. Training data,
evaluation and (later) the TypeScript app must all build questions with exactly
this logic -- see the guide's Part D parity checklist.
"""
import chess

PIECE_VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3,
               chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}
PIECE_LETTER = {chess.PAWN: "", chess.KNIGHT: "N", chess.BISHOP: "B",
                chess.ROOK: "R", chess.QUEEN: "Q", chess.KING: "K"}


def _centrality(sq: int) -> float:
    f, r = chess.square_file(sq), chess.square_rank(sq)
    return 3.5 - max(abs(f - 3.5), abs(r - 3.5))


def move_priority(board: chess.Board, move: chess.Move) -> float:
    """Cheap heuristic: promotions > captures (MVV-LVA) > checks > centralising moves."""
    score = 0.0
    piece = board.piece_at(move.from_square)
    if move.promotion:
        score += 1000 + PIECE_VALUE[move.promotion]
    if board.is_capture(move):
        victim = PIECE_VALUE[chess.PAWN] if board.is_en_passant(move) else \
            PIECE_VALUE[board.piece_at(move.to_square).piece_type]
        score += 100 + 10 * victim - PIECE_VALUE[piece.piece_type]
    if board.gives_check(move):
        score += 50
    if board.is_castling(move):
        score += 20
    score += _centrality(move.to_square) - _centrality(move.from_square)
    return score


def candidate_moves(board: chess.Board, k: int = 16) -> list[chess.Move]:
    legal = list(board.legal_moves)
    if len(legal) <= k:
        return sorted(legal, key=lambda m: m.uci())
    ranked = sorted(legal, key=lambda m: (-move_priority(board, m), m.uci()))
    return sorted(ranked[:k], key=lambda m: m.uci())


def state_text(board: chess.Board) -> str:
    """Compact, explicit state: side to move + piece lists + castling/en-passant.
    (Piece lists are easier for a text encoder than FEN's run-length digits.
    Compare against plain FEN in your experiments.)"""
    def side(color):
        order = [chess.KING, chess.QUEEN, chess.ROOK, chess.BISHOP, chess.KNIGHT, chess.PAWN]
        parts = []
        for pt in order:
            for sq in sorted(board.pieces(pt, color)):
                parts.append(f"{PIECE_LETTER[pt] or 'P'}{chess.square_name(sq)}")
        return " ".join(parts)
    turn = "White" if board.turn == chess.WHITE else "Black"
    ep = chess.square_name(board.ep_square) if board.ep_square is not None else "-"
    return (f"{turn} to move. White: {side(chess.WHITE)}. Black: {side(chess.BLACK)}. "
            f"Castling: {board.castling_xfen()}. En passant: {ep}. FEN: {board.fen()}")


def option_label(board: chess.Board, move: chess.Move) -> str:
    tags = []
    if board.is_capture(move):
        tags.append("capture")
    if board.gives_check(move):
        tags.append("check")
    if move.promotion:
        tags.append("promotion")
    san = board.san(move)
    return f"{san} ({', '.join(tags)})" if tags else san
