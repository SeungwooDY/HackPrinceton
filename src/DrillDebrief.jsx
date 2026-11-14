import React, { useEffect, useMemo, useRef, useState } from 'react';

// Post-drill replay + debrief. Shows the score and lets you replay either the
// trainee's recorded path ("your run") or the optimal route from /api/plan, by
// flying the camera sweep-to-sweep (the embed SDK can't draw a 3D line).

function dist(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function pathMeters(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += dist(points[i - 1].position, points[i].position);
  return m;
}
function dedupe(sweeps) {
  return sweeps.filter((sid, i) => sid && (i === 0 || sid !== sweeps[i - 1]));
}

export default function DrillDebrief({ sdk, modelId, score, maxScore, trail, plan: planProp, checkpoints, onClose }) {
  const noteFor = p => (p.feasible ? '' : (p.error || 'Optimal route unavailable.'));
  const [plan, setPlan] = useState(planProp || null);
  const [note, setNote] = useState(() => (planProp ? noteFor(planProp) : 'Loading optimal route…'));
  const [playing, setPlaying] = useState(null); // 'yours' | 'optimal' | null
  const cancel = useRef(false);

  // checkpoints[].title is the order-blind "Checkpoint N" label the trainee
  // actually saw as a 3D marker (see quizSource.js / ModelTags.jsx). Keyed by
  // source.taskId (the plain "q1"/"q2"/... id), NOT checkpoint.id -- parseTaskDocument
  // reassigns .id to a long composite dedup string, but plan.order from the
  // Python solver uses the plain id, so that's the key that actually matches.
  const checkpointsById = useMemo(
    () => new Map((checkpoints || []).map(c => [c.source?.taskId || c.id, c])),
    [checkpoints],
  );
  const labelFor = id => checkpointsById.get(id)?.title || id;

  // Your order: each checkpoint's first-arrival time at its own sweep, sorted.
  // Checkpoints never reached don't appear (there's nothing to order them by).
  const yourOrder = useMemo(() => {
    const firstVisit = new Map();
    for (const point of trail) {
      for (const [key, c] of checkpointsById) {
        if (point.sweepId === c.sweepId && !firstVisit.has(key)) firstVisit.set(key, point.t);
      }
    }
    return [...firstVisit.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }, [trail, checkpointsById]);

  const optimalOrder = plan?.feasible ? plan.order : null;

  useEffect(() => {
    if (planProp) { setPlan(planProp); setNote(noteFor(planProp)); return undefined; }
    let live = true;
    fetch(`/api/plan?model=${encodeURIComponent(modelId)}`)
      .then(r => r.json())
      .then(p => { if (!live) return; setPlan(p); setNote(noteFor(p)); })
      .catch(() => { if (live) setNote('Could not load the optimal route.'); });
    return () => { live = false; };
  }, [modelId, planProp]);

  const yourMeters = useMemo(() => pathMeters(trail), [trail]);
  const optimalMeters = plan?.feasible ? plan.totalMeters : null;
  const efficiency = optimalMeters && yourMeters ? Math.min(100, Math.round((100 * optimalMeters) / yourMeters)) : null;

  async function play(which) {
    if (playing) { cancel.current = true; return; }
    const path = which === 'optimal'
      ? dedupe((plan?.legs || []).flatMap(leg => leg.sweeps))
      : dedupe(trail.map(point => point.sweepId));
    if (!path.length || !sdk?.Sweep?.moveTo) return;
    cancel.current = false;
    setPlaying(which);
    const transition = sdk.Sweep.Transition?.FLY;
    try {
      for (const sid of path) {
        if (cancel.current) break;
        await sdk.Sweep.moveTo(sid, transition ? { transition, transitionTime: 900 } : { transitionTime: 900 });
      }
    } catch { /* a sweep may be unavailable; stop quietly */ }
    setPlaying(null);
  }

  return (
    <div className="debrief-overlay" role="dialog" aria-label="Drill debrief">
      <div className="debrief-card">
        <button className="debrief-close" onClick={onClose} aria-label="Close debrief">×</button>
        <h2>Drill complete</h2>
        <p className="debrief-score">Score <strong>{score}</strong> <span>/ {maxScore}</span></p>
        <dl className="debrief-stats">
          <div><dt>Your route</dt><dd>{yourMeters ? `${yourMeters.toFixed(1)} m` : '—'}</dd></div>
          <div><dt>Optimal route</dt><dd>{optimalMeters != null ? `${optimalMeters.toFixed(1)} m` : '—'}</dd></div>
          <div><dt>Efficiency</dt><dd>{efficiency != null ? `${efficiency}%` : '—'}</dd></div>
        </dl>
        {note && <p className="debrief-note">{note}</p>}
        {(yourOrder.length > 0 || optimalOrder) && (
          <div className="debrief-order">
            <div>
              <h3>Your order</h3>
              {yourOrder.length
                ? <ol><li className="debrief-start">Start (entrance)</li>{yourOrder.map(id => <li key={id}>{labelFor(id)}</li>)}</ol>
                : <p className="debrief-note">No checkpoints reached.</p>}
            </div>
            <div>
              <h3>Optimal order</h3>
              {optimalOrder
                ? <ol><li className="debrief-start">Start (entrance)</li>{optimalOrder.map(id => <li key={id}>{labelFor(id)}</li>)}</ol>
                : <p className="debrief-note">Not available for this drill.</p>}
            </div>
          </div>
        )}
        <div className="debrief-actions">
          <button disabled={!trail.length} onClick={() => play('yours')}>{playing === 'yours' ? 'Stop' : 'Replay your run'}</button>
          <button disabled={!plan?.feasible} onClick={() => play('optimal')}>{playing === 'optimal' ? 'Stop' : 'Replay optimal'}</button>
        </div>
      </div>
    </div>
  );
}
