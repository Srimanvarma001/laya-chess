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

// Default is the Vite dev proxy path, not :8000 directly: laya-serve sends no
// CORS headers, so a direct browser call fails preflight (see vite.config.ts).
const RAW_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";
// Trailing slashes would otherwise produce "//health" / "//v1/systemone".
const BASE_URL = String(RAW_BASE_URL).replace(/\/+$/, "");

/** Short human label for the header status strip, e.g. "localhost:8000". */
export function serverLabel(): string {
  try {
    return new URL(BASE_URL, window.location.href).host || BASE_URL;
  } catch {
    return BASE_URL;
  }
}
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

/** Set once the first raw payload has been logged (field-name confirmation). */
let loggedRawShape = false;

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

function asFiniteMs(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Real server-side inference time, read off the response — never guessed.
 * Body first (the field name varies by Laya version), headers as fallback.
 * The one-time console.log below pins down which shape this server sends.
 */
function parseModelLatencyMsFromBody(raw: any): number | null {
  if (!raw || typeof raw !== "object") return null;
  const timing = (raw as any).timing;
  if (timing && typeof timing === "object") {
    for (const key of ["model_ms", "modelMs", "inference_ms", "inferenceMs", "dur_ms", "duration_ms"]) {
      const n = asFiniteMs(timing[key]);
      if (n !== null) return n;
    }
  }
  for (const key of ["model_ms", "modelMs", "model_latency_ms", "inference_ms", "inferenceMs", "latency_ms", "latencyMs"]) {
    const n = asFiniteMs((raw as any)[key]);
    if (n !== null) return n;
  }
  return null;
}

function parseModelLatencyMsFromHeaders(res: Response): number | null {
  // Header shapes a server could report inference time in:
  //   X-Inference-Time-Ms: 123.45
  //   Server-Timing: inference;dur=123.45
  // laya 0.3.20 sends neither (see decideMove below), so this returns null there.
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
 * Verified against laya 0.3.20 (laya-rl-agent on uvicorn, probed live):
 * the real response body is
 *   { model, answers: { best_move: { type, choice, probabilities,
 *     confidence, answer_confidence, action } }, usage, routing }
 * with NO timing field in the body and NO X-Inference-Time-Ms /
 * Server-Timing headers, so modelLatencyMs is null ("n/a") on this server
 * version and overheadMs with it. Parsing below still tolerates
 * older/alternative shapes (`results.best_move`, `selected`, body timing
 * fields, timing headers) so a version skew shows up as data, not a crash.
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
  // Real wall-clock breakdown for the latency readout (honesty rule: every
  // number below is a measured performance.now() delta, nothing estimated):
  //   t0 = just before fetch
  //   t1 = fetch resolved (response headers received)
  //   t2 = after res.json() completes
  const t0 = performance.now();

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
  const t1 = performance.now();

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
  const t2 = performance.now();

  // Log the untouched payload ONCE per session so the real timing field name
  // for this Laya version can be confirmed by eye (see the body parser above).
  if (!loggedRawShape) {
    loggedRawShape = true;
    console.log("[laya] raw response shape (first request):", raw);
  }

  const networkAndServerMs = t1 - t0;
  const parseMs = t2 - t1;
  const totalLatencyMs = t2 - t0;
  const modelLatencyMs = parseModelLatencyMsFromBody(raw) ?? parseModelLatencyMsFromHeaders(res);
  // Server routing, tokenizing, HTTP, JSON — whatever the total covers that
  // the server's own inference timer does not. Null (shown as "n/a") when the
  // server reports no inference time, instead of guessing.
  const overheadMs = modelLatencyMs !== null ? Math.max(0, totalLatencyMs - modelLatencyMs) : null;

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
    networkAndServerMs,
    parseMs,
    overheadMs,
    sentCandidateCount: trimmed.length,
    legalCandidateCount: candidates.length,
    confidence,
    answerConfidence,
    routingModel,
    routingReason,
    usage,
    raw,
  };
}
