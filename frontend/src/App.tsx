import { useEffect, useRef, useState } from "react";
import { Board } from "./components/Board";
import { CalibrationPanel } from "./components/CalibrationPanel";
import { SessionTally } from "./components/SessionTally";
import { EvalBar } from "./components/EvalBar";
import { applyMove, evaluateCandidatesByMaterial, startingSnapshot } from "./chess/engine";
import {
  LayaInvalidResponseError,
  LayaTimeoutError,
  checkHealth,
  decideMove,
} from "./api/layaClient";
import type { CandidateMove, GameSnapshot, LayaConnectionState, LayaDecisionResponse, MaterialEval } from "./types";

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
  // Guards out-of-order responses when the user moves twice quickly: only
  // the latest request may write decision/connection state.
  const requestIdRef = useRef(0);

  useEffect(() => {
    checkHealth().then(({ ok }) => setConnectionState(ok ? "connected" : "unavailable"));
  }, []);

  const materialEvals = evaluateCandidatesByMaterial(snapshot.fen, snapshot.legalMoves);

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
    setDecision(null);
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
    try {
      const result = await decideMove(position.fen, position.legalMoves);
      if (requestIdRef.current !== requestId) return; // a newer move superseded this one
      console.log("[laya] decision:", result.selectedCandidateId, result);

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
        setDecisionMaterialEvals(positionMaterialEvals);
        setConnectionState("connected");
        setErrorMessage((err as Error).message);
        return;
      }

      setSnapshot(after);
      setDecision(result);
      setDecisionCandidates(position.legalMoves);
      setDecisionMaterialEvals(positionMaterialEvals);
      setErrorMessage(null);
      setConnectionState("connected");
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
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
    setSnapshot(startingSnapshot());
    setDecision(null);
    setDecisionCandidates(null);
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
