import type { CandidateMove, LayaDecisionResponse, LatencySample, MaterialEval } from "../types";

interface CalibrationPanelProps {
  candidates: CandidateMove[];
  decision: LayaDecisionResponse | null;
  /** The exact measured sample for `decision` (set/cleared with it). Null = none yet. */
  decisionLatency: LatencySample | null;
  materialEvals: MaterialEval[];
  connectionState: string;
  /** Candidates actually sent in the one in-flight request (thinking view). */
  thinkingSent: number;
  /** Legal moves in the scored position (thinking view denominator). */
  thinkingLegal: number;
  /** Real measured per-request totals for the session stats + sparkline. */
  latencies: LatencySample[];
  /** Legal moves in the live position (shown before any decision). */
  currentLegal: number;
}

/** Total-latency color bands for the readout (C.4). */
export const LATENCY_GREEN_MAX_MS = 250;
export const LATENCY_AMBER_MAX_MS = 1000;

export function latencyClass(totalMs: number): "lat-green" | "lat-amber" | "lat-red" {
  if (totalMs < LATENCY_GREEN_MAX_MS) return "lat-green";
  if (totalMs <= LATENCY_AMBER_MAX_MS) return "lat-amber";
  return "lat-red";
}

const fmtMs = (v: number | null) => (v === null ? "n/a" : `${v.toFixed(0)} MS`);

interface LatencyStats {
  last: number;
  avg: number;
  min: number;
  max: number;
  p95: number;
  count: number;
}

/** LAST / AVG / MIN / MAX / P95 over real measured session totals. */
export function summarizeLatencies(samples: LatencySample[]): LatencyStats | null {
  if (samples.length === 0) return null;
  const totals = samples.map((s) => s.totalMs);
  const sorted = [...totals].sort((a, b) => a - b);
  const sum = totals.reduce((a, b) => a + b, 0);
  // Nearest-rank percentile over the real samples (no interpolation, no model).
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
  return {
    last: totals[totals.length - 1],
    avg: sum / totals.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95,
    count: totals.length,
  };
}

/** Sparkline of the last 20 real total latencies (SVG polyline). */
function LatencySparkline({ samples }: { samples: LatencySample[] }) {
  const windowed = samples.slice(-20).map((s) => s.totalMs);
  if (windowed.length === 0) return null;
  const W = 120;
  const H = 28;
  const min = Math.min(...windowed);
  const max = Math.max(...windowed);
  const span = max - min;
  const points = windowed
    .map((v, i) => {
      const x = windowed.length === 1 ? W / 2 : (i / (windowed.length - 1)) * W;
      // Flat line mid-height when every sample is identical (span 0 is real data, not an error).
      const y = span === 0 ? H / 2 : H - 2 - ((v - min) / span) * (H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="sparkline" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polyline points={points} fill="none" strokeWidth="1.5" />
    </svg>
  );
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
  decisionLatency,
  materialEvals,
  connectionState,
  thinkingSent,
  thinkingLegal,
  latencies,
  currentLegal,
}: CalibrationPanelProps) {
  const isThinking = connectionState === "thinking";
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

  const stats = summarizeLatencies(latencies);

  // Legal-move counter: live counts while thinking, then the real
  // sent/legal counts of the position the answer on screen was scored on.
  const allOf = (sent: number, legal: number, allNote: string) =>
    sent === legal ? allNote : `TOP ${sent} SENT — CAPTURES, CHECKS, PROMOTIONS FIRST`;
  const moveCount = isThinking
    ? { sent: thinkingSent, legal: thinkingLegal, note: allOf(thinkingSent, thinkingLegal, "ALL OF THEM, AT ONCE") }
    : decision
      ? {
          sent: decision.sentCandidateCount,
          legal: decision.legalCandidateCount,
          note: allOf(decision.sentCandidateCount, decision.legalCandidateCount, "ALL OF THEM, IN ONE ANSWER"),
        }
      : null;

  return (
    <div className="panel">
      <div className="panel-title">
        <span>LAYA — DECISION</span>
        <span className={`status-pill ${connectionState}`}>{connectionState}</span>
      </div>

      {moveCount && (
        <>
          <p className="think-counter">
            <span className="count-big">{moveCount.sent}</span>
            <span>/ {moveCount.legal} LEGAL MOVES</span>
          </p>
          <div className={`segments${isThinking ? " live" : ""}`} aria-hidden="true">
            {Array.from({ length: moveCount.sent }).map((_, i) => (
              <span key={i} className="seg" />
            ))}
          </div>
          <p className="panel-note">{moveCount.note}</p>
        </>
      )}


      {!decision && !isThinking && (
        <>
          <p className="think-counter">
            <span className="count-big">{currentLegal}</span>
            <span>LEGAL MOVES FOR YOU</span>
          </p>
          <p className="panel-note">
            Make a move — Laya scores every legal reply for the resulting position.
          </p>
        </>
      )}

      {decision && !top && !isThinking && (
        <p className="panel-note">
          Laya answered for a previous position ({decision.scores.length} candidates) —
          make a move to score the current one.
        </p>
      )}

      {decision && top && !isThinking && (
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

          {rows.slice(0, 5).map((r, i) => (
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
          {rows.length > 5 && (
            <p className="panel-note">AND {rows.length - 5} MORE, ALL IN THE SAME ANSWER.</p>
          )}

          <div className="latency-block">
            <div className="latency-title">
              <span>LATENCY</span>
              {decisionLatency?.coldStart && <span className="cold-tag">COLD START</span>}
            </div>
            <div className="latency-nums">
              <span>
                MODEL <b>{fmtMs(decisionLatency?.modelMs ?? null)}</b>
              </span>
              <span>
                OVERHEAD <b>{fmtMs(decisionLatency?.overheadMs ?? null)}</b>
              </span>
              <span className={decisionLatency ? latencyClass(decisionLatency.totalMs) : undefined}>
                TOTAL <b>{decisionLatency ? `${decisionLatency.totalMs.toFixed(0)} MS` : "n/a"}</b>
              </span>
            </div>
            {decisionLatency && decisionLatency.modelMs !== null && decisionLatency.totalMs > 0 && (
              <div
                className="latency-bar"
                role="img"
                aria-label={`model ${decisionLatency.modelMs.toFixed(0)}ms, overhead ${(decisionLatency.overheadMs ?? 0).toFixed(0)}ms, total ${decisionLatency.totalMs.toFixed(0)}ms`}
              >
                <span
                  className="latency-model"
                  style={{ width: `${(decisionLatency.modelMs / decisionLatency.totalMs) * 100}%` }}
                />
                <span className="latency-overhead" />
              </div>
            )}
            {(!decisionLatency || decisionLatency.modelMs === null) && (
              <p className="panel-note">MODEL N/A — SERVER REPORTED NO INFERENCE TIME.</p>
            )}
          </div>

          <div className="meta-row">
            <span>
              network+server{" "}
              <b>{decisionLatency ? `${decisionLatency.networkAndServerMs.toFixed(0)}ms` : "n/a"}</b>
            </span>
            <span>
              parse <b>{decisionLatency ? `${decisionLatency.parseMs.toFixed(1)}ms` : "n/a"}</b>
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

      {stats && (
        <div className="session-block">
          <div className="latency-title">
            <span>SESSION — {stats.count} REQUEST{stats.count === 1 ? "" : "S"}</span>
          </div>
          <div className="session-grid">
            <span>LAST <b className={latencyClass(stats.last)}>{stats.last.toFixed(0)} MS</b></span>
            <span>AVG <b>{stats.avg.toFixed(0)} MS</b></span>
            <span>MIN <b>{stats.min.toFixed(0)} MS</b></span>
            <span>MAX <b>{stats.max.toFixed(0)} MS</b></span>
            <span>P95 <b>{stats.p95.toFixed(0)} MS</b></span>
          </div>
          <LatencySparkline samples={latencies} />
        </div>
      )}
    </div>
  );
}
