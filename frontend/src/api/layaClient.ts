import type {
  CandidateMove,
  LayaDecisionResponse,
  LayaMoveScore,
} from "../types";

// This is the ONLY file in the frontend that knows Laya's request/response
// shape and its HTTP base URL. Everything else (the board, the calibration
// panel) talks to `decideMove()` below. When Phase 1's localhost:8000 becomes
// a tunnel URL and later a hosted API (section 24 / 31-33), only this file
// and the .env value should need to change.

const RAW_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
// Trailing slashes would otherwise produce "//health" / "//v1/systemone".
const BASE_URL = String(RAW_BASE_URL).replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_LAYA_API_KEY;
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Maximum candidates sent in one `choice` request. The real server rejects
 * >100 choice options with 413 (laya/serve.py MAX_CHOICE_OPTIONS), and long
 * labels share a token budget, so keep well under that. Captures, checks and
 * promotions are prioritised when trimming (PROJECT.md section 12, layer 2).
 */
export const MAX_CANDIDATES_PER_REQUEST = 64;

export class LayaUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaUnavailableError";
  }
}
export class LayaTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaTimeoutError";
  }
}
export class LayaInvalidResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayaInvalidResponseError";
  }
}

export async function checkHealth(): Promise<{ ok: boolean; raw: unknown }> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const raw = await res.json();
    return { ok: res.ok, raw };
  } catch {
    return { ok: false, raw: null };
  }
}

/**
 * Deterministic candidate reduction (PROJECT.md section 12, layer 2).
 * Keeps every move when the count is small; otherwise keeps tactical moves
 * (captures, checks, promotions) first and trims the rest. Purely
 * deterministic — no AI involved — so the result is reproducible.
 */
export function reduceCandidates(candidates: CandidateMove[]): CandidateMove[] {
  if (candidates.length <= MAX_CANDIDATES_PER_REQUEST) return candidates;
  const scored = candidates.map((c) => ({
    c,
    priority: (c.isCapture ? 4 : 0) + (c.isCheck ? 2 : 0) + (c.isPromotion ? 2 : 0),
  }));
  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, MAX_CANDIDATES_PER_REQUEST).map((s) => s.c);
}

function parseModelLatencyMs(res: Response): number | null {
  // The real server reports inference time in headers, not the body:
  //   X-Inference-Time-Ms: 123.45
  //   Server-Timing: inference;dur=123.45
  const direct = res.headers.get("X-Inference-Time-Ms");
  if (direct !== null) {
    const n = Number(direct);
    if (Number.isFinite(n)) return n;
  }
  const timing = res.headers.get("Server-Timing");
  if (timing) {
    const m = timing.match(/dur=([\d.]+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Sends ONE batched decision request for all candidate moves in a position
 * (section 11: never one HTTP call per legal move). Uses Laya's `choice`
 * typed-decision format against the Jev-compatible /v1/systemone endpoint.
 *
 * Verified against laya 0.3.20 (laya/serve.py + laya/agent.py). The real
 * response body is:
 *   { model, answers: { best_move: { type, choice, probabilities,
 *     confidence, answer_confidence, action } }, usage, routing }
 * and inference time arrives via the X-Inference-Time-Ms / Server-Timing
 * headers. Parsing below still tolerates older/alternative shapes
 * (`results.best_move`, `selected`) so a version skew shows up as data,
 * not a crash.
 */
export async function decideMove(
  fen: string,
  candidates: CandidateMove[]
): Promise<LayaDecisionResponse> {
  if (candidates.length === 0) {
    throw new LayaInvalidResponseError("No legal candidate moves were provided.");
  }

  const trimmed = reduceCandidates(candidates);
  const wasTrimmed = trimmed.length !== candidates.length;

  const criteria: Record<string, string> = {};
  for (const c of trimmed) {
    // Keep the description short and chess-specific; this is the "typed
    // question" Laya scores against, not free text generation. Short labels
    // also share the checkpoint's option token budget better (serve.py notes
    // trimming above ~20 long options).
    const tag = [c.isCapture && "capture", c.isCheck && "check", c.isPromotion && "promotion"]
      .filter(Boolean)
      .join(", ");
    criteria[c.id] = tag ? `${c.san} (${tag})` : c.san;
  }

  const body = {
    state: { fen },
    questions: {
      best_move: {
        type: "choice",
        instructions: "Which move is best for the side to move in this chess position?",
        criteria,
      },
    },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestStart = performance.now();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if ((err as Error).name === "AbortError") {
      throw new LayaTimeoutError(`Laya did not respond within ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new LayaUnavailableError("Could not reach the Laya server. Is it running?");
  }
  clearTimeout(timeout);

  const totalLatencyMs = performance.now() - requestStart;
  const modelLatencyMs = parseModelLatencyMs(res);

  if (!res.ok) {
    let detail = "";
    try {
      const errBody = await res.json();
      if (typeof errBody?.detail === "string") detail = `: ${errBody.detail}`;
    } catch {
      // ignore — fall through to the status-only message
    }
    if (res.status === 413 || res.status === 422) {
      throw new LayaInvalidResponseError(
        `Laya rejected the request (HTTP ${res.status})${detail}. ` +
          `The position sent ${trimmed.length} candidates${wasTrimmed ? ` (trimmed from ${candidates.length})` : ""}.`
      );
    }
    if (res.status === 401) {
      throw new LayaUnavailableError(
        `Laya returned HTTP 401${detail}. Check VITE_LAYA_API_KEY matches LAYA_API_KEY.`
      );
    }
    if (res.status === 503) {
      throw new LayaTimeoutError(`Laya is busy (HTTP 503)${detail}. Try again.`);
    }
    throw new LayaUnavailableError(`Laya returned HTTP ${res.status}${detail}.`);
  }

  let raw: any;
  try {
    raw = await res.json();
  } catch {
    throw new LayaInvalidResponseError("Laya response was not valid JSON.");
  }

  const answer = raw?.answers?.best_move ?? raw?.results?.best_move ?? raw?.best_move;
  const routing = raw?.routing ?? null;
  const usage =
    raw?.usage && typeof raw.usage === "object"
      ? {
          input_tokens: Number(raw.usage.input_tokens ?? 0),
          output_tokens: Number(raw.usage.output_tokens ?? 0),
        }
      : null;
  const confidence =
    typeof answer?.confidence === "number" ? answer.confidence : null;
  const answerConfidence =
    typeof answer?.answer_confidence === "number" ? answer.answer_confidence : null;
  const routingModel =
    typeof routing?.model === "string" ? routing.model : null;
  const routingReason =
    typeof routing?.reason === "string" ? routing.reason : null;

  const scores: LayaMoveScore[] = [];
  let selectedCandidateId: string | null = null;

  if (answer?.probabilities && typeof answer.probabilities === "object") {
    for (const [candidateId, rawConfidence] of Object.entries(answer.probabilities)) {
      const n = Number(rawConfidence);
      if (!Number.isFinite(n)) continue;
      // Clamp: real probabilities are 0..1, but never let a version skew
      // break the bar UI.
      scores.push({ candidateId, rawConfidence: Math.max(0, Math.min(1, n)) });
    }
    const pick = answer.choice ?? answer.selected ?? null;
    selectedCandidateId = typeof pick === "string" ? pick : null;
  }

  if (!selectedCandidateId && scores.length > 0) {
    selectedCandidateId = scores.reduce((best, s) =>
      s.rawConfidence > best.rawConfidence ? s : best
    ).candidateId;
  }

  if (scores.length === 0) {
    throw new LayaInvalidResponseError(
      "Could not find move probabilities in the Laya response. Check the console for the raw payload and update layaClient.ts's parsing."
    );
  }

  return {
    scores,
    selectedCandidateId,
    modelLatencyMs,
    totalLatencyMs,
    confidence,
    answerConfidence,
    routingModel,
    routingReason,
    usage,
    raw,
  };
}
