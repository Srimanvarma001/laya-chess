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
} from "./api/layaClient";
import type { CandidateMove, GameSnapshot, GhostInfo, LayaConnectionState, LayaDecisionResponse, MaterialEval } from "./types";

/** Caps so many-candidate positions don't turn into unreadable spaghetti. */
const TRAILS_CONSIDERING_CAP = 20;
const TRAILS_RESOLVED_CAP = 12;

/**
 * One ghost preview per unique destination square: the piece currently on
 * the move's `from` square in the scored position. First (brightest) move
 * wins when several land on the same square.
 */
function buildGhosts(
  trails: TrailMove[] | null,
  fen: string | null,
  resolved: boolean
): Map<string, GhostInfo> {
  const ghosts = new Map<string, GhostInfo>();
  if (!trails || !fen) return ghosts;
  trails.forEach((t, idx) => {
    if (ghosts.has(t.to)) return;
    const piece = getPieceAt(fen, t.from);
    if (!piece) return;
    ghosts.set(t.to, {
      pieceKey: `${piece.color}${piece.type}`,
      tier: resolved ? (idx === 0 ? 0 : idx <= 2 ? 1 : 2) : -1,
    });
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
  // FEN of the scored (black-to-move) position — ghost previews read the
  // mover off this board, not the live snapshot which has moved on.
  const [decisionFen, setDecisionFen] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [tally, setTally] = useState({ agree: 0, disagree: 0 });
  // Last played move (white or black): Board slides the glyph from->to.
  const [lastMove, setLastMove] = useState<{
    from: string;
    to: string;
    pieceKey: string;
    key: number;
  } | null>(null);
  // Previous resolved trails, kept mounted briefly so they fade out (600ms
  // CSS transition) instead of cutting when a new considering phase starts.
  const [fadingTrails, setFadingTrails] = useState<TrailMove[] | null>(null);
  const fadeTimeoutRef = useRef<number | null>(null);  // Considering lines appear only after the old resolved fade (~600ms) has
  // finished, so stale and fresh move sets are never drawn on top of each other.
  const [consideringVisible, setConsideringVisible] = useState(false);
  const consideringTimeoutRef = useRef<number | null>(null);
  // Guards out-of-order responses when the user moves twice quickly: only
  // the latest request may write decision/connection state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    checkHealth().then(({ ok }) => setConnectionState(ok ? "connected" : "unavailable"));
  }, []);

  useEffect(
    () => () => {
      if (fadeTimeoutRef.current !== null) window.clearTimeout(fadeTimeoutRef.current);
      if (consideringTimeoutRef.current !== null) {
        window.clearTimeout(consideringTimeoutRef.current);
      }
    },
    []
  );

  function clearConsideringTimer() {
    if (consideringTimeoutRef.current !== null) {
      window.clearTimeout(consideringTimeoutRef.current);
      consideringTimeoutRef.current = null;
    }
  }

  const materialEvals = evaluateCandidatesByMaterial(snapshot.fen, snapshot.legalMoves);

  const isThinking = connectionState === "thinking";
  // Genuine candidates being weighed right now (black-to-move position).
  const consideringTrails: TrailMove[] | null = isThinking
    ? dedupeTrails(
        snapshot.legalMoves.map((m) => ({ from: m.from, to: m.to, weight: 0 }))
      ).slice(0, TRAILS_CONSIDERING_CAP)
    : null;
  const resolvedTrails: TrailMove[] | null =
    decision && decisionCandidates ? buildResolvedTrails(decision, decisionCandidates) : null;
  const showResolved = resolvedTrails && !isThinking;

  // Ghost preview pulse follows the considering overlay visibility.
  const glowPulse = consideringVisible && !!consideringTrails;

  // Ghost previews, same sets/fens as the trails: considering -> capped legal
  // set on the live position; resolved -> scored top-12 on the scored position.
  const ghostPieces: Map<string, GhostInfo> =
    consideringVisible && consideringTrails
      ? buildGhosts(consideringTrails, snapshot.fen, false)
      : showResolved && resolvedTrails
        ? buildGhosts(resolvedTrails, decisionFen, true)
        : new Map();

  function stashResolvedTrailsForFade() {
    if (decision && decisionCandidates) {
      const stash = buildResolvedTrails(decision, decisionCandidates);
      if (stash.length > 0) {
        setFadingTrails(stash);
        if (fadeTimeoutRef.current !== null) window.clearTimeout(fadeTimeoutRef.current);
        fadeTimeoutRef.current = window.setTimeout(() => setFadingTrails(null), 700);
      }
    }
  }

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
      }
    }
    stashResolvedTrailsForFade();
    setDecision(null);
    setDecisionCandidates(null);
    setDecisionFen(null);
    setDecisionMaterialEvals(null);
    setErrorMessage(null);

    if (next.isGameOver || next.legalMoves.length === 0) return;

    await requestLayaBlackMove(next);
  }

  /** Laya thinks on the black-to-move position and its pick is played as black. */
  async function requestLayaBlackMove(position: GameSnapshot) {
    const requestId = ++requestIdRef.current;
    setConnectionState("thinking");
    console.log(
      "[trails] considering",
      position.legalMoves.length,
      "legal:",
      position.legalMoves.map((m) => m.id).join(" ")
    );
    // Reveal the pulsing considering lines only after the previous resolved
    // fade has cleared, so two move sets never overlap on the board.
    setConsideringVisible(false);
    clearConsideringTimer();
    consideringTimeoutRef.current = window.setTimeout(() => {
      if (requestIdRef.current === requestId) setConsideringVisible(true);
    }, 650);
    const hideConsidering = () => {
      clearConsideringTimer();
      setConsideringVisible(false);
    };
    try {
      const result = await decideMove(position.fen, position.legalMoves);
      if (requestIdRef.current !== requestId) return; // a newer move superseded this one
      hideConsidering();
      console.log("[laya] decision:", result.selectedCandidateId, result);
      console.log(
        "[trails] resolved:",
        buildResolvedTrails(result, position.legalMoves)
          .map((t) => `${t.from}${t.to}:${t.weight.toFixed(2)}`)
          .join(" ")
      );

      const positionMaterialEvals = evaluateCandidatesByMaterial(position.fen, position.legalMoves);
      const topByMaterial = positionMaterialEvals.find((m) => m.rank === 1);
      const agrees = result.selectedCandidateId === topByMaterial?.candidateId;
      setTally((t) => (agrees ? { ...t, agree: t.agree + 1 } : { ...t, disagree: t.disagree + 1 }));

      const pickId = result.selectedCandidateId;
      const picked = position.legalMoves.find((m) => m.id === pickId);
      if (!pickId || !picked) {
        console.error("[laya] selected move is not legal:", pickId, result);
        setDecision(result);
        setDecisionCandidates(position.legalMoves);
        setDecisionFen(position.fen);
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
        setDecisionCandidates(position.legalMoves);
        setDecisionFen(position.fen);
        setDecisionMaterialEvals(positionMaterialEvals);
        setConnectionState("connected");
        setErrorMessage((err as Error).message);
        return;
      }

      setSnapshot(after);
      {
        const piece = getPieceAt(position.fen, picked.from);
        if (piece) {
          setLastMove({
            from: picked.from,
            to: picked.to,
            pieceKey: `${piece.color}${piece.type}`,
            key: after.history.length,
          });
        }
      }
      // The move is played: lines and ghosts vanish together, immediately.
      // (Decision details stay in the console log + session tally.)
      setDecision(null);
      setDecisionCandidates(null);
      setDecisionFen(null);
      setDecisionMaterialEvals(null);
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
    if (fadeTimeoutRef.current !== null) window.clearTimeout(fadeTimeoutRef.current);
    setFadingTrails(null);
    clearConsideringTimer();
    setConsideringVisible(false);
    setLastMove(null);
    setSnapshot(startingSnapshot());
    setDecision(null);
    setDecisionCandidates(null);
    setDecisionFen(null);
    setDecisionMaterialEvals(null);
    setErrorMessage(null);
    setConnectionState((s) => (s === "thinking" ? "connected" : s));
    setTally({ agree: 0, disagree: 0 });
  }

  const bannerText = (() => {
    if (snapshot.isCheckmate) return `CHECKMATE — ${snapshot.turn === "w" ? "BLACK (LAYA)" : "WHITE (YOU)"} WINS`;
    if (snapshot.isStalemate) return "STALEMATE — DRAW";
    if (connectionState === "thinking") return "LAYA (BLACK) IS WEIGHING ITS REPLY_";
    if (connectionState === "unavailable") return "LAYA UNAVAILABLE — CHECK laya-serve IS RUNNING";
    if (connectionState === "timeout") return "LAYA TIMED OUT ON THAT REQUEST";
    if (connectionState === "invalid_response") return "LAYA REPLY DID NOT PARSE — SEE CONSOLE + layaClient.ts";
    if (snapshot.turn === "b") return "LAYA (BLACK) TO MOVE — WAIT FOR ITS REPLY.";
    return "YOUR MOVE. WHITE TO PLAY.";
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
            LOCAL — localhost:8000
          </span>
        </div>
      </header>

      <div className={`status-banner ${bannerClass}`}>{bannerText}</div>

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
              lastMove={lastMove}
              overlay={
                <>
                  {fadingTrails && fadingTrails.length > 0 && (
                    <MoveTrails moves={fadingTrails} mode="resolved" fading />
                  )}
                  {consideringTrails && consideringVisible && (
                    <MoveTrails moves={consideringTrails} mode="considering" />
                  )}
                  {resolvedTrails && !isThinking && (
                    <MoveTrails moves={resolvedTrails} mode="resolved" />
                  )}
                </>
              }
            />
            <div className="game-status">
              <span>material {snapshot.material.white}–{snapshot.material.black}</span>
              <span>{snapshot.history.length} ply</span>
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
            materialEvals={decisionMaterialEvals ?? materialEvals}
            connectionState={connectionState}
          />
          <SessionTally agree={tally.agree} disagree={tally.disagree} />
        </section>
      </main>
    </div>
  );
}
