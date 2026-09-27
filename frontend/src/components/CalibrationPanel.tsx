import type { CandidateMove, LayaDecisionResponse, MaterialEval } from "../types";

interface CalibrationPanelProps {
  candidates: CandidateMove[];
  decision: LayaDecisionResponse | null;
  materialEvals: MaterialEval[];
  connectionState: string;
}

/**
 * Section 14 of PROJECT.md, styled as a ranked bar list rather than a plain
 * table: Laya's confidence per candidate move, sorted, with a one-line
 * headline for the top pick and a note on whether the cheap material check
 * (zero AI) agrees with it.
 *
 * Real Laya fields surfaced here: `choice` probabilities per move,
 * `confidence` (1 - normalised entropy), `answer_confidence` (the single
 * calibrated number to gate on), the routing checkpoint, and token usage.
 */
export function CalibrationPanel({
  candidates,
  decision,
  materialEvals,
  connectionState,
}: CalibrationPanelProps) {
  const materialById = new Map(materialEvals.map((m) => [m.candidateId, m]));
  const scoreById = new Map((decision?.scores ?? []).map((s) => [s.candidateId, s]));

  const rows = candidates
    .map((c) => ({
      candidate: c,
      material: materialById.get(c.id),
      score: scoreById.get(c.id),
    }))
    .filter((r) => r.score)
    .sort((a, b) => (b.score!.rawConfidence ?? 0) - (a.score!.rawConfidence ?? 0));

  const top = rows[0];
  const topMaterialRank = top?.material?.rank;
  const materialAgrees = topMaterialRank === 1;
  const pct = (p: number) => `${(Math.max(0, Math.min(1, p)) * 100).toFixed(0)}%`;

  return (
    <div className="panel">
      <div className="panel-title">
        <span>LAYA — DECISION</span>
        <span className={`status-pill ${connectionState}`}>{connectionState}</span>
      </div>

      {!decision && (
        <p className="panel-note">
          {connectionState === "thinking"
            ? "Weighing every legal move in one pass..."
            : "Make a move — Laya scores every legal reply for the resulting position."}
        </p>
      )}

      {decision && !top && (
        <p className="panel-note">
          Laya answered for a previous position ({decision.scores.length} candidates) —
          make a move to score the current one.
        </p>
      )}

      {decision && top && (
        <>
          <p className="headline">
            <span className="move">{top.candidate.san}</span> won{" "}
            <span className="pct">{pct(top.score!.rawConfidence)}</span> of its
            belief across {rows.length} candidates. The plain material check{" "}
            {materialAgrees ? (
              <span className="agree">agrees</span>
            ) : (
              <span className="disagree">picks something else</span>
            )}
            .
          </p>

          {rows.slice(0, 6).map((r, i) => (
            <div key={r.candidate.id} className={`bar-row ${i === 0 ? "top" : ""}`}>
              <span className="move-label">{r.candidate.san}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${Math.max(2, Math.max(0, Math.min(1, r.score!.rawConfidence)) * 100)}%` }}
                />
              </div>
              <span className="pct-label">{pct(r.score!.rawConfidence)}</span>
            </div>
          ))}
          {rows.length > 6 && (
            <p className="panel-note">and {rows.length - 6} more, same decision.</p>
          )}

          <div className="meta-row">
            <span>
              model <b>{decision.modelLatencyMs != null ? `${decision.modelLatencyMs.toFixed(0)}ms` : "?ms"}</b>
            </span>
            <span>
              total <b>{decision.totalLatencyMs.toFixed(0)}ms</b>
            </span>
            <span>
              material rank of pick <b>#{topMaterialRank ?? "?"}</b>
            </span>
            {decision.answerConfidence != null && (
              <span>
                answer conf <b>{pct(decision.answerConfidence)}</b>
              </span>
            )}
            {decision.routingModel && (
              <span>
                checkpoint <b>{decision.routingModel}</b>
              </span>
            )}
          </div>

          <p className="panel-note">
            "Agrees" only checks whether Laya's top pick is also the top pick by
            raw one-ply material — a cheap sanity check, not a claim that
            material-greedy play is objectively correct chess.
            {decision.routingReason ? ` Routed: ${decision.routingReason}.` : ""}
            {decision.usage ? ` Tokens: ${decision.usage.input_tokens} in.` : ""}
          </p>
        </>
      )}
    </div>
  );
}
