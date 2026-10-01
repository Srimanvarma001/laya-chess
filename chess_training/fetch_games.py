"""Stream the start of a Lichess monthly database file and keep strong, non-bullet games.

The monthly .pgn.zst files are tens of GB; this reads them as a stream and stops
once --max-games games pass the filter, so only a few MB are ever downloaded.
Lichess database files are CC0.

Usage:
    python fetch_games.py --month 2025-08 --max-games 1500 --out data/games.pgn
"""
from __future__ import annotations

import argparse
import io
import urllib.request

import chess.pgn
import zstandard

URL = "https://database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst"


def base_seconds(tc: str) -> int:
    try:
        return int(tc.split("+")[0])
    except ValueError:  # "-" = correspondence
        return 0


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--month", default="2025-08")
    ap.add_argument("--max-games", type=int, default=1500)
    ap.add_argument("--min-elo", type=int, default=2000, help="both players must be at least this")
    ap.add_argument("--min-base-seconds", type=int, default=180, help="drop bullet")
    ap.add_argument("--min-plies", type=int, default=30)
    ap.add_argument("--out", default="data/games.pgn")
    args = ap.parse_args()

    req = urllib.request.Request(URL.format(month=args.month), headers={"User-Agent": "laya-chess-prototype"})
    kept = scanned = 0
    with urllib.request.urlopen(req) as resp, open(args.out, "w", encoding="utf-8") as out:
        reader = zstandard.ZstdDecompressor().stream_reader(resp)
        text = io.TextIOWrapper(reader, encoding="utf-8", errors="replace")
        while kept < args.max_games:
            game = chess.pgn.read_game(text)
            if game is None:
                break
            scanned += 1
            h = game.headers
            try:
                elos = int(h.get("WhiteElo", "0")), int(h.get("BlackElo", "0"))
            except ValueError:
                continue
            if min(elos) < args.min_elo or base_seconds(h.get("TimeControl", "-")) < args.min_base_seconds:
                continue
            if h.get("Termination") != "Normal" or len(list(game.mainline_moves())) < args.min_plies:
                continue
            print(game, file=out, end="\n\n")
            kept += 1
            if kept % 250 == 0:
                print(f"kept {kept} / scanned {scanned}", flush=True)
    print(f"done: kept {kept} games out of {scanned} scanned -> {args.out}")


if __name__ == "__main__":
    main()
