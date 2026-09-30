"""
Local Laya latency benchmark (sections 16-18 of PROJECT.md).

Runs, in order:
  Test 1 — single decision: cold call then warm calls
  Test 2 — batch size sweep: 1 / 5 / 10 / 20 / 30 synthetic options
  Test 4 — real chess positions from docs/experiments/positions.json,
           using python-chess to generate the actual legal-move candidate set

Skips Test 3 (CPU vs CUDA) and Test 5 (reference-engine comparison) — those
need two server runs / a separate engine and are meant to be done by hand
first; see GETTING_STARTED.md.

Usage:
    pip install -r scripts/requirements.txt
    python scripts/benchmark_laya.py --base-url http://127.0.0.1:8000
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import chess
except ImportError:
    chess = None  # Test 4 is skipped with a clear message if this is missing.


def post_json(url: str, payload: dict, api_key: str | None, timeout: float = 60.0):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    elapsed_ms = (time.perf_counter() - start) * 1000
    return body, elapsed_ms


def synthetic_choice_payload(n_options: int) -> dict:
    criteria = {f"opt_{i}": f"synthetic option {i}" for i in range(n_options)}
    return {
        "state": {"body": "benchmark probe, ignore content"},
        "questions": {"pick": {"type": "choice", "instructions": "pick one", "criteria": criteria}},
    }


def chess_choice_payload(fen: str) -> tuple[dict, int]:
    board = chess.Board(fen)
    criteria = {}
    for move in board.legal_moves:
        san = board.san(move)
        criteria[move.uci()] = san
    payload = {
        "state": {"fen": fen},
        "questions": {
            "best_move": {
                "type": "choice",
                "instructions": "Which move is best for the side to move?",
                "criteria": criteria,
            }
        },
    }
    return payload, len(criteria)


def run_single_decision_test(base_url: str, api_key: str | None) -> None:
    print("\n=== Test 1: single decision (cold vs warm) ===")
    payload = synthetic_choice_payload(1)
    try:
        _, cold_ms = post_json(f"{base_url}/v1/systemone", payload, api_key)
    except urllib.error.URLError as e:
        print(f"FAILED: {e}")
        return
    print(f"cold call:  {cold_ms:.1f} ms")

    warm_times = []
    for _ in range(5):
        _, ms = post_json(f"{base_url}/v1/systemone", payload, api_key)
        warm_times.append(ms)
    print(f"warm calls: {[f'{t:.1f}' for t in warm_times]} ms")
    print(f"warm mean:  {statistics.mean(warm_times):.1f} ms")


def run_batch_size_test(base_url: str, api_key: str | None) -> None:
    print("\n=== Test 2: batch size sweep ===")
    for n in (1, 5, 10, 20, 30):
        payload = synthetic_choice_payload(n)
        try:
            _, ms = post_json(f"{base_url}/v1/systemone", payload, api_key)
        except urllib.error.URLError as e:
            print(f"  {n:>2} options -> FAILED: {e}")
            continue
        print(f"  {n:>2} options -> {ms:.1f} ms")


def run_real_position_test(base_url: str, api_key: str | None) -> None:
    print("\n=== Test 4: real chess positions ===")
    if chess is None:
        print("python-chess not installed. Run: pip install -r scripts/requirements.txt")
        return

    positions_path = Path(__file__).resolve().parent.parent / "docs" / "experiments" / "positions.json"
    if not positions_path.exists():
        print(f"{positions_path} not found. Run: python scripts/generate_positions.py first.")
        return

    positions = json.loads(positions_path.read_text())
    for pos in positions:
        payload, n_candidates = chess_choice_payload(pos["fen"])
        try:
            body, ms = post_json(f"{base_url}/v1/systemone", payload, api_key)
        except urllib.error.URLError as e:
            print(f"  {pos['id']:<25} FAILED: {e}")
            continue
        print(f"  {pos['id']:<25} {n_candidates:>2} legal moves -> {ms:.1f} ms")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()

    run_single_decision_test(args.base_url, args.api_key)
    run_batch_size_test(args.base_url, args.api_key)
    run_real_position_test(args.base_url, args.api_key)

    print("\nDone. Record these numbers in docs/experiments/ before changing anything else,")
    print("so later CPU-thread / CUDA / model-choice changes have a baseline to compare to.")


if __name__ == "__main__":
    main()
