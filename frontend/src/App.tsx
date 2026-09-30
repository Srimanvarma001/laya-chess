import { useEffect, useRef, useState } from "react";
import { Board } from "./components/Board";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { SessionTally } from "./components/SessionTally";
import { EvalBar } from "./components/EvalBar";
import { MoveTrails, type TrailMove } from "./components/MoveTrails";
import { applyMove, evaluateCandidatesByMaterial, getPieceAt, startingSnapshot } from "./chess/engine";
import {
  LayaInvalidResponseError,
  LayaTimeoutError,
  checkHealth,
  decideMove,
  reduceCandidates,
  serverLabel,
} from "./api/layaClient";
import type { CandidateMove, GameSnapshot, GhostInfo, LayaConnectionState, LayaDecisionResponse, LatencySample, MaterialEval } from "./types";

/** Resolved view keeps only the top-N confidence-weighted trails. */
const TRAILS_RESOLVED_CAP = 12;
/** Beat between the human's move and the ghost view fading in. */
const GHOST_VIEW_DELAY_MS = 450;
/** Minimum time the ghost view stays up: 2 full 1.25s glow cycles (styles.css
 * ghost-glow/trails-glow), so it ends on a fade-out, not mid-glow. */
const GHOST_VIEW_MIN_MS = 2500;

/**
 * One ghost preview per unique destination square: the piece currently on
 * the move's `from` square. Thinking ghosts are uniform (tier -1) — Laya
 * scores everything in one pass, so nothing is brighter than anything else
 * yet. First move wins when several land on the same square.
 */
function buildGhosts(trails: TrailMove[] | null, fen: string): Map<string, GhostInfo> {
  const ghosts = new Map<string, GhostInfo>();
  if (!trails || !fen) return ghosts;
  trails.forEach((t) => {
    if (ghosts.has(t.to)) return;
    const piece = getPieceAt(fen, t.from);
    if (!piece) return;
    ghosts.set(t.to, { pieceKey: `${piece.color}${piece.type}`, tier: -1 });
  });
  return ghosts;
}
/** Collapse promotion duplicates (same from→to) keeping the max weight. */
function dedupeTrails(moves: TrailMove[]): TrailMove[] {
  const byKey = new Map<string, TrailMove>();
  for (const m of moves) {
    const prev = byKey.get(`${m.from}${m.to}`);
    if (!prev || m.weight > prev.weight) byKey.set(`${m.from}${m.to}`, m);
  }
  return [...byKey.values()];
}

/**
 * Trails for a resolved decision: look up from/to via the legal moves of the
 * position that was actually scored (not the live snapshot, which has moved
 * on once Laya's reply is played), weight by real confidence, top ~12.
 */
function buildResolvedTrails(
  decision: LayaDecisionResponse,
  candidates: CandidateMove[]
): TrailMove[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const trails: TrailMove[] = [];
  for (const s of decision.scores) {
    const c = byId.get(s.candidateId);
    if (!c) continue;
    trails.push({ from: c.from, to: c.to, weight: s.rawConfidence });
  }
  return dedupeTrails(trails)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TRAILS_RESOLVED_CAP);
}

export default function App() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(() => startingSnapshot());
  const [connectionState, setConnectionState] = useState<LayaConnectionState>("idle");
  const [decision, setDecision] = useState<LayaDecisionResponse | null>(null);
  // The position (black to move) that `decision` was scored on. After Laya's
  // reply is played, the live snapshot has moved on to white-to-move, so the
  // calibration panel keeps showing black's reasoning instead of going stale.
  const [decisionCandidates, setDecisionCandidates] = useState<CandidateMove[] | null>(null);
  const [decisionMaterialEvals, setDecisionMaterialEvals] = useState<MaterialEval[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tally, setTally] = useState({ agree: 0, disagree: 0 });
  // Last played move (white or black): Board slides the glyph from->to.
  const [lastMove, setLastMove] = useState<{
    from: string;
    to: string;
    pieceKey: string;
    key: number;
  } | null>(null);
  // Board overlay rule: ghost view (considering lines + ghosts) while Laya
  // thinks, then ONLY the single played line under the sliding piece once
  // a move lands. No persistent candidate lines stay on the board — Laya's
  // reasoning lives in the calibration panel, never as leftover lines.
  // Ghosts + lines appear the instant the human moves (no delay) and blink
  // while Laya thinks.
  const [consideringVisible, setConsideringVisible] = useState(false);
  const consideringTimeoutRef = useRef<number | null>(null);
  // Thinking bookkeeping for the banner/panel: when the current wait started
  // (live timer origin), how many candidates were actually sent in the one
  // batched request, and how many legal moves the position had. All real.
  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [thinkingSent, setThinkingSent] = useState(0);
  const [thinkingLegal, setThinkingLegal] = useState(0);
  // Real measured per-request latencies for the session readout + sparkline.
  // RESET clears this; the next request after a clear is tagged COLD START.
  const [latencies, setLatencies] = useState<LatencySample[]>([]);
  const latencyCountRef = useRef(0);
  // The exact sample measured for the decision on screen (set together with
  // it, cleared together with it — never a neighbouring request's numbers).
  const [decisionLatency, setDecisionLatency] = useState<LatencySample | null>(null);
  // Single bright line for the piece currently sliding (white or black).
  // Mounted together with Board's move-anim so the glyph glides ALONG the
  // line while the line slowly vanishes underneath it.
  const [slideLine, setSlideLine] = useState<{ from: string; to: string; key: number } | null>(null);
  const slideTimeoutRef = useRef<number | null>(null);
  // Destination ghost the sliding piece is hopping to: stays pinned while
  // the glyph travels, then vanishes with everything once it lands.
  const [landingGhost, setLandingGhost] = useState<{
    square: string;
    pieceKey: string;
    key: number;
  } | null>(null);
  const landingTimeoutRef = useRef<number | null>(null);
  // Guards out-of-order responses when the user moves twice quickly: only
  // the latest request may write decision/connection state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    checkHealth().then(({ ok }) => setConnectionState(ok ? "connected" : "unavailable"));
  }, []);

  useEffect(
    () => () => {
      if (consideringTimeoutRef.current !== null) {
        window.clearTimeout(consideringTimeoutRef.current);
      }
      if (slideTimeoutRef.current !== null) window.clearTimeout(slideTimeoutRef.current);
      if (landingTimeoutRef.current !== null) window.clearTimeout(landingTimeoutRef.current);
    },
    []
  );

  function clearConsideringTimer() {
    if (consideringTimeoutRef.current !== null) {
      window.clearTimeout(consideringTimeoutRef.current);
      consideringTimeoutRef.current = null;
    }
  }

  /** Show the played-move line under the sliding glyph, slowly vanishing. */
  function showSlideLine(from: string, to: string, key: number) {
    setSlideLine({ from, to, key });
    if (slideTimeoutRef.current !== null) window.clearTimeout(slideTimeoutRef.current);
    // Board's glide is ~750ms straight / ~850ms knight L; keep the line a
    // beat longer so the piece lands before the line fully dissolves.
    slideTimeoutRef.current = window.setTimeout(() => setSlideLine(null), 1100);
  }

  /** Pin the destination ghost until the sliding piece lands, then vanish all. */
  function showLandingGhost(square: string, pieceKey: string, key: number) {
    setLandingGhost({ square, pieceKey, key });
    if (landingTimeoutRef.current !== null) window.clearTimeout(landingTimeoutRef.current);
    // Matches Board's ~900ms anim window: ghost dissolves as glyph arrives.
    landingTimeoutRef.current = window.setTimeout(() => setLandingGhost(null), 900);
  }

  const materialEvals = evaluateCandidatesByMaterial(snapshot.fen, snapshot.legalMoves);

  const isThinking = connectionState === "thinking";
  // The exact candidate set being weighed right now: the same deterministic
  // reduction decideMove sends in its one batched request (no cap here — the
  // honesty rule says everything lit must light at once, all of it).
  const sentNow = isThinking ? reduceCandidates(snapshot.legalMoves) : null;
  const consideringTrails: TrailMove[] | null = sentNow
    ? dedupeTrails(sentNow.map((m) => ({ from: m.from, to: m.to, weight: 0 })))
    : null;
  // NOTE: no `resolvedTrails` on the board — after the ghost view hides,
  // only the single played slideLine is mounted (see overlay below). The
  // decision still feeds the calibration panel + console log.
  // The winning candidate's squares, tinted cyan on the board (B.3). Falls
  // back to lastMove's tint when no decision is on screen.
  const topPick: { from: string; to: string } | null = (() => {
    if (!decision?.selectedCandidateId || !decisionCandidates) return null;
    const c = decisionCandidates.find((m) => m.id === decision.selectedCandidateId);
    return c ? { from: c.from, to: c.to } : null;
  })();
  const lastLatency: LatencySample | null = latencies.length > 0 ? latencies[latencies.length - 1] : null;

  // Ghost preview pulse follows the thinking overlay, so considering ghosts
  // vanish and return in sync with the lines. Landing ghost never blinks —
  // it stays pinned while the piece hops to it.
  const glowPulse = !!(consideringVisible && consideringTrails);

  // Ghost previews: thinking -> every sent candidate's destination
  // (blinking); landing -> the single destination the piece is travelling to
  // (pinned solid, then vanishes on arrival). Deliberately NO ghosts once a
  // move has landed — reasoning stays in the panel bars only.
  const ghostPieces: Map<string, GhostInfo> =
    landingGhost
      ? new Map([[landingGhost.square, { pieceKey: landingGhost.pieceKey, tier: 0 }]])
      : consideringVisible && consideringTrails
        ? buildGhosts(consideringTrails, snapshot.fen)
        : new Map();
  const landingSquares = landingGhost ? new Set([landingGhost.square]) : undefined;

  async function handleUserMove(candidate: CandidateMove) {
    // The user plays white only — black is Laya's side.
    if (snapshot.turn !== "w") return;
    console.log("[move] candidate from Board:", candidate);
    let next: GameSnapshot;
    try {
      next = applyMove(snapshot.fen, snapshot.history, candidate.id);
      console.log("[move] applied, new fen:", next.fen, "history:", next.history);
    } catch (err) {
      console.error("[move] applyMove failed for candidate:", candidate, err);
      setErrorMessage((err as Error).message);
      return;
    }
    setSnapshot(next);
    {
      const piece = getPieceAt(snapshot.fen, candidate.from);
      if (piece) {
        setLastMove({
          from: candidate.from,
          to: candidate.to,
          pieceKey: `${piece.color}${piece.type}`,
          key: next.history.length,
        });
        // White glyph glides along its own line while it slowly vanishes.
        // showSlideLine replaces any previous line, so the mover's old
        // line is removed the moment the new one mounts (single line max).
        showSlideLine(candidate.from, candidate.to, next.history.length);
      }
    }
    setDecision(null);
    setDecisionLatency(null);
    setDecisionCandidates(null);
    setDecisionMaterialEvals(null);
    setErrorMessage(null);

    if (next.isGameOver || next.legalMoves.length === 0) return;

    await requestLayaBlackMove(next);
  }

  /** Laya thinks on the black-to-move position and its pick is played as black. */
  async function requestLayaBlackMove(position: GameSnapshot) {
    const requestId = ++requestIdRef.current;
    setConnectionState("thinking");
    // Honest thinking counts: exactly what decideMove will send (same
    // deterministic reduction, same input) and the true legal total.
    const sent = reduceCandidates(position.legalMoves);
    setThinkingSent(sent.length);
    setThinkingLegal(position.legalMoves.length);
    setThinkingSince(performance.now());
    console.log(
      "[trails] considering",
      position.legalMoves.length,
      "legal:",
      position.legalMoves.map((m) => m.id).join(" ")
    );
    // Ghosts + lines appear after a short beat so the human's own move
    // lands first, then stay up for at least GHOST_VIEW_MIN_MS even when
    // Laya answers sooner (see the hold after decideMove below).
    const ghostViewUntil = performance.now() + GHOST_VIEW_DELAY_MS + GHOST_VIEW_MIN_MS;
    clearConsideringTimer();
    consideringTimeoutRef.current = window.setTimeout(() => {
      consideringTimeoutRef.current = null;
      setConsideringVisible(true);
    }, GHOST_VIEW_DELAY_MS);
    const hideConsidering = () => {
      clearConsideringTimer();
      setConsideringVisible(false);
      setThinkingSince(null);
    };
    try {
      const result = await decideMove(position.fen, position.legalMoves);
      if (requestIdRef.current !== requestId) return; // a newer move superseded this one
      // Purely visual hold so the ghost view gets its full glow cycles.
      // Latency numbers were already measured inside decideMove, and the
      // live WAITING timer stops now — the hold is never counted as Laya time.
      const holdMs = ghostViewUntil - performance.now();
      if (holdMs > 0) {
        setThinkingSince(null);
        await new Promise((resolve) => window.setTimeout(resolve, holdMs));
        if (requestIdRef.current !== requestId) return; // reset during the hold
      }
      hideConsidering();
      console.log("[laya] decision:", result.selectedCandidateId, result);
      console.log(
        "[trails] resolved:",
        buildResolvedTrails(result, position.legalMoves)
          .map((t) => `${t.from}${t.to}:${t.weight.toFixed(2)}`)
          .join(" ")
      );
      // Session latency history: every number measured, none estimated. The
      // first entry of the session carries the COLD START tag.
      const coldStart = latencyCountRef.current === 0;
      latencyCountRef.current += 1;
      const sample: LatencySample = {
        totalMs: result.totalLatencyMs,
        networkAndServerMs: result.networkAndServerMs,
        parseMs: result.parseMs,
        modelMs: result.modelLatencyMs,
        overheadMs: result.overheadMs,
        coldStart,
      };
      setLatencies((prev) => [...prev, sample]);

      const positionMaterialEvals = evaluateCandidatesByMaterial(position.fen, position.legalMoves);
      const topByMaterial = positionMaterialEvals.find((m) => m.rank === 1);
      const agrees = result.selectedCandidateId === topByMaterial?.candidateId;
      setTally((t) => (agrees ? { ...t, agree: t.agree + 1 } : { ...t, disagree: t.disagree + 1 }));

      const pickId = result.selectedCandidateId;
      const picked = position.legalMoves.find((m) => m.id === pickId);
      if (!pickId || !picked) {
        console.error("[laya] selected move is not legal:", pickId, result);
        setDecision(result);
        setDecisionLatency(sample);
        setDecisionCandidates(position.legalMoves);
        setDecisionMaterialEvals(positionMaterialEvals);
        setConnectionState("connected");
        setErrorMessage(
          `Laya picked an illegal move (${pickId ?? "none"}). Press RETRY or RESET.`
        );
        return;
      }

      let after: GameSnapshot;
      try {
        after = applyMove(position.fen, position.history, pickId);
        console.log("[laya] black played:", pickId, "new fen:", after.fen);
      } catch (err) {
        console.error("[laya] failed to apply picked move:", pickId, err);
        setDecision(result);
        setDecisionLatency(sample);
        setDecisionCandidates(position.legalMoves);
        setDecisionMaterialEvals(positionMaterialEvals);
        setConnectionState("connected");
        setErrorMessage((err as Error).message);
        return;
      }

      setSnapshot(after);
      {
        const piece = getPieceAt(position.fen, picked.from);
        if (piece) {
          const pieceKey = `${piece.color}${piece.type}`;
          setLastMove({
            from: picked.from,
            to: picked.to,
            pieceKey,
            key: after.history.length,
          });
          // Black glyph glides ALONG its line to its waiting ghost: mount
          // the single bright trail under the sliding piece (L-bend for
          // knights) + pin the destination ghost; both slowly vanish
          // (~1s) while the piece travels (~750-850ms), all gone on landing.
          // showSlideLine overwrites white's line, so the piece-you-moved
          // line is removed the moment black's line mounts.
          showSlideLine(picked.from, picked.to, after.history.length);
          showLandingGhost(picked.to, pieceKey, after.history.length);
        }
      }
      // Decision details stay for the calibration panel only — the board
      // itself shows just the single played line above, which dissolves on
      // landing. No candidate lines linger after the move.
      setDecision(result);
      setDecisionLatency(sample);
      setDecisionCandidates(position.legalMoves);
      setDecisionMaterialEvals(positionMaterialEvals);
      setErrorMessage(null);
      setConnectionState("connected");
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      hideConsidering();
      console.error("[laya] decideMove failed:", err);
      setErrorMessage((err as Error).message);
      if (err instanceof LayaTimeoutError) {
        setConnectionState("timeout");
      } else if (err instanceof LayaInvalidResponseError) {
        setConnectionState("invalid_response");
      } else {
        setConnectionState("unavailable");
      }
    }
  }

  function handleRetryLaya() {
    if (snapshot.turn !== "b" || snapshot.isGameOver) return;
    setErrorMessage(null);
    void requestLayaBlackMove(snapshot);
  }

  function handleReset() {
    requestIdRef.current += 1; // invalidate any in-flight decision
    if (slideTimeoutRef.current !== null) window.clearTimeout(slideTimeoutRef.current);
    setSlideLine(null);
    if (landingTimeoutRef.current !== null) window.clearTimeout(landingTimeoutRef.current);
    setLandingGhost(null);
    clearConsideringTimer();
    setConsideringVisible(false);
    setThinkingSince(null);
    setLastMove(null);
    setSnapshot(startingSnapshot());
    setDecision(null);
    setDecisionLatency(null);
    setDecisionCandidates(null);
    setDecisionMaterialEvals(null);
    setErrorMessage(null);
    setConnectionState((s) => (s === "thinking" ? "connected" : s));
    setTally({ agree: 0, disagree: 0 });
    latencyCountRef.current = 0;
    setLatencies([]);
  }

  const bannerText = (() => {
    if (snapshot.isCheckmate) return `CHECKMATE — ${snapshot.turn === "w" ? "BLACK (LAYA)" : "WHITE (YOU)"} WINS`;
    if (snapshot.isStalemate) return "STALEMATE — DRAW";
    if (connectionState === "thinking") return `LAYA IS WEIGHING ALL ${thinkingSent} MOVES AT ONCE`;
    if (connectionState === "unavailable") return "LAYA UNAVAILABLE — CHECK laya-serve IS RUNNING";
    if (connectionState === "timeout") return "LAYA TIMED OUT ON THAT REQUEST";
    if (connectionState === "invalid_response") return "LAYA REPLY DID NOT PARSE — SEE CONSOLE + layaClient.ts";
    if (snapshot.turn === "b") return "LAYA (BLACK) TO MOVE — WAIT FOR ITS REPLY.";
    return `YOUR MOVE. WHITE HAS ${snapshot.legalMoves.length} LEGAL MOVES.`;
  })();
  const bannerClass =
    connectionState === "unavailable" ||
    connectionState === "timeout" ||
    connectionState === "invalid_response"
      ? "bad"
      : connectionState === "thinking"
      ? "attention"
      : "";

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">
            LAYA <span className="accent">CHESS</span>
          </h1>
          <p className="app-subtitle">
            YOU PLAY WHITE. LAYA PLAYS BLACK — EVERY LEGAL MOVE IS A TAP ON A
            HIGHLIGHTED SQUARE. ILLEGAL MOVES DO NOT EXIST IN THIS UI. LAYA'S
            CONFIDENCE IS CHECKED AGAINST PLAIN ONE-PLY MATERIAL, LIVE.
          </p>
        </div>
        <div className="header-status">
          <span>
            <span className={`dot ${connectionState === "connected" ? "on" : ""}`} />
            LOCAL — {serverLabel()} — LAST {lastLatency ? `${lastLatency.totalMs.toFixed(0)} MS` : "—"}
          </span>
        </div>
      </header>

      <div className={`status-banner ${bannerClass}`}>
        {bannerText}
        {connectionState === "thinking" && (
          <span className="cursor" aria-hidden="true">_</span>
        )}
      </div>

      <main>
        <div className="board-section">
          <EvalBar diff={snapshot.material.diff} />
          <div className="board-wrap">
            <Board
              fen={snapshot.fen}
              onMove={handleUserMove}
              disabled={snapshot.isGameOver || snapshot.turn !== "w" || connectionState === "thinking"}
              ghostPieces={ghostPieces}
              ghostPulse={glowPulse}
              landingSquares={landingSquares}
              lastMove={lastMove}
              topPick={topPick}
              overlay={
                <>
                  {consideringTrails && consideringVisible && (
                    <MoveTrails moves={consideringTrails} mode="considering" />
                  )}
                  {slideLine && (
                    <MoveTrails
                      key={`slide-${slideLine.key}`}
                      moves={[{ from: slideLine.from, to: slideLine.to, weight: 1 }]}
                      mode="played"
                      fading
                    />
                  )}
                </>
              }
            />
            <div className="game-status">
              <span>material {snapshot.material.white}–{snapshot.material.black}</span>
              <span>{snapshot.history.length} ply</span>
              <span>{snapshot.legalMoves.length} legal moves</span>
              <span>{snapshot.turn === "w" ? "you: white" : "laya: black"}</span>
              {snapshot.turn === "b" && !snapshot.isGameOver && connectionState !== "thinking" && errorMessage && (
                <button onClick={handleRetryLaya}>RETRY LAYA</button>
              )}
              <button onClick={handleReset}>RESET</button>
            </div>
            {errorMessage && <div className="error-banner">{errorMessage}</div>}
          </div>
        </div>

        <section className="side-panel">
          <CalibrationPanel
            candidates={decisionCandidates ?? snapshot.legalMoves}
            decision={decision}
            decisionLatency={decisionLatency}
            materialEvals={decisionMaterialEvals ?? materialEvals}
            connectionState={connectionState}
            thinkingSent={thinkingSent}
            thinkingLegal={thinkingLegal}
            thinkingSince={isThinking ? thinkingSince : null}
            latencies={latencies}
            currentLegal={snapshot.legalMoves.length}
          />
          <SessionTally agree={tally.agree} disagree={tally.disagree} />
        </section>
      </main>
    </div>
  );
}
