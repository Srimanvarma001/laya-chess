"""Score move predictors against Stockfish labels (guide step 11).

Predictors:
  random    -- uniform over the offered options. Reported as the exact expectation, not a sample.
  material  -- the app's one-ply material baseline (engine.ts evaluateCandidatesByMaterial).
               Most moves tie at delta 0; ties are scored as the expectation over a uniform
               tie-break, because the baseline genuinely has no preference among them.
  laya      -- one batched /v1/systemone choice request per position.

Candidate sets:
  k16  -- the guide's top-K filter (candidates.py), labels via option_label
  all  -- every legal move, which is what the app sends today (all fit under its 64 cap)

Laya state formats:
  fen    -- {"fen": ...}, what layaClient.ts sends today
  text   -- {"position": state_text(board)}, the guide's format

Metrics (all relative to the best Stockfish score *within the offered set*):
  top1 / top3  -- chosen move (or top 3 by probability) scores as well as the best option
  acpl         -- mean centipawn loss, scores clamped to +/-1500 so mates don't dominate
  blunder      -- share of picks losing more than 200 cp
  ece          -- 10-bin expected calibration error of Laya's answer_confidence vs top-1 hit
  latency      -- wall-clock per request (time.perf_counter), measured, never estimated

Usage:
    python evaluate.py --test data/test.jsonl --predictor random --set k16
    python evaluate.py --test data/test.jsonl --predictor material --set all
    python evaluate.py --test data/test.jsonl --predictor laya --set k16 --state text --model typed-decisions
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import time
import urllib.request
from pathlib import Path

import chess

CLAMP = 1500
BLUNDER_CP = 200
INSTRUCTIONS = "Which move is best for the side to move in this chess position?"
MATERIAL = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9, chess.KING: 0}


def clamp(cp: int) -> int:
    return max(-CLAMP, min(CLAMP, cp))


def options_of(row: dict, cand_set: str) -> tuple[list[dict], dict[str, int]]:
    if cand_set == "k16":
        return row["options"], {u: clamp(c) for u, c in row["cp"].items()}
    return row["legal"], {u: clamp(c) for u, c in row["legal_cp"].items()}


def material_balance(board: chess.Board, color: chess.Color) -> int:
    return sum(MATERIAL[p.piece_type] * (1 if p.color == color else -1) for p in board.piece_map().values())


def expected_over_uniform(ranked_groups: list[list[str]], cp: dict[str, int], best_cp: int) -> dict:
    """Expected top1/top3/loss/blunder when picks are ordered by groups, ties broken uniformly."""
    first = ranked_groups[0]
    losses = [best_cp - cp[u] for u in first]
    top1 = sum(1 for u in first if cp[u] == best_cp) / len(first)
    # P(no best-scoring move in the first 3 slots): per group, hypergeometric miss over
    # the slots of the top 3 that the group occupies.
    miss, slots_before = 1.0, 0
    for g in ranked_groups:
        take = min(len(g), 3 - slots_before)
        if take <= 0:
            break
        n_best = sum(1 for u in g if cp[u] == best_cp)
        miss *= math.comb(len(g) - n_best, take) / math.comb(len(g), take)
        slots_before += len(g)
    return {"top1": top1, "top3": 1 - miss, "loss": statistics.mean(losses),
            "blunder": sum(l > BLUNDER_CP for l in losses) / len(losses)}


def predict_random(row, opts, cp, best_cp):
    return expected_over_uniform([[o["id"] for o in opts]], cp, best_cp)


def predict_material(row, opts, cp, best_cp):
    board = chess.Board(row["fen"])
    me = board.turn
    delta: dict[str, int] = {}
    for o in opts:
        b = board.copy(stack=False)
        b.push_uci(o["id"])
        delta[o["id"]] = material_balance(b, me)
    groups: dict[int, list[str]] = {}
    for u, d in delta.items():
        groups.setdefault(d, []).append(u)
    return expected_over_uniform([groups[d] for d in sorted(groups, reverse=True)], cp, best_cp)


def make_laya(args):
    url = args.base_url.rstrip("/") + "/v1/systemone"

    def predict_laya(row, opts, cp, best_cp):
        state = {"fen": row["fen"]} if args.state == "fen" else {"position": row["state"]}
        body = {"state": state, "questions": {"best_move": {
            "type": "choice", "instructions": INSTRUCTIONS,
            "criteria": {o["id"]: o["label"] for o in opts}}}}
        if args.model:
            body["model"] = args.model
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = json.loads(resp.read())
        ms = (time.perf_counter() - t0) * 1000
        ans = raw["answers"]["best_move"]
        probs: dict[str, float] = ans["probabilities"]
        pick = ans["choice"]
        top3 = sorted(probs, key=lambda u: -probs[u])[:3]
        loss = best_cp - cp[pick]
        return {"top1": float(cp[pick] == best_cp), "top3": float(any(cp[u] == best_cp for u in top3)),
                "loss": loss, "blunder": float(loss > BLUNDER_CP), "conf": ans.get("answer_confidence", probs[pick]),
                "ms": ms, "pick": pick, "routed": raw.get("routing", {}).get("model"),
                "tokens": raw.get("usage", {}).get("input_tokens")}

    return predict_laya


def ece(confs: list[float], hits: list[float], bins: int = 10) -> float:
    total, n = 0.0, len(confs)
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        idx = [i for i, c in enumerate(confs) if lo < c <= hi or (b == 0 and c == 0)]
        if idx:
            total += len(idx) / n * abs(statistics.mean(confs[i] for i in idx) - statistics.mean(hits[i] for i in idx))
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", default="data/test.jsonl")
    ap.add_argument("--predictor", choices=["random", "material", "laya"], required=True)
    ap.add_argument("--set", choices=["k16", "all"], default="k16")
    ap.add_argument("--state", choices=["fen", "text"], default="fen", help="laya only")
    ap.add_argument("--model", default=None, help="laya only: pin a checkpoint (english / typed-decisions)")
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")  # not localhost: +2s/request on Windows
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--results", default="results", help="directory for per-run JSON")
    args = ap.parse_args()

    rows = [json.loads(l) for l in Path(args.test).read_text(encoding="utf-8").splitlines() if l.strip()]
    rows = rows[: args.limit] if args.limit else rows
    predict = {"random": predict_random, "material": predict_material}.get(args.predictor) or make_laya(args)

    per = []
    for i, row in enumerate(rows, 1):
        opts, cp = options_of(row, args.set)
        best_cp = max(cp.values())
        r = predict(row, opts, cp, best_cp)
        r["n_options"] = len(opts)
        per.append(r)
        if args.predictor == "laya" and i % 50 == 0:
            print(f"  {i}/{len(rows)}", flush=True)

    name = args.predictor if args.predictor != "laya" else f"laya[{args.model or 'auto'},{args.state}]"
    summary = {
        "predictor": name, "set": args.set, "n": len(per),
        "mean_options": statistics.mean(p["n_options"] for p in per),
        "top1": statistics.mean(p["top1"] for p in per),
        "top3": statistics.mean(p["top3"] for p in per),
        "acpl": statistics.mean(p["loss"] for p in per),
        "blunder": statistics.mean(p["blunder"] for p in per),
    }
    if args.predictor == "laya":
        ms = sorted(p["ms"] for p in per)
        summary.update({
            "ece": ece([p["conf"] for p in per], [p["top1"] for p in per]),
            "mean_conf": statistics.mean(p["conf"] for p in per),
            "latency_median_ms": statistics.median(ms),
            "latency_p90_ms": ms[int(0.9 * (len(ms) - 1))],
            "routed_to": sorted({p["routed"] for p in per}),
            "mean_input_tokens": statistics.mean(p["tokens"] for p in per if p["tokens"] is not None),
        })
    print(json.dumps(summary, indent=2))
    out = Path(args.results)
    out.mkdir(exist_ok=True)
    tag = name.replace("[", "_").replace("]", "").replace(",", "_")
    (out / f"{tag}__{args.set}.json").write_text(json.dumps({"summary": summary, "per_position": per}, indent=1))


if __name__ == "__main__":
    main()
