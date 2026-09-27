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
import type { CandidateMove, GameSnapshot, LayaConnectionState, LayaDecisionResponse } from "./types";

export default function App() {
  const [snapshot, setSnapshot] = useState<GameSnapshot>(() => startingSnapshot());
  const [connectionState, setConnectionState] = useState<LayaConnectionState>("idle");
  const [decision, setDecision] = useState<LayaDecisionResponse | null>(null);
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
    setErrorMessage(null);

    if (next.isGameOver || next.legalMoves.length === 0) return;

    const requestId = ++requestIdRef.current;
    setConnectionState("thinking");
    try {
      const result = await decideMove(next.fen, next.legalMoves);
      if (requestIdRef.current !== requestId) return; // a newer move superseded this one
      setDecision(result);
      setConnectionState("connected");

      const nextMaterialEvals = evaluateCandidatesByMaterial(next.fen, next.legalMoves);
      const topByMaterial = nextMaterialEvals.find((m) => m.rank === 1);
      const agrees = result.selectedCandidateId === topByMaterial?.candidateId;
      setTally((t) => (agrees ? { ...t, agree: t.agree + 1 } : { ...t, disagree: t.disagree + 1 }));
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
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

  function handleReset() {
    requestIdRef.current += 1; // invalidate any in-flight decision
    setSnapshot(startingSnapshot());
    setDecision(null);
    setErrorMessage(null);
    setConnectionState((s) => (s === "thinking" ? "connected" : s));
    setTally({ agree: 0, disagree: 0 });
  }

  const bannerText = (() => {
    if (snapshot.isCheckmate) return `CHECKMATE — ${snapshot.turn === "w" ? "BLACK" : "WHITE"} WINS`;
    if (snapshot.isStalemate) return "STALEMATE — DRAW";
    if (connectionState === "thinking") return "LAYA IS WEIGHING EVERY LEGAL REPLY_";
    if (connectionState === "unavailable") return "LAYA UNAVAILABLE — CHECK laya-serve IS RUNNING";
    if (connectionState === "timeout") return "LAYA TIMED OUT ON THAT REQUEST";
    if (connectionState === "invalid_response") return "LAYA REPLY DID NOT PARSE — SEE CONSOLE + layaClient.ts";
    return `YOUR MOVE. ${snapshot.turn === "w" ? "WHITE" : "BLACK"} TO PLAY.`;
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
            EVERY LEGAL MOVE IS A TAP ON A HIGHLIGHTED SQUARE. ILLEGAL MOVES DO NOT EXIST IN THIS
            UI. LAYA'S CONFIDENCE IS CHECKED AGAINST PLAIN ONE-PLY MATERIAL, LIVE.
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
            <Board fen={snapshot.fen} onMove={handleUserMove} disabled={snapshot.isGameOver} />
            <div className="game-status">
              <span>material {snapshot.material.white}–{snapshot.material.black}</span>
              <span>{snapshot.history.length} ply</span>
              <button onClick={handleReset}>RESET</button>
            </div>
            {errorMessage && <div className="error-banner">{errorMessage}</div>}
          </div>
        </div>

        <section className="side-panel">
          <CalibrationPanel
            candidates={snapshot.legalMoves}
            decision={decision}
            materialEvals={materialEvals}
            connectionState={connectionState}
          />
          <SessionTally agree={tally.agree} disagree={tally.disagree} />
        </section>
      </main>
    </div>
  );
}
