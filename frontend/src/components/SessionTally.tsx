interface SessionTallyProps {
  agree: number;
  disagree: number;
  /** Decisions where every candidate tied on one-ply material, so nothing was scored. */
  noSignal: number;
}

/**
 * Your reference UI has a live human-vs-Jev scoreboard; this project is
 * solo, so the equivalent running number is how often Laya's pick is among
 * the best moves by the zero-AI one-ply material check. Positions where
 * every move ties are counted separately and kept out of the percentage:
 * the check cannot tell moves apart there, so it is neither a hit nor a miss.
 */
export function SessionTally({ agree, disagree, noSignal }: SessionTallyProps) {
  const total = agree + disagree;
  const pct = total > 0 ? Math.round((agree / total) * 100) : null;

  return (
    <div className="panel">
      <div className="panel-title">
        <span>SESSION TALLY</span>
      </div>
      <div className="tally">
        <div>
          <div className="tally-figure">{agree}</div>
          <div className="tally-label">agrees w/ material</div>
        </div>
        <div className="tally-vs">vs</div>
        <div>
          <div className="tally-figure bad">{disagree}</div>
          <div className="tally-label">disagrees</div>
        </div>
      </div>
      {pct !== null && (
        <p className="panel-note">
          {pct}% agreement over {total} decision{total === 1 ? "" : "s"} this session. Low and
          flat over many moves is a sign Laya's confidence isn't calibrated yet — see
          docs/PROJECT.md §14/§37.
        </p>
      )}
      {noSignal > 0 && (
        <p className="panel-note">
          {noSignal} decision{noSignal === 1 ? "" : "s"} not counted: every move tied on
          material, so the check had nothing to compare.
        </p>
      )}
    </div>
  );
}
