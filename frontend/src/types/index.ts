// Central type definitions shared across chess logic, API client, and UI.

export type Square = string; // e.g. "e4"

export interface CandidateMove {
  /** UCI-ish id used as the option key sent to Laya, e.g. "e2e4" or "e7e8q" */
  id: string;
  from: Square;
  to: Square;
  san: string; // standard algebraic notation, e.g. "Nf3", "exd5", "O-O"
  isCapture: boolean;
  isCheck: boolean;
  isPromotion: boolean;
  promotion?: string;
}

export interface MaterialBalance {
  white: number;
  black: number;
  /** white - black, positive favors white */
  diff: number;
}

/** Ghost preview on a destination square: the piece that would land there. */
export interface GhostInfo {
  /** e.g. "wp", "bn" — mover's color+type. */
  pieceKey: string;
  /** -1 = considering (uniform), 0/1/2 = resolved rank tier. */
  tier: number;
}

export interface GameSnapshot {
  fen: string;
  turn: "w" | "b";
  legalMoves: CandidateMove[];
  material: MaterialBalance;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isGameOver: boolean;
  history: string[]; // SAN move history
}

export type DecisionMode = "choice" | "score" | "noul";

export interface LayaDecisionRequest {
  fen: string;
  candidates: CandidateMove[];
  mode: DecisionMode;
}

export interface LayaMoveScore {
  candidateId: string;
  rawConfidence: number;
  calibratedConfidence?: number;
}

export interface LayaDecisionResponse {
  scores: LayaMoveScore[];
  selectedCandidateId: string | null;
  /** Real server-side inference time, when the server reports it. Null = "n/a", never guessed. */
  modelLatencyMs: number | null;
  /** Wall-clock time for the whole decideMove call: fetch + server + JSON parse. */
  totalLatencyMs: number;
  /** Time from just-before-fetch until response headers arrived (network + server). */
  networkAndServerMs: number;
  /** Time spent in res.json() after headers arrived. */
  parseMs: number;
  /** totalLatencyMs - modelLatencyMs (routing, tokenizing, HTTP, JSON). Null when modelMs is unknown. */
  overheadMs: number | null;
  /** How many candidates were actually sent in the one batched request. */
  sentCandidateCount: number;
  /** How many legal moves the scored position had (before any candidate filter). */
  legalCandidateCount: number;
  /** 1 - normalised entropy over the candidate distribution (real `confidence` field). */
  confidence: number | null;
  /** Calibrated P(reported answer is correct) — the single number to gate on. */
  answerConfidence: number | null;
  /** Which Laya checkpoint answered, e.g. "english" / "multilingual". */
  routingModel: string | null;
  routingReason: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  raw: unknown; // untouched response body, kept for debugging/calibration panel
}

export type LayaConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "thinking"
  | "unavailable"
  | "timeout"
  | "invalid_response";

/** One-ply material-based evaluation for a single candidate move — no AI involved. */
export interface MaterialEval {
  candidateId: string;
  materialDelta: number; // material change for the side to move, from this one move
  rank: number; // 1 = best by this heuristic; tied moves share a rank
}

/** What the one-ply material check says about a pick. "no_signal" = every move ties. */
export type MaterialVerdict = "agree" | "disagree" | "no_signal";

/** Material balance after the available captures play out (engine.ts evaluateSettledMaterial). */
export interface SettledMaterial {
  /** white - black, positive favors white. ±SETTLE_MATE when the capture search ends in mate. */
  diff: number;
  /** False when the search hit its depth cap or node budget before settling. */
  complete: boolean;
}

/**
 * One real, measured request for the session latency readout. Every field
 * comes from performance.now() timestamps around a single fetch — nothing
 * here is estimated. modelMs/overheadMs are null when the server does not
 * report inference time (shown as "n/a").
 */
export interface LatencySample {
  totalMs: number;
  networkAndServerMs: number;
  parseMs: number;
  modelMs: number | null;
  overheadMs: number | null;
  /** True for the very first request of the session (usually slower). */
  coldStart: boolean;
}
