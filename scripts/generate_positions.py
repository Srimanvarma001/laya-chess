"""
Produces a small, fixed, reproducible set of benchmark FEN positions covering
opening / middlegame / tactical / endgame / many-legal-moves / few-legal-moves
cases (section 16, Test 4). Writes them to docs/experiments/positions.json so
benchmark_laya.py and manual testing can reuse the exact same set.

Usage:
    python scripts/generate_positions.py
"""

import json
from pathlib import Path

POSITIONS = [
    {
        "id": "startpos",
        "label": "Opening — starting position (many legal moves)",
        "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    },
    {
        "id": "italian_middlegame",
        "label": "Middlegame — Italian-ish structure",
        "fen": "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQ1RK1 w kq - 4 6",
    },
    {
        "id": "tactic_fork",
        "label": "Tactical — knight fork available",
        "fen": "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4",
    },
    {
        "id": "back_rank_mate_pattern",
        "label": "Tactical — back-rank mate pattern",
        "fen": "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1",
    },
    {
        "id": "kp_endgame",
        "label": "Endgame — king and pawn",
        "fen": "8/8/4k3/8/4P3/4K3/8/8 w - - 0 1",
    },
    {
        "id": "rook_endgame",
        "label": "Endgame — rook endgame",
        "fen": "8/8/8/4k3/8/8/4K3/R7 w - - 0 1",
    },
    {
        "id": "few_legal_moves",
        "label": "Few legal moves — king heavily restricted",
        "fen": "7k/8/6K1/8/8/8/8/7R b - - 0 1",
    },
]


def main() -> None:
    out_path = Path(__file__).resolve().parent.parent / "docs" / "experiments" / "positions.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(POSITIONS, indent=2))
    print(f"Wrote {len(POSITIONS)} positions to {out_path}")


if __name__ == "__main__":
    main()
