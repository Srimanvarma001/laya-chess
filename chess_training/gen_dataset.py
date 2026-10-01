"""Sample positions from PGN games and label them with Stockfish.

Follows Step 5 of Laya_Chess_Training_Guide.pdf, with one change: instead of a
restricted-multipv search over the K candidates plus a second full search for
recall, it runs ONE multipv search over every legal move. That scores all legal
moves, so the same labels serve both the guide's top-K candidate set and the
app's current "every legal move" request, and filter recall falls out for free.

Splits are by game (sha1 of the game's Site URL): train 80 / calib 10 / test 10.
The split of a game never depends on which splits you ask to label, so a test set
built now stays disjoint from any training set generated later.

Usage:
    python gen_dataset.py --pgn data/games.pgn --stockfish ../tools/stockfish/stockfish-windows-x86-64-universal.exe \
        --out data --splits test --positions-per-game 2 --depth 12 --workers 4
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import time
from multiprocessing import Pool
from pathlib import Path

import chess
import chess.engine
import chess.pgn

from candidates import candidate_moves, option_label, state_text

MATE_CP = 10000
SOFT_CLAMP = 1500  # mate scores are clamped before the soft distribution

_engine: chess.engine.SimpleEngine | None = None
_cfg: dict = {}


def split_of(game_id: str) -> str:
    bucket = int(hashlib.sha1(game_id.encode()).hexdigest(), 16) % 100
    return "train" if bucket < 80 else "calib" if bucket < 90 else "test"


def _init_worker(stockfish: str, cfg: dict) -> None:
    global _engine, _cfg
    _cfg = cfg
    _engine = chess.engine.SimpleEngine.popen_uci(stockfish)
    _engine.configure({"Threads": 1, "Hash": 64})


def score_all_moves(board: chess.Board) -> dict[str, int] | None:
    legal = list(board.legal_moves)
    infos = _engine.analyse(board, chess.engine.Limit(depth=_cfg["depth"]), multipv=len(legal))
    scores = {}
    for info in infos:
        if "pv" in info and "score" in info:
            scores[info["pv"][0].uci()] = info["score"].pov(board.turn).score(mate_score=MATE_CP)
    return scores if len(scores) == len(legal) else None


def label_game(job: tuple[str, str, list[str]]) -> list[dict]:
    game_id, split, ucis = job
    rng = random.Random(game_id)
    lo = _cfg["min_ply"]
    plies = [p for p in range(lo, len(ucis)) if p % 1 == 0]
    rng.shuffle(plies)
    rows = []
    for ply in plies:
        if len(rows) >= _cfg["positions_per_game"]:
            break
        board = chess.Board()
        for u in ucis[:ply]:
            board.push_uci(u)
        if board.is_game_over() or board.legal_moves.count() < 2:
            continue
        scores = score_all_moves(board)
        if scores is None:
            continue
        true_best = max(scores, key=lambda u: (scores[u], u))
        if abs(scores[true_best]) > _cfg["max_abs_cp"]:
            continue  # already decided; labels there are mostly noise (guide step 5.3)
        cands = candidate_moves(board, _cfg["k"])
        cand_ids = [m.uci() for m in cands]
        best_cp = max(scores[u] for u in cand_ids)
        best = min(u for u in cand_ids if scores[u] == best_cp)
        weights = [math.exp((max(-SOFT_CLAMP, scores[u]) - min(SOFT_CLAMP, best_cp)) / 100) for u in cand_ids]
        total = sum(weights)
        rows.append({
            "game_id": game_id,
            "split": split,
            "ply": ply,
            "fen": board.fen(),
            "state": state_text(board),
            "options": [{"id": m.uci(), "label": option_label(board, m)} for m in cands],
            "cp": {u: scores[u] for u in cand_ids},
            "best": best,
            "soft": [round(w / total, 6) for w in weights],
            "legal": [{"id": m.uci(), "label": option_label(board, m)} for m in board.legal_moves],
            "legal_cp": scores,
            "true_best": true_best,
            "filter_recall_hit": true_best in cand_ids,
        })
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pgn", required=True)
    ap.add_argument("--stockfish", required=True)
    ap.add_argument("--out", default="data")
    ap.add_argument("--splits", default="train,calib,test")
    ap.add_argument("--max-games", type=int, default=None)
    ap.add_argument("--positions-per-game", type=int, default=6)
    ap.add_argument("--min-ply", type=int, default=8, help="skip the first N plies (book moves)")
    ap.add_argument("--depth", type=int, default=10)
    ap.add_argument("--k", type=int, default=16)
    ap.add_argument("--max-abs-cp", type=int, default=800)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    wanted = set(args.splits.split(","))
    jobs = []
    with open(args.pgn, encoding="utf-8") as f:
        while True:
            game = chess.pgn.read_game(f)
            if game is None or (args.max_games and len(jobs) >= args.max_games):
                break
            game_id = game.headers.get("Site", "")
            split = split_of(game_id)
            if split in wanted:
                jobs.append((game_id, split, [m.uci() for m in game.mainline_moves()]))
    print(f"{len(jobs)} games in splits {sorted(wanted)}; labelling at depth {args.depth} ...", flush=True)

    cfg = {k: getattr(args, k) for k in ("depth", "k", "max_abs_cp", "positions_per_game", "min_ply")}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = {s: open(out / f"{s}.jsonl", "w", encoding="utf-8") for s in wanted}
    n = hits = 0
    t0 = time.perf_counter()
    with Pool(args.workers, initializer=_init_worker, initargs=(args.stockfish, cfg)) as pool:
        for i, rows in enumerate(pool.imap(label_game, jobs), 1):
            for r in rows:
                files[r["split"]].write(json.dumps(r) + "\n")
                n += 1
                hits += r["filter_recall_hit"]
            if i % 25 == 0:
                print(f"  {i}/{len(jobs)} games, {n} positions, {time.perf_counter() - t0:.0f}s", flush=True)
    for f in files.values():
        f.close()
    print(f"done: {n} positions in {time.perf_counter() - t0:.0f}s")
    if n:
        print(f"candidate-filter recall (K={args.k}): {hits / n:.1%}  (guide target: >= 90%)")


if __name__ == "__main__":
    main()
