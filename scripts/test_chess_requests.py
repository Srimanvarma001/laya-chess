"""
Smoke test for the Laya server (see README.md, "Other commands").

First verifies /health, then sends ONE simple non-chess typed decision to
confirm the server, JSON handling, and response shape work before any chess
logic gets involved (section 9 of PROJECT.md).

Usage:
    python scripts/test_chess_requests.py
    python scripts/test_chess_requests.py --base-url http://127.0.0.1:8000
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_json(url: str, payload: dict, api_key: str | None, timeout: float = 30.0) -> tuple[dict, float]:
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--api-key", default=None)
    args = parser.parse_args()

    print(f"1) Checking {args.base_url}/health ...")
    try:
        health = get(f"{args.base_url}/health")
        print("   OK:", health)
    except urllib.error.URLError as e:
        print(f"   FAILED to reach Laya: {e}")
        print("   Is `laya-serve` running? See the 'Run it' section of README.md.")
        return 1

    print("2) Sending one simple non-chess typed decision ...")
    payload = {
        "state": {"body": "billed twice, refund please or we cancel"},
        "questions": {
            "dept": {
                "type": "choice",
                "instructions": "which team?",
                "criteria": {"billing": "refunds", "tech": "bugs"},
            }
        },
    }
    try:
        body, elapsed_ms = post_json(f"{args.base_url}/v1/systemone", payload, args.api_key)
    except urllib.error.URLError as e:
        print(f"   FAILED: {e}")
        return 1

    print(f"   Response ({elapsed_ms:.1f} ms total):")
    print(json.dumps(body, indent=2))
    print()
    print("If this printed a structured decision, the server is working.")
    print("Next: run scripts/benchmark_laya.py, then wire up the frontend.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
