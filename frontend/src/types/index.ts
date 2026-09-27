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
  modelLatencyMs: number | null;
  totalLatencyMs: number;
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
  rank: number; // 1 = best by this heuristic
}
